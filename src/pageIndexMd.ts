import fs from 'fs';
import path from 'path';
import { TreeNode, MdIndexResult } from './types';
import { llmCompletion } from './llm';
import {
  countTokens,
  structureToList,
  writeNodeIds,
  generateDocDescription,
} from './utils';

interface MdNode {
  title: string;
  line_num: number;
  level: number;
  text?: string;
  tokens?: number;
  summary?: string;
  prefix_summary?: string;
  nodes?: MdNode[];
  node_id?: string;
  [key: string]: unknown;
}

// ── Markdown parsing ───────────────────────────────────────────────────────────

function extractNodesFromMarkdown(content: string): { nodes: Array<{ title: string; line_num: number }>; lines: string[] } {
  const lines = content.split('\n');
  const nodes: Array<{ title: string; line_num: number }> = [];
  let inCodeBlock = false;

  lines.forEach((line, i) => {
    const stripped = line.trim();
    if (/^```/.test(stripped)) {
      inCodeBlock = !inCodeBlock;
      return;
    }
    if (!stripped || inCodeBlock) return;

    const match = /^(#{1,6})\s+(.+)$/.exec(stripped);
    if (match) {
      nodes.push({ title: match[2].trim(), line_num: i + 1 });
    }
  });

  return { nodes, lines };
}

function buildNodeList(rawNodes: Array<{ title: string; line_num: number }>, lines: string[]): MdNode[] {
  const allNodes: MdNode[] = [];

  for (const raw of rawNodes) {
    const lineContent = lines[raw.line_num - 1];
    const headerMatch = /^(#{1,6})/.exec(lineContent);
    if (!headerMatch) continue;

    allNodes.push({
      title: raw.title,
      line_num: raw.line_num,
      level: headerMatch[1].length,
    });
  }

  for (let i = 0; i < allNodes.length; i++) {
    const startLine = allNodes[i].line_num - 1;
    const endLine = i + 1 < allNodes.length ? allNodes[i + 1].line_num - 1 : lines.length;
    allNodes[i].text = lines.slice(startLine, endLine).join('\n').trim();
    allNodes[i].tokens = countTokens(allNodes[i].text!);
  }

  return allNodes;
}

function buildHierarchy(flatNodes: MdNode[]): MdNode[] {
  const root: MdNode[] = [];
  const stack: MdNode[] = [];

  for (const node of flatNodes) {
    const nodeWithChildren: MdNode = { ...node, nodes: [] };

    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      root.push(nodeWithChildren);
    } else {
      stack[stack.length - 1].nodes!.push(nodeWithChildren);
    }

    stack.push(nodeWithChildren);
  }

  function pruneEmpty(nodes: MdNode[]): MdNode[] {
    return nodes.map((n) => {
      if (n.nodes && n.nodes.length > 0) {
        n.nodes = pruneEmpty(n.nodes);
      } else {
        delete n.nodes;
      }
      return n;
    });
  }

  return pruneEmpty(root);
}

// ── Thinning (optional) ────────────────────────────────────────────────────────

function thinNodes(nodes: MdNode[], maxTokens: number): MdNode[] {
  return nodes.filter((n) => (n.tokens ?? 0) > maxTokens);
}

// ── Summary generation ─────────────────────────────────────────────────────────

async function getNodeSummary(node: MdNode, summaryTokenThreshold: number, model: string): Promise<string> {
  const tokens = node.tokens ?? countTokens(node.text ?? '');
  if (tokens < summaryTokenThreshold) return node.text ?? '';

  const prompt = `You are given a part of a document, your task is to generate a description of the partial document about what are main points covered in the partial document.

Partial Document Text: ${node.text}

Directly return the description, do not include any other text.`;

  return llmCompletion(model, prompt) as Promise<string>;
}

async function generateSummariesMd(
  structure: MdNode[],
  summaryTokenThreshold: number,
  model: string,
): Promise<void> {
  function flattenMd(nodes: MdNode[]): MdNode[] {
    return nodes.flatMap((n) => [n, ...(n.nodes ? flattenMd(n.nodes) : [])]);
  }

  const allNodes = flattenMd(structure);
  const summaries = await Promise.all(
    allNodes.map((n) => getNodeSummary(n, summaryTokenThreshold, model)),
  );

  allNodes.forEach((node, i) => {
    if (!node.nodes || node.nodes.length === 0) {
      node.summary = summaries[i];
    } else {
      node.prefix_summary = summaries[i];
    }
  });
}

// ── Main pipeline ──────────────────────────────────────────────────────────────

export interface MdIndexOptions {
  model: string;
  ifThinning?: boolean;
  thinningMaxTokens?: number;
  summaryTokenThreshold?: number;
  ifAddNodeSummary?: boolean;
  ifAddDocDescription?: boolean;
  ifAddNodeId?: boolean;
  ifAddNodeText?: boolean;
}

export async function mdToTree(mdPath: string, options: MdIndexOptions): Promise<MdIndexResult> {
  const {
    model,
    summaryTokenThreshold = 200,
    ifAddNodeSummary = true,
    ifAddDocDescription = false,
    ifAddNodeId = true,
    ifAddNodeText = false,
    ifThinning = false,
    thinningMaxTokens = 100,
  } = options;

  const content = fs.readFileSync(mdPath, 'utf-8');
  const docName = path.basename(mdPath, path.extname(mdPath));
  const lineCount = content.split('\n').length;

  const { nodes: rawNodes, lines } = extractNodesFromMarkdown(content);
  let flatNodes = buildNodeList(rawNodes, lines);

  if (ifThinning) {
    flatNodes = thinNodes(flatNodes, thinningMaxTokens);
  }

  const structure = buildHierarchy(flatNodes);

  if (ifAddNodeSummary) {
    console.log('[MdIndex] Generating summaries...');
    await generateSummariesMd(structure, summaryTokenThreshold, model);
  }

  if (ifAddNodeId) {
    writeNodeIds(structure as unknown as TreeNode[]);
  }

  if (!ifAddNodeText) {
    function removeText(nodes: MdNode[]): void {
      nodes.forEach((n) => {
        delete n.text;
        if (n.nodes) removeText(n.nodes);
      });
    }
    removeText(structure);
  }

  let docDescription: string | undefined;
  if (ifAddDocDescription) {
    docDescription = await generateDocDescription(structure as unknown as TreeNode[], model);
  }

  return {
    doc_name: docName,
    doc_description: docDescription,
    structure: structure as unknown as TreeNode[],
    line_count: lineCount,
  };
}
