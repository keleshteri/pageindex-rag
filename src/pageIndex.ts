import { TreeNode, TocEntry, IndexResult, LlmMessage } from './types';
import { llmCompletion, llmCompletionWithFinish } from './llm';
import {
  extractJson,
  getPdfPages,
  getPdfTitle,
  getTextOfPages,
  pageListToGroupText,
  convertPhysicalIndexToInt,
  postProcessing,
  addNodeText,
  writeNodeIds,
  generateSummariesForStructure,
  generateDocDescription,
  countTokens,
  PageData,
} from './utils';

// ── TOC detection ──────────────────────────────────────────────────────────────

async function tocDetectorSinglePage(content: string, model: string): Promise<string> {
  const prompt = `Your job is to detect if there is a table of content provided in the given text.

Given text: ${content}

return the following JSON format:
{
  "thinking": <why do you think there is a table of content in the given text>,
  "toc_detected": "<yes or no>"
}

Directly return the final JSON structure. Do not output anything else.
Please note: abstract, summary, notation list, figure list, table list, etc. are not table of contents.`;

  const response = (await llmCompletion(model, prompt)) as string;
  const json = extractJson<{ toc_detected: string }>(response);
  return json.toc_detected ?? 'no';
}

async function findTocPages(pages: PageData[], opt: { toc_check_page_num: number; model: string }): Promise<number[]> {
  let lastPageIsYes = false;
  const tocPageList: number[] = [];

  for (let i = 0; i < pages.length; i++) {
    if (i >= opt.toc_check_page_num && !lastPageIsYes) break;

    const result = await tocDetectorSinglePage(pages[i].text, opt.model);
    if (result === 'yes') {
      tocPageList.push(i);
      lastPageIsYes = true;
    } else if (result === 'no' && lastPageIsYes) {
      break;
    }
  }

  return tocPageList;
}

// ── TOC extraction and transformation ─────────────────────────────────────────

async function checkTocTransformComplete(rawToc: string, cleaned: string, model: string): Promise<string> {
  const prompt = `You are given a raw table of contents and a table of contents.
Your job is to check if the table of contents is complete.

Reply format:
{
  "thinking": <why do you think the cleaned table of contents is complete or not>,
  "completed": "yes" or "no"
}
Directly return the final JSON structure. Do not output anything else.

Raw Table of contents:
${rawToc}

Cleaned Table of contents:
${cleaned}`;

  const response = (await llmCompletion(model, prompt)) as string;
  const json = extractJson<{ completed: string }>(response);
  return json.completed ?? 'no';
}

async function tocTransformer(tocContent: string, model: string): Promise<TocEntry[]> {
  const initPrompt = `You are given a table of contents. Your job is to transform the whole table of content into a JSON format.

structure is the numeric system which represents the index of the hierarchy section. For example, the first section has structure index 1, the first subsection has structure index 1.1, etc.

The response should be in the following JSON format:
{
  "table_of_contents": [
    {
      "structure": "<structure index, string>",
      "title": "<title of the section>",
      "page": <page number or null>
    }
  ]
}
You should transform the full table of contents in one go.
Directly return the final JSON structure, do not output anything else.

Given table of contents:
${tocContent}`;

  let [lastComplete, finishReason] = await llmCompletionWithFinish(model, initPrompt);
  let isComplete = await checkTocTransformComplete(tocContent, lastComplete, model);

  if (isComplete === 'yes' && finishReason === 'finished') {
    const parsed = extractJson<{ table_of_contents: TocEntry[] }>(lastComplete);
    return normalizePageToInt(parsed.table_of_contents ?? []);
  }

  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const chatHistory: LlmMessage[] = [
      { role: 'user', content: initPrompt },
      { role: 'assistant', content: lastComplete },
    ];
    const continuePrompt = 'please continue the table of contents json structure, directly output the remaining part of the json structure.';
    let newPart: string;
    [newPart, finishReason] = await llmCompletionWithFinish(model, continuePrompt, chatHistory);
    lastComplete += newPart;
    isComplete = await checkTocTransformComplete(tocContent, lastComplete, model);

    if (isComplete === 'yes' && finishReason === 'finished') break;
  }

  const parsed = extractJson<{ table_of_contents: TocEntry[] }>(lastComplete);
  return normalizePageToInt(parsed.table_of_contents ?? []);
}

function normalizePageToInt(entries: TocEntry[]): TocEntry[] {
  return entries.map((e) => {
    if (e.page !== undefined && e.page !== null && typeof e.page === 'string') {
      const n = parseInt(e.page as unknown as string, 10);
      e.page = isNaN(n) ? null : n;
    }
    return e;
  });
}

function detectPageIndex(tocContent: string, model: string): Promise<string> {
  const prompt = `You will be given a table of contents.
Your job is to detect if there are page numbers/indices given within the table of contents.

Given text: ${tocContent}

Reply format:
{
  "thinking": <why do you think there are page numbers>,
  "page_index_given_in_toc": "<yes or no>"
}
Directly return the final JSON structure. Do not output anything else.`;

  return llmCompletion(model, prompt).then((r) => {
    const json = extractJson<{ page_index_given_in_toc: string }>(r as string);
    return json.page_index_given_in_toc ?? 'no';
  });
}

// ── Physical index mapping ─────────────────────────────────────────────────────

async function addPhysicalIndexToToc(
  toc: TocEntry[],
  pages: PageData[],
  startIndex: number,
  model: string,
): Promise<TocEntry[]> {
  const pageContents: string[] = [];
  const tokenLengths: number[] = [];

  for (let i = startIndex; i < pages.length; i++) {
    const text = `<physical_index_${i + 1}>\n${pages[i].text}\n<physical_index_${i + 1}>\n\n`;
    pageContents.push(text);
    tokenLengths.push(pages[i].tokens);
  }

  const groups = pageListToGroupText(pageContents, tokenLengths);
  let structure: TocEntry[] = toc.map((e, idx) => ({ ...e, list_index: idx }));

  for (const part of groups) {
    const prompt = `You are given a JSON structure of a document and a partial part of the document. Your task is to check if the title described in the structure is started in the partial given document.

The provided text contains tags like <physical_index_X> and <physical_index_X> to indicate the physical location of the page X.

If the full target section starts in the partial given document, insert the given JSON structure with "start": "yes", and "physical_index": "<physical_index_X>".
If the full target section does not start in the partial given document, insert "start": "no", "physical_index": null.

The response should be in the following format:
[
  {
    "structure": "<structure index>",
    "title": "<title of the section>",
    "start": "<yes or no>",
    "physical_index": "<physical_index_X>" or null
  }
]

The given structure contains the result of the previous part, you need to fill the result of the current part, do not change the previous result.
Directly return the final JSON structure. Do not output anything else.

Current Partial Document:
${part}

Given Structure:
${JSON.stringify(structure, null, 2)}`;

    const response = (await llmCompletion(model, prompt)) as string;
    const result = extractJson<TocEntry[]>(response);
    if (Array.isArray(result)) {
      structure = result.map((item) => {
        const { start, ...rest } = item as TocEntry & { start?: string };
        void start;
        return rest;
      });
    }
  }

  return convertPhysicalIndexToInt(structure);
}

async function calculatePageOffset(
  tocWithPage: TocEntry[],
  tocWithPhysical: TocEntry[],
  startPageIndex: number,
): Promise<number | null> {
  const pairs: Array<{ page: number; physical_index: number }> = [];

  for (const phy of tocWithPhysical) {
    for (const pg of tocWithPage) {
      if (phy.title === pg.title && phy.physical_index !== null && phy.physical_index !== undefined) {
        const physIdx = Number(phy.physical_index);
        if (physIdx >= startPageIndex && pg.page !== null && pg.page !== undefined) {
          pairs.push({ page: Number(pg.page), physical_index: physIdx });
        }
      }
    }
  }

  if (pairs.length === 0) return null;

  const diffs: Record<number, number> = {};
  for (const p of pairs) {
    const diff = p.physical_index - p.page;
    diffs[diff] = (diffs[diff] ?? 0) + 1;
  }

  return Number(Object.entries(diffs).sort((a, b) => b[1] - a[1])[0][0]);
}

// ── No-TOC tree generation ─────────────────────────────────────────────────────

async function generateTocInit(part: string, model: string): Promise<TocEntry[]> {
  const prompt = `You are an expert in extracting hierarchical tree structure, your task is to generate the tree structure of the document.

The structure variable is the numeric system which represents the index of the hierarchy section. For example, the first section has structure index 1, the first subsection has structure index 1.1, the second subsection has structure index 1.2, etc.

For the title, you need to extract the original title from the text, only fix the space inconsistency.

The provided text contains tags like <physical_index_X> and <physical_index_X> to indicate the start and end of page X.

For the physical_index, you need to extract the physical index of the start of the section from the text. Keep the <physical_index_X> format.

The response should be in the following format:
[
  {
    "structure": "<structure index>",
    "title": "<title of the section>",
    "physical_index": "<physical_index_X>"
  }
]

Directly return the final JSON structure. Do not output anything else.

Given text:
${part}`;

  const [response, finishReason] = await llmCompletionWithFinish(model, prompt);
  if (finishReason !== 'finished') throw new Error(`TOC generation stopped early: ${finishReason}`);
  return extractJson<TocEntry[]>(response);
}

async function generateTocContinue(existing: TocEntry[], part: string, model: string): Promise<TocEntry[]> {
  const prompt = `You are an expert in extracting hierarchical tree structure.
You are given a tree structure of the previous part and the text of the current part.
Your task is to continue the tree structure from the previous part to include the current part.

The structure variable is the numeric system which represents the index of the hierarchy section.

For the title, you need to extract the original title from the text, only fix the space inconsistency.

The provided text contains tags like <physical_index_X> and <physical_index_X> to indicate the start and end of page X.

For the physical_index, you need to extract the physical index of the start of the section from the text. Keep the <physical_index_X> format.

The response should be in the following format:
[
  {
    "structure": "<structure index>",
    "title": "<title of the section>",
    "physical_index": "<physical_index_X>"
  }
]

Directly return the additional part of the final JSON structure. Do not output anything else.

Given text:
${part}

Previous tree structure:
${JSON.stringify(existing, null, 2)}`;

  const [response, finishReason] = await llmCompletionWithFinish(model, prompt);
  if (finishReason !== 'finished') throw new Error(`TOC continuation stopped early: ${finishReason}`);
  return extractJson<TocEntry[]>(response);
}

async function processNoToc(pages: PageData[], startIndex: number, model: string): Promise<TocEntry[]> {
  const pageContents: string[] = [];
  const tokenLengths: number[] = [];

  for (let i = startIndex; i < pages.length; i++) {
    const text = `<physical_index_${i + 1}>\n${pages[i].text}\n<physical_index_${i + 1}>\n\n`;
    pageContents.push(text);
    tokenLengths.push(pages[i].tokens);
  }

  const groups = pageListToGroupText(pageContents, tokenLengths);
  let toc = await generateTocInit(groups[0], model);

  for (const group of groups.slice(1)) {
    const additional = await generateTocContinue(toc, group, model);
    toc = [...toc, ...additional];
  }

  return convertPhysicalIndexToInt(toc);
}

// ── Title appearance check ─────────────────────────────────────────────────────

async function checkTitleAppearanceInStart(title: string, pageText: string, model: string): Promise<string> {
  const prompt = `You will be given the current section title and the current page_text.
Your job is to check if the current section starts in the beginning of the given page_text.
If there are other contents before the current section title, then the current section does not start in the beginning of the given page_text.
If the current section title is the first content in the given page_text, then the current section starts in the beginning of the given page_text.

Note: do fuzzy matching, ignore any space inconsistency in the page_text.

The given section title is ${title}.
The given page_text is ${pageText}.

reply format:
{
  "thinking": <why do you think the section appears or starts in the page_text>,
  "start_begin": "yes or no"
}
Directly return the final JSON structure. Do not output anything else.`;

  const response = (await llmCompletion(model, prompt)) as string;
  const json = extractJson<{ start_begin: string }>(response);
  return json.start_begin ?? 'no';
}

async function checkTitleAppearanceConcurrent(
  structure: TocEntry[],
  pages: PageData[],
  model: string,
): Promise<TocEntry[]> {
  const validItems = structure.filter((item) => item.physical_index !== null && item.physical_index !== undefined);

  const results = await Promise.all(
    validItems.map((item) => {
      const pageText = pages[(item.physical_index as number) - 1]?.text ?? '';
      return checkTitleAppearanceInStart(item.title, pageText, model);
    }),
  );

  let validIdx = 0;
  for (const item of structure) {
    if (item.physical_index !== null && item.physical_index !== undefined) {
      item.appear_start = results[validIdx++];
    } else {
      item.appear_start = 'no';
    }
  }

  return structure;
}

// ── Main pipeline ──────────────────────────────────────────────────────────────

export interface PageIndexOptions {
  model: string;
  tocCheckPageNum?: number;
  maxPagesPerNode?: number;
  maxTokensPerNode?: number;
  ifAddNodeId?: boolean;
  ifAddNodeSummary?: boolean;
  ifAddDocDescription?: boolean;
  ifAddNodeText?: boolean;
}

export async function pageIndex(
  filePath: string,
  options: PageIndexOptions,
): Promise<IndexResult> {
  const {
    model,
    tocCheckPageNum = 20,
    ifAddNodeId = true,
    ifAddNodeSummary = true,
    ifAddDocDescription = false,
    ifAddNodeText = false,
  } = options;

  console.log(`[PageIndex] Parsing PDF: ${filePath}`);
  const pages = await getPdfPages(filePath);
  const docName = getPdfTitle(filePath);
  const totalPages = pages.length;

  console.log(`[PageIndex] ${totalPages} pages found. Searching for TOC...`);
  const tocPageIndices = await findTocPages(pages, { toc_check_page_num: tocCheckPageNum, model });

  let structure: TocEntry[] = [];
  const startIndex = tocPageIndices.length > 0 ? Math.max(...tocPageIndices) + 1 : 0;

  if (tocPageIndices.length > 0) {
    const tocText = tocPageIndices.map((i) => pages[i].text).join('\n');
    const cleanedToc = tocText.replace(/\.{5,}/g, ': ').replace(/(?:\. ){5,}\.?/g, ': ');

    const hasPageIndex = await detectPageIndex(cleanedToc, model);
    console.log(`[PageIndex] TOC found (${tocPageIndices.length} pages). Has page numbers: ${hasPageIndex}`);

    const tocEntries = await tocTransformer(cleanedToc, model);

    if (hasPageIndex === 'yes') {
      const tocWithPhysical = await addPhysicalIndexToToc(tocEntries, pages, startIndex, model);
      const offset = await calculatePageOffset(tocEntries, tocWithPhysical, startIndex);
      if (offset !== null) {
        structure = tocEntries.map((e) => ({
          ...e,
          physical_index: e.page !== null && e.page !== undefined ? Number(e.page) + offset : null,
        }));
      } else {
        structure = tocWithPhysical;
      }
    } else {
      structure = await addPhysicalIndexToToc(tocEntries, pages, startIndex, model);
    }
  } else {
    console.log('[PageIndex] No TOC found. Generating structure from content...');
    structure = await processNoToc(pages, startIndex, model);
  }

  console.log(`[PageIndex] Building tree with ${structure.length} sections...`);
  structure = await checkTitleAppearanceConcurrent(structure, pages, model);
  const tree = postProcessing(structure, totalPages);

  if (ifAddNodeText) {
    addNodeText(tree, pages);
  }

  if (ifAddNodeSummary && ifAddNodeText) {
    console.log('[PageIndex] Generating summaries...');
    await generateSummariesForStructure(tree, model);
  }

  if (ifAddNodeId) {
    writeNodeIds(tree);
  }

  let docDescription: string | undefined;
  if (ifAddDocDescription) {
    docDescription = await generateDocDescription(tree, model);
  }

  return {
    doc_name: docName,
    doc_description: docDescription,
    structure: tree,
  };
}
