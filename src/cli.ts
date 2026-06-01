#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { pageIndex } from './pageIndex';
import { mdToTree } from './pageIndexMd';
import { loadConfig, DEFAULT_CONFIG } from './config';
import { QueryEngine } from './query-engine';
import { PageIndexClient } from './client';

const QUEUE_FILE = 'queue.json';
interface IndexQueue { pending: string[]; done: string[] }

const MD_EXTENSIONS = new Set(['.md', '.markdown']);
const OBSIDIAN_SKIP_DIRS = new Set(['.obsidian', '.trash', 'node_modules']);

function printUsage(): void {
  console.log(`
Usage:
  pageindex-rag query "<question>"            Query an indexed vault
  pageindex-rag query "<question>" --vault <dir>
  pageindex-rag query "<question>" --vault <dir> --model <model>

  pageindex-rag --vault <dir>                 Index all Markdown files in a folder (one shot)
  pageindex-rag --queue-only --vault <dir>    Build queue file, no LLM calls (run once to set up)
  pageindex-rag --from-queue --vault <dir>    Process next batch from queue (run each session)
  pageindex-rag --pdf   <file>                Index a PDF
  pageindex-rag --md    <file>                Index a Markdown file

Options:
  --vault <dir>             Vault directory
  --model <model>           LLM model (default: ${DEFAULT_CONFIG.model})
  --limit <n>               Files per session for --from-queue (default: 10)
  --no-summary              Skip node summary generation
  --add-description         Generate a document description
  --add-text                Include raw text in output nodes
  --output <path>           Output JSON path (single file only)
  --help                    Show this help
`);
}

function collectMdFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!OBSIDIAN_SKIP_DIRS.has(entry.name)) {
        results.push(...collectMdFiles(path.join(dir, entry.name)));
      }
    } else if (MD_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

async function runQuery(args: string[]): Promise<void> {
  const question = args[1];
  if (!question || question.startsWith('--')) {
    console.error('Error: query requires a question string.\n  pageindex-rag query "your question"');
    process.exit(1);
  }

  const vaultIdx = args.indexOf('--vault');
  const modelIdx = args.indexOf('--model');
  const vaultDir = vaultIdx !== -1 ? args[vaultIdx + 1] : process.cwd();
  const model    = modelIdx !== -1 ? args[modelIdx + 1] : undefined;

  if (!fs.existsSync(path.resolve(vaultDir))) {
    console.error(`Error: vault directory not found: ${vaultDir}`);
    process.exit(1);
  }

  const engine = new QueryEngine({ vaultDir, ...(model ? { model } : {}) });
  console.log(`\nQuery: ${question}`);
  console.log(`Vault: ${path.resolve(vaultDir)}\n`);

  const result = await engine.query(question);

  console.log('─'.repeat(60));
  console.log(result.answer);

  if (result.sources.length > 0) {
    console.log('\nSources:');
    for (const s of result.sources) {
      console.log(`  • ${s.docName} (pages/lines: ${s.pages})`);
    }
  }
  console.log('─'.repeat(60));
}

function readQueue(queuePath: string): IndexQueue {
  if (!fs.existsSync(queuePath)) return { pending: [], done: [] };
  try { return JSON.parse(fs.readFileSync(queuePath, 'utf-8')) as IndexQueue; }
  catch { return { pending: [], done: [] }; }
}

function writeQueue(queuePath: string, queue: IndexQueue): void {
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf-8');
}

async function buildQueue(vaultDir: string): Promise<void> {
  const resolvedVault = path.resolve(vaultDir);
  if (!fs.existsSync(resolvedVault)) {
    console.error(`Vault not found: ${resolvedVault}`);
    process.exit(1);
  }

  const workspace = path.join(resolvedVault, '.pageindex');
  fs.mkdirSync(workspace, { recursive: true });

  const queuePath = path.join(workspace, QUEUE_FILE);
  const metaPath  = path.join(workspace, '_meta.json');

  // Already-indexed files (from PageIndexClient workspace)
  const alreadyDone = new Set<string>();
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, { path: string }>;
    for (const doc of Object.values(meta)) {
      alreadyDone.add(path.relative(resolvedVault, doc.path));
    }
  }

  // Carry over any existing queue done list
  const existing = readQueue(queuePath);
  for (const f of existing.done) alreadyDone.add(f);

  const allFiles = collectMdFiles(resolvedVault).map(f => path.relative(resolvedVault, f));
  const pending  = allFiles.filter(f => !alreadyDone.has(f));

  const queue: IndexQueue = { pending, done: [...alreadyDone] };
  writeQueue(queuePath, queue);

  console.log(`\nQueue built in: ${queuePath}`);
  console.log(`  ${pending.length} files to index`);
  console.log(`  ${alreadyDone.size} already done`);
  if (pending.length > 0) {
    console.log(`\nNext step:`);
    console.log(`  pageindex-rag --from-queue --vault ${vaultDir} --model claude-code`);
  } else {
    console.log(`\nVault fully indexed!`);
  }
}

async function processQueue(vaultDir: string, model: string, limit: number): Promise<void> {
  const resolvedVault = path.resolve(vaultDir);
  const workspace  = path.join(resolvedVault, '.pageindex');
  const queuePath  = path.join(workspace, QUEUE_FILE);

  if (!fs.existsSync(queuePath)) {
    console.log('No queue found. Run first: pageindex-rag --queue-only --vault ' + vaultDir);
    process.exit(1);
  }

  const queue = readQueue(queuePath);

  if (queue.pending.length === 0) {
    console.log('Queue is empty — vault fully indexed!');
    return;
  }

  const batch = queue.pending.slice(0, limit);
  const total = queue.pending.length;
  console.log(`\nProcessing ${batch.length} of ${total} pending files (model: ${model})...\n`);

  const client = new PageIndexClient({ model, workspace });

  for (let i = 0; i < batch.length; i++) {
    const rel      = batch[i];
    const fullPath = path.join(resolvedVault, rel);
    process.stdout.write(`[${i + 1}/${batch.length}] ${rel} ... `);
    try {
      await client.index(fullPath, 'md');
      queue.pending = queue.pending.filter(f => f !== rel);
      queue.done.push(rel);
      writeQueue(queuePath, queue);
      console.log('done');
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
    }
  }

  const remaining  = queue.pending.length;
  const doneCount  = total - remaining;
  console.log(`\n${doneCount} indexed this session. ${remaining > 0 ? `${remaining} remaining — run again next session.` : 'Vault fully indexed!'}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  if (args[0] === 'query') {
    await runQuery(args);
    return;
  }

  if (args.includes('--queue-only')) {
    const vaultIdx = args.indexOf('--vault');
    const vaultDir = vaultIdx !== -1 ? args[vaultIdx + 1] : process.cwd();
    await buildQueue(vaultDir);
    return;
  }

  if (args.includes('--from-queue')) {
    const vaultIdx = args.indexOf('--vault');
    const modelIdx = args.indexOf('--model');
    const limitIdx = args.indexOf('--limit');
    const vaultDir = vaultIdx !== -1 ? args[vaultIdx + 1] : process.cwd();
    const model    = modelIdx !== -1 ? args[modelIdx + 1] : loadConfig().model;
    const limit    = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10;
    await processQueue(vaultDir, model, limit);
    return;
  }

  const pdfIdx   = args.indexOf('--pdf');
  const mdIdx    = args.indexOf('--md');
  const vaultIdx = args.indexOf('--vault');
  const modelIdx = args.indexOf('--model');
  const outputIdx = args.indexOf('--output');

  const model          = modelIdx  !== -1 ? args[modelIdx  + 1] : loadConfig().model;
  const ifAddSummary   = !args.includes('--no-summary');
  const ifAddDescription = args.includes('--add-description');
  const ifAddText      = args.includes('--add-text');

  // ── Vault mode ────────────────────────────────────────────────────────────────
  if (vaultIdx !== -1) {
    const vaultPath = path.resolve(args[vaultIdx + 1] ?? '');
    if (!vaultPath || !fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
      console.error('Error: --vault requires a valid directory path.');
      process.exit(1);
    }

    const mdFiles = collectMdFiles(vaultPath);
    if (mdFiles.length === 0) {
      console.error(`No Markdown files found in: ${vaultPath}`);
      process.exit(1);
    }

    const vaultName = path.basename(vaultPath);
    const outputDir = path.join('results', vaultName);
    fs.mkdirSync(outputDir, { recursive: true });

    console.log(`\nVault: ${vaultPath}`);
    console.log(`Found ${mdFiles.length} Markdown file(s). Indexing...\n`);

    const index: Array<{ file: string; output: string; doc_name: string }> = [];
    let done = 0;

    for (const filePath of mdFiles) {
      const rel = path.relative(vaultPath, filePath);
      const baseName = rel.replace(/[\\/]/g, '_').replace(/\.(md|markdown)$/i, '');
      const outputPath = path.join(outputDir, `${baseName}_structure.json`);

      process.stdout.write(`[${++done}/${mdFiles.length}] ${rel} ... `);
      try {
        const result = await mdToTree(filePath, {
          model,
          ifAddNodeSummary: ifAddSummary,
          ifAddDocDescription: ifAddDescription,
          ifAddNodeText: ifAddText,
        });
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
        index.push({ file: rel, output: outputPath, doc_name: result.doc_name });
        console.log('done');
      } catch (err) {
        console.log(`FAILED: ${(err as Error).message}`);
      }
    }

    const indexPath = path.join(outputDir, '_index.json');
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
    console.log(`\nIndexed ${index.length}/${mdFiles.length} file(s).`);
    console.log(`Results: ${outputDir}`);
    console.log(`Index:   ${indexPath}`);
    return;
  }

  // ── Single file mode ──────────────────────────────────────────────────────────
  const filePath = pdfIdx !== -1 ? args[pdfIdx + 1] : mdIdx !== -1 ? args[mdIdx + 1] : null;
  const mode = pdfIdx !== -1 ? 'pdf' : 'md';

  if (!filePath) {
    console.error('Error: specify --pdf, --md, or --vault.');
    printUsage();
    process.exit(1);
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    process.exit(1);
  }

  const baseName = path.basename(resolvedPath, path.extname(resolvedPath));
  const defaultOutput = path.join('results', `${baseName}_structure.json`);
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : defaultOutput;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  let result: unknown;

  if (mode === 'pdf') {
    result = await pageIndex(resolvedPath, {
      model,
      ifAddNodeSummary: ifAddSummary,
      ifAddDocDescription: ifAddDescription,
      ifAddNodeText: ifAddText,
    });
  } else {
    result = await mdToTree(resolvedPath, {
      model,
      ifAddNodeSummary: ifAddSummary,
      ifAddDocDescription: ifAddDescription,
      ifAddNodeText: ifAddText,
    });
  }

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\nOutput saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
