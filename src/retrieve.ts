import fs from 'fs';
import { DocumentRecord, TreeNode } from './types';
import { removeFields } from './utils';
import type pdfParse from 'pdf-parse';

// Lazy loader — keeps module evaluation free of require('pdf-parse').
let _pdfParse: typeof pdfParse | null = null;
function lazyPdfParse(): typeof pdfParse {
  if (!_pdfParse) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('pdf-parse');
    _pdfParse = (mod.default ?? mod) as typeof pdfParse;
  }
  return _pdfParse!;
}

// ── Page parsing ───────────────────────────────────────────────────────────────

function parsePages(pages: string): number[] {
  const result: number[] = [];
  for (const part of pages.split(',')) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-', 2);
      const start = parseInt(startStr.trim(), 10);
      const end = parseInt(endStr.trim(), 10);
      if (start > end) throw new Error(`Invalid range '${trimmed}': start must be <= end`);
      for (let i = start; i <= end; i++) result.push(i);
    } else {
      result.push(parseInt(trimmed, 10));
    }
  }
  return [...new Set(result)].sort((a, b) => a - b);
}

// ── PDF page extraction ────────────────────────────────────────────────────────

async function getPdfPageContent(
  doc: DocumentRecord,
  pageNums: number[],
): Promise<Array<{ page: number; content: string }>> {
  if (doc.pages) {
    const pageMap = new Map(doc.pages.map((p) => [p.page, p.content]));
    return pageNums
      .filter((p) => pageMap.has(p))
      .map((p) => ({ page: p, content: pageMap.get(p)! }));
  }

  // Fallback: read from disk
  const buffer = fs.readFileSync(doc.path);
  const pageTexts: string[] = [];

  await lazyPdfParse()(buffer, {
    pagerender: (pageData: { getTextContent: () => Promise<{ items: Array<{ str: string; transform: number[] }> }> }) => {
      return pageData.getTextContent().then((c) => {
        let lastY: number | undefined;
        let text = '';
        for (const item of c.items) {
          if (lastY !== undefined && Math.abs(item.transform[5] - lastY) > 5) text += '\n';
          text += item.str;
          lastY = item.transform[5];
        }
        pageTexts.push(text);
        return text;
      });
    },
  });

  const total = pageTexts.length;
  return pageNums
    .filter((p) => p >= 1 && p <= total)
    .map((p) => ({ page: p, content: pageTexts[p - 1] }));
}

// ── Markdown line extraction ───────────────────────────────────────────────────

function getMdPageContent(
  doc: DocumentRecord,
  pageNums: number[],
): Array<{ page: number; content: string }> {
  const minLine = Math.min(...pageNums);
  const maxLine = Math.max(...pageNums);
  const results: Array<{ page: number; content: string }> = [];
  const seen = new Set<number>();

  function traverse(nodes: TreeNode[]): void {
    for (const node of nodes) {
      const ln = node.line_num;
      if (ln !== undefined && ln >= minLine && ln <= maxLine && !seen.has(ln)) {
        seen.add(ln);
        results.push({ page: ln, content: (node.text as string) ?? '' });
      }
      if (node.nodes) traverse(node.nodes);
    }
  }

  traverse(doc.structure ?? []);
  return results.sort((a, b) => a.page - b.page);
}

// ── Tool functions ─────────────────────────────────────────────────────────────

export function getDocument(documents: Map<string, DocumentRecord>, docId: string): string {
  const doc = documents.get(docId);
  if (!doc) return JSON.stringify({ error: `Document ${docId} not found` });

  const result: Record<string, unknown> = {
    doc_id: docId,
    doc_name: doc.doc_name,
    doc_description: doc.doc_description ?? '',
    type: doc.type,
    status: 'completed',
  };

  if (doc.type === 'pdf') {
    result.page_count = doc.page_count ?? doc.pages?.length ?? 0;
  } else {
    result.line_count = doc.line_count ?? 0;
  }

  return JSON.stringify(result);
}

export function getDocumentStructure(documents: Map<string, DocumentRecord>, docId: string): string {
  const doc = documents.get(docId);
  if (!doc) return JSON.stringify({ error: `Document ${docId} not found` });

  const structureNoText = removeFields(doc.structure ?? [], ['text']);
  return JSON.stringify(structureNoText, null, 2);
}

export async function getPageContent(
  documents: Map<string, DocumentRecord>,
  docId: string,
  pages: string,
): Promise<string> {
  const doc = documents.get(docId);
  if (!doc) return JSON.stringify({ error: `Document ${docId} not found` });

  let pageNums: number[];
  try {
    pageNums = parsePages(pages);
  } catch (e) {
    return JSON.stringify({ error: `Invalid pages format: '${pages}'. Use "5-7", "3,8", or "12". Error: ${e}` });
  }

  try {
    const content =
      doc.type === 'pdf'
        ? await getPdfPageContent(doc, pageNums)
        : getMdPageContent(doc, pageNums);
    return JSON.stringify(content, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `Failed to read page content: ${e}` });
  }
}
