import path from 'path';
import { PageIndexClient } from './client';
import { llmCompletion } from './llm';

export interface QueryResult {
  answer: string;
  sources: Array<{ docName: string; docId: string; pages: string }>;
}

export interface QueryEngineOptions {
  vaultDir: string;
  model?: string;
  workspace?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

export class QueryEngine {
  private client: PageIndexClient;
  private model: string;
  private vaultDir: string;

  constructor(options: QueryEngineOptions) {
    const {
      vaultDir,
      model = 'claude-sonnet-4-6',
      workspace,
      anthropicApiKey,
      openaiApiKey,
    } = options;

    this.vaultDir = path.resolve(vaultDir);
    this.model = model;
    this.client = new PageIndexClient({
      model,
      workspace: workspace ?? path.join(this.vaultDir, '.pageindex'),
      ...(anthropicApiKey ? { anthropicApiKey } : {}),
      ...(openaiApiKey ? { openaiApiKey } : {}),
    });
  }

  async ensureIndexed(): Promise<void> {
    if (this.client.listDocuments().length === 0) {
      console.log('[QueryEngine] No index found — indexing vault...');
      await this.client.indexVault(this.vaultDir);
    }
  }

  async query(question: string): Promise<QueryResult> {
    await this.ensureIndexed();

    const docs = this.client.listDocuments();
    if (docs.length === 0) {
      return { answer: 'No documents found in vault.', sources: [] };
    }

    // Step 3: Gather document structures (compact trees, no raw text)
    const structures = docs.map((doc) => ({
      docId: doc.id,
      docName: doc.doc_name,
      type: doc.type,
      structure: JSON.parse(this.client.getDocumentStructure(doc.id)) as unknown,
    }));

    // Step 4: LLM picks relevant pages from the trees
    const navResponse = (await llmCompletion(
      this.model,
      buildNavigationPrompt(question, structures),
    )) as string;

    let navResult: Array<{ docId: string; docName: string; pages: string }> = [];
    try {
      const cleaned = navResponse.replace(/```json\n?|```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      navResult = Array.isArray(parsed) ? parsed : [];
    } catch {
      console.error('[QueryEngine] Failed to parse navigation response:', navResponse.slice(0, 200));
      return { answer: 'Failed to parse document navigation response.', sources: [] };
    }

    if (navResult.length === 0) {
      return { answer: 'No relevant sections found for this question.', sources: [] };
    }

    // Step 5: Retrieve actual content for selected pages
    const contentParts: Array<{ docName: string; docId: string; pages: string; content: string }> = [];
    for (const { docId, docName, pages } of navResult) {
      try {
        const raw = await this.client.getPageContent(docId, pages);
        contentParts.push({ docId, docName, pages, content: raw });
      } catch (err) {
        console.warn(`[QueryEngine] Skipping "${docName}" pages "${pages}":`, err);
      }
    }

    if (contentParts.length === 0) {
      return { answer: 'Could not retrieve content for the identified sections.', sources: [] };
    }

    // Step 6: LLM synthesises the final answer
    const answer = (await llmCompletion(
      this.model,
      buildAnswerPrompt(question, contentParts),
    )) as string;

    return {
      answer,
      sources: navResult.map(({ docId, docName, pages }) => ({ docId, docName, pages })),
    };
  }
}

// ── Prompt builders ────────────────────────────────────────────────────────────

function buildNavigationPrompt(
  question: string,
  structures: Array<{ docId: string; docName: string; type: string; structure: unknown }>,
): string {
  const docsText = structures
    .map(
      (s) =>
        `### "${s.docName}" (id: ${s.docId}, type: ${s.type})\n` +
        JSON.stringify(s.structure, null, 2),
    )
    .join('\n\n');

  return `You are navigating a document collection to find sections relevant to a query.

Documents (hierarchical outlines — no raw content):
${docsText}

Query: ${question}

Rules:
- For markdown documents use "line_num" values as page references
- For PDF documents use "start_index"/"end_index" values as page references
- Express ranges like "5-10" or multiple locations like "5-10,20,35-40"
- Only include sections with direct relevance

Return ONLY a JSON array, no other text:
[{"docId": "...", "docName": "...", "pages": "..."}]

If nothing is relevant return: []`;
}

function buildAnswerPrompt(
  question: string,
  content: Array<{ docName: string; pages: string; content: string }>,
): string {
  const contentText = content
    .map((c) => `### From "${c.docName}" (pages/lines ${c.pages}):\n${c.content}`)
    .join('\n\n---\n\n');

  return `Answer the following question using only the provided content.

Question: ${question}

Content:
${contentText}

Instructions:
- Answer based only on the provided content
- Cite the source document name when referencing specific information
- If the content does not fully answer the question, say so clearly
- Be concise and accurate`;
}
