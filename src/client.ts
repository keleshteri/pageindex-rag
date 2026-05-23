import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DocumentRecord, PageIndexConfig } from './types';
import { loadConfig } from './config';
import { pageIndex } from './pageIndex';
import { mdToTree } from './pageIndexMd';
import { getDocument, getDocumentStructure, getPageContent } from './retrieve';
import { removeFields } from './utils';

const META_INDEX = '_meta.json';
const MD_EXTENSIONS = new Set(['.md', '.markdown']);
const VAULT_SKIP_DIRS = new Set(['.obsidian', '.trash', 'node_modules']);

function collectMdFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!VAULT_SKIP_DIRS.has(entry.name)) {
        results.push(...collectMdFiles(path.join(dir, entry.name)));
      }
    } else if (MD_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

export interface PageIndexClientOptions {
  model?: string;
  retrieveModel?: string;
  workspace?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

export class PageIndexClient {
  private config: PageIndexConfig;
  private workspace: string | null;
  private documents: Map<string, DocumentRecord> = new Map();

  constructor(options: PageIndexClientOptions = {}) {
    if (options.anthropicApiKey) process.env.ANTHROPIC_API_KEY = options.anthropicApiKey;
    if (options.openaiApiKey) process.env.OPENAI_API_KEY = options.openaiApiKey;

    const overrides: Partial<PageIndexConfig> = {};
    if (options.model) overrides.model = options.model;
    if (options.retrieveModel) overrides.retrieve_model = options.retrieveModel;

    this.config = loadConfig(overrides);
    this.workspace = options.workspace ? path.resolve(options.workspace) : null;

    if (this.workspace) {
      fs.mkdirSync(this.workspace, { recursive: true });
      this.loadWorkspace();
    }
  }

  async index(filePath: string, mode: 'auto' | 'pdf' | 'md' = 'auto'): Promise<string> {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${resolvedPath}`);
    }

    const docId = uuidv4();
    const ext = path.extname(resolvedPath).toLowerCase();
    const isPdf = ext === '.pdf';
    const isMd = ext === '.md' || ext === '.markdown';

    if (mode === 'pdf' || (mode === 'auto' && isPdf)) {
      console.log(`[PageIndexClient] Indexing PDF: ${resolvedPath}`);
      const result = await pageIndex(resolvedPath, {
        model: this.config.model,
        tocCheckPageNum: this.config.toc_check_page_num,
        maxPagesPerNode: this.config.max_page_num_each_node,
        maxTokensPerNode: this.config.max_token_num_each_node,
        ifAddNodeId: this.config.if_add_node_id === 'yes',
        ifAddNodeSummary: this.config.if_add_node_summary === 'yes',
        ifAddDocDescription: this.config.if_add_doc_description === 'yes',
        ifAddNodeText: true,
      });

      // Cache per-page content from structure nodes
      const pages: Array<{ page: number; content: string }> = [];
      function collectPages(nodes: typeof result.structure): void {
        for (const node of nodes) {
          if (node.start_index !== undefined && node.end_index !== undefined && node.text) {
            for (let p = node.start_index; p <= node.end_index; p++) {
              if (!pages.find((pg) => pg.page === p)) {
                pages.push({ page: p, content: node.text ?? '' });
              }
            }
          }
          if (node.nodes) collectPages(node.nodes);
        }
      }
      collectPages(result.structure);

      const doc: DocumentRecord = {
        id: docId,
        type: 'pdf',
        path: resolvedPath,
        doc_name: result.doc_name,
        doc_description: result.doc_description,
        page_count: pages.length,
        structure: result.structure,
        pages,
      };
      this.documents.set(docId, doc);

    } else if (mode === 'md' || (mode === 'auto' && isMd)) {
      console.log(`[PageIndexClient] Indexing Markdown: ${resolvedPath}`);
      const result = await mdToTree(resolvedPath, {
        model: this.config.model,
        ifAddNodeSummary: this.config.if_add_node_summary === 'yes',
        ifAddDocDescription: this.config.if_add_doc_description === 'yes',
        ifAddNodeId: this.config.if_add_node_id === 'yes',
        ifAddNodeText: true,
      });

      const doc: DocumentRecord = {
        id: docId,
        type: 'md',
        path: resolvedPath,
        doc_name: result.doc_name,
        doc_description: result.doc_description,
        line_count: result.line_count,
        structure: result.structure,
      };
      this.documents.set(docId, doc);

    } else {
      throw new Error(`Unsupported file format: ${resolvedPath}`);
    }

    console.log(`[PageIndexClient] Indexing complete. Document ID: ${docId}`);

    if (this.workspace) {
      this.saveDoc(docId);
    }

    return docId;
  }

  getDocument(docId: string): string {
    return getDocument(this.documents, docId);
  }

  getDocumentStructure(docId: string): string {
    if (this.workspace) this.ensureDocLoaded(docId);
    return getDocumentStructure(this.documents, docId);
  }

  async getPageContent(docId: string, pages: string): Promise<string> {
    if (this.workspace) this.ensureDocLoaded(docId);
    return getPageContent(this.documents, docId, pages);
  }

  listDocuments(): Array<{ id: string; doc_name: string; type: string; path: string }> {
    return [...this.documents.entries()].map(([id, doc]) => ({
      id,
      doc_name: doc.doc_name,
      type: doc.type,
      path: doc.path,
    }));
  }

  async indexVault(
    vaultDir: string,
    options: { concurrency?: number } = {},
  ): Promise<Array<{ docId: string; file: string; error?: string }>> {
    const { concurrency = 3 } = options;
    const resolvedDir = path.resolve(vaultDir);

    if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
      throw new Error(`Vault directory not found: ${resolvedDir}`);
    }

    const mdFiles = collectMdFiles(resolvedDir);
    console.log(`[PageIndexClient] Vault: ${resolvedDir} — ${mdFiles.length} file(s) found.`);

    const results: Array<{ docId: string; file: string; error?: string }> = [];
    let done = 0;

    // Process in batches to limit concurrent LLM calls
    for (let i = 0; i < mdFiles.length; i += concurrency) {
      const batch = mdFiles.slice(i, i + concurrency);
      const settled = await Promise.allSettled(batch.map((f) => this.index(f, 'md')));

      for (let j = 0; j < batch.length; j++) {
        const rel = path.relative(resolvedDir, batch[j]);
        const outcome = settled[j];
        if (outcome.status === 'fulfilled') {
          results.push({ docId: outcome.value, file: rel });
        } else {
          results.push({ docId: '', file: rel, error: (outcome.reason as Error).message });
          console.warn(`[PageIndexClient] Skipped "${rel}": ${(outcome.reason as Error).message}`);
        }
        console.log(`[PageIndexClient] [${++done}/${mdFiles.length}] ${rel}`);
      }
    }

    return results;
  }

  // ── Workspace persistence ────────────────────────────────────────────────────

  private saveDoc(docId: string): void {
    const doc = this.documents.get(docId);
    if (!doc || !this.workspace) return;

    const toSave = { ...doc };
    if (toSave.type === 'pdf') {
      toSave.structure = removeFields(toSave.structure ?? [], ['text']) as typeof toSave.structure;
    }

    const docPath = path.join(this.workspace, `${docId}.json`);
    fs.writeFileSync(docPath, JSON.stringify(toSave, null, 2), 'utf-8');
    this.saveMeta(docId, this.makeMetaEntry(doc));

    // Drop heavy fields from memory; lazy-load on demand
    const inMemory = this.documents.get(docId)!;
    delete inMemory.structure;
    delete inMemory.pages;
  }

  private makeMetaEntry(doc: DocumentRecord): Partial<DocumentRecord> {
    return {
      type: doc.type,
      doc_name: doc.doc_name,
      doc_description: doc.doc_description,
      path: doc.path,
      page_count: doc.page_count,
      line_count: doc.line_count,
    };
  }

  private saveMeta(docId: string, entry: Partial<DocumentRecord>): void {
    const metaPath = path.join(this.workspace!, META_INDEX);
    const meta = this.readMeta() ?? {};
    meta[docId] = entry as DocumentRecord;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }

  private readMeta(): Record<string, DocumentRecord> | null {
    const metaPath = path.join(this.workspace!, META_INDEX);
    if (!fs.existsSync(metaPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  private loadWorkspace(): void {
    const meta = this.readMeta();
    if (!meta) return;

    for (const [docId, entry] of Object.entries(meta)) {
      this.documents.set(docId, { ...entry, id: docId });
    }

    console.log(`[PageIndexClient] Loaded ${this.documents.size} document(s) from workspace.`);
  }

  private ensureDocLoaded(docId: string): void {
    const doc = this.documents.get(docId);
    if (!doc || doc.structure !== undefined) return;

    const docPath = path.join(this.workspace!, `${docId}.json`);
    if (!fs.existsSync(docPath)) return;

    try {
      const full = JSON.parse(fs.readFileSync(docPath, 'utf-8')) as DocumentRecord;
      doc.structure = full.structure ?? [];
      if (full.pages) doc.pages = full.pages;
    } catch {
      console.warn(`[PageIndexClient] Failed to load document ${docId} from disk.`);
    }
  }
}
