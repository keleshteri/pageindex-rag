import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import { getEncoding } from 'js-tiktoken';
import { TreeNode, TocEntry } from './types';
import { llmCompletion } from './llm';

// ── Token counting ─────────────────────────────────────────────────────────────

let _enc: ReturnType<typeof getEncoding> | null = null;
function enc() {
  if (!_enc) _enc = getEncoding('cl100k_base');
  return _enc;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return enc().encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

// ── JSON extraction ────────────────────────────────────────────────────────────

export function extractJson<T = unknown>(content: string): T {
  let jsonContent = content;

  const jsonFenceIdx = content.indexOf('```json');
  if (jsonFenceIdx !== -1) {
    const start = jsonFenceIdx + 7;
    const end = content.lastIndexOf('```');
    jsonContent = end > start ? content.slice(start, end) : content.slice(start);
  }

  jsonContent = jsonContent
    .trim()
    .replace(/\bNone\b/g, 'null')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false');

  try {
    return JSON.parse(jsonContent) as T;
  } catch {
    // Remove trailing commas and retry
    const cleaned = jsonContent.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(cleaned) as T;
    } catch (e) {
      console.error('Failed to parse JSON:', e, '\nContent:', jsonContent.slice(0, 300));
      return {} as T;
    }
  }
}

// ── PDF utilities ──────────────────────────────────────────────────────────────

export interface PageData {
  text: string;
  tokens: number;
}

export async function getPdfPages(filePath: string): Promise<PageData[]> {
  const buffer = fs.readFileSync(filePath);
  const pages: PageData[] = [];

  // pdf-parse renders all pages at once; we need per-page data
  // We use a custom page render callback to collect per-page text
  const pageTexts: string[] = [];

  await pdfParse(buffer, {
    pagerender: (pageData: { getTextContent: () => Promise<{ items: Array<{ str: string; transform: number[] }> }> }) => {
      return pageData.getTextContent().then((content) => {
        let lastY: number | undefined;
        let text = '';
        for (const item of content.items) {
          if (lastY !== undefined && Math.abs(item.transform[5] - lastY) > 5) {
            text += '\n';
          }
          text += item.str;
          lastY = item.transform[5];
        }
        pageTexts.push(text);
        return text;
      });
    },
  });

  for (const text of pageTexts) {
    pages.push({ text, tokens: countTokens(text) });
  }

  return pages;
}

export function getPdfTitle(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

export function getTextOfPages(
  pages: PageData[],
  startPage: number,
  endPage: number,
  tag = true,
): string {
  let text = '';
  for (let i = startPage - 1; i < endPage && i < pages.length; i++) {
    const pageNum = i + 1;
    text += tag
      ? `<physical_index_${pageNum}>\n${pages[i].text}\n<physical_index_${pageNum}>\n\n`
      : pages[i].text;
  }
  return text;
}

// ── Tree utilities ─────────────────────────────────────────────────────────────

export function writeNodeIds(data: TreeNode | TreeNode[], nodeId = 0): number {
  if (Array.isArray(data)) {
    for (const item of data) {
      nodeId = writeNodeIds(item, nodeId);
    }
  } else if (data && typeof data === 'object') {
    data.node_id = String(nodeId).padStart(4, '0');
    nodeId += 1;
    if (data.nodes) {
      nodeId = writeNodeIds(data.nodes, nodeId);
    }
  }
  return nodeId;
}

export function structureToList(structure: TreeNode | TreeNode[]): TreeNode[] {
  if (Array.isArray(structure)) {
    return structure.flatMap(structureToList);
  }
  if (structure && typeof structure === 'object') {
    const nodes: TreeNode[] = [structure];
    if (structure.nodes) {
      nodes.push(...structureToList(structure.nodes));
    }
    return nodes;
  }
  return [];
}

export function removeFields(
  data: unknown,
  fields: string[] = ['text'],
): unknown {
  if (Array.isArray(data)) {
    return data.map((item) => removeFields(item, fields));
  }
  if (data && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (!fields.includes(k)) {
        result[k] = removeFields(v, fields);
      }
    }
    return result;
  }
  return data;
}

// ── TOC list-to-tree conversion ────────────────────────────────────────────────

export function listToTree(data: TocEntry[]): TreeNode[] {
  const nodes: Record<string, TreeNode> = {};
  const rootNodes: TreeNode[] = [];

  for (const item of data) {
    const structure = item.structure;
    const node: TreeNode = {
      title: item.title,
      start_index: item.start_index ?? item.physical_index ?? undefined,
      end_index: item.end_index ?? undefined,
      nodes: [],
    };
    nodes[structure] = node;

    const parts = String(structure).split('.');
    const parentStructure = parts.length > 1 ? parts.slice(0, -1).join('.') : null;

    if (parentStructure && nodes[parentStructure]) {
      nodes[parentStructure].nodes!.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  function cleanNode(node: TreeNode): TreeNode {
    if (!node.nodes || node.nodes.length === 0) {
      delete node.nodes;
    } else {
      node.nodes = node.nodes.map(cleanNode);
    }
    return node;
  }

  return rootNodes.map(cleanNode);
}

// ── Page group chunking ────────────────────────────────────────────────────────

export function pageListToGroupText(
  pageContents: string[],
  tokenLengths: number[],
  maxTokens = 20000,
  overlapPage = 1,
): string[] {
  const numTokens = tokenLengths.reduce((a, b) => a + b, 0);

  if (numTokens <= maxTokens) {
    return [pageContents.join('')];
  }

  const subsets: string[] = [];
  let currentSubset: string[] = [];
  let currentTokenCount = 0;

  const expectedParts = Math.ceil(numTokens / maxTokens);
  const averageTokensPerPart = Math.ceil(((numTokens / expectedParts) + maxTokens) / 2);

  for (let i = 0; i < pageContents.length; i++) {
    const pageTokens = tokenLengths[i];

    if (currentTokenCount + pageTokens > averageTokensPerPart) {
      subsets.push(currentSubset.join(''));
      const overlapStart = Math.max(i - overlapPage, 0);
      currentSubset = pageContents.slice(overlapStart, i);
      currentTokenCount = tokenLengths.slice(overlapStart, i).reduce((a, b) => a + b, 0);
    }

    currentSubset.push(pageContents[i]);
    currentTokenCount += pageTokens;
  }

  if (currentSubset.length > 0) {
    subsets.push(currentSubset.join(''));
  }

  return subsets;
}

// ── Post-processing ────────────────────────────────────────────────────────────

export function convertPhysicalIndexToInt(data: TocEntry[]): TocEntry[] {
  for (const item of data) {
    if (item.physical_index !== undefined && typeof item.physical_index === 'string') {
      const str = item.physical_index as string;
      const match = str.match(/\d+/);
      item.physical_index = match ? parseInt(match[0], 10) : null;
    }
  }
  return data;
}

export function postProcessing(structure: TocEntry[], endPhysicalIndex: number): TreeNode[] {
  for (let i = 0; i < structure.length; i++) {
    structure[i].start_index = structure[i].physical_index ?? undefined;
    if (i < structure.length - 1) {
      const next = structure[i + 1];
      structure[i].end_index = next.appear_start === 'yes'
        ? (next.physical_index ?? 1) - 1
        : next.physical_index ?? undefined;
    } else {
      structure[i].end_index = endPhysicalIndex;
    }
  }
  return listToTree(structure);
}

// ── Node text attachment ───────────────────────────────────────────────────────

export function addNodeText(node: TreeNode | TreeNode[], pages: PageData[]): void {
  if (Array.isArray(node)) {
    node.forEach((n) => addNodeText(n, pages));
    return;
  }
  const start = node.start_index;
  const end = node.end_index;
  if (start !== undefined && end !== undefined) {
    node.text = pages.slice(start - 1, end).map((p) => p.text).join('');
  }
  if (node.nodes) addNodeText(node.nodes, pages);
}

// ── Summary generation ─────────────────────────────────────────────────────────

export async function generateNodeSummary(node: TreeNode, model: string): Promise<string> {
  const prompt = `You are given a part of a document, your task is to generate a description of the partial document about what are main points covered in the partial document.

Partial Document Text: ${node.text}

Directly return the description, do not include any other text.`;

  return llmCompletion(model, prompt) as Promise<string>;
}

export async function generateSummariesForStructure(
  structure: TreeNode[],
  model: string,
): Promise<TreeNode[]> {
  const nodes = structureToList(structure);
  const summaries = await Promise.all(nodes.map((n) => generateNodeSummary(n, model)));
  nodes.forEach((node, i) => {
    node.summary = summaries[i];
  });
  return structure;
}

export async function generateDocDescription(structure: TreeNode[], model: string): Promise<string> {
  const prompt = `You are an expert in generating descriptions for a document.
You are given a structure of a document. Your task is to generate a one-sentence description for the document, which makes it easy to distinguish the document from other documents.

Document Structure: ${JSON.stringify(removeFields(structure, ['text', 'summary']), null, 2)}

Directly return the description, do not include any other text.`;

  return llmCompletion(model, prompt) as Promise<string>;
}
