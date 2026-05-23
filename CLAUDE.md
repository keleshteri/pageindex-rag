# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # compile TypeScript → dist/
npm run dev            # watch mode (tsc --watch)
npm run cli            # alias for ts-node src/cli.ts (pass args separately)
npm run security       # run full dependency security check (age + audit)

# CLI — index a PDF or Markdown file directly
npx ts-node src/cli.ts --pdf <path> [--model <model>] [--no-summary] [--add-description] [--add-text] [--output <path>]
npx ts-node src/cli.ts --md  <path> [options]

# Run the example
npx ts-node examples/basic-usage.ts
```

There are no tests yet (`npm test` echoes a placeholder).

Copy `.env.example` to `.env` and set at least one of `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` before running anything.

## Dependency Security Rules

**Run `npm run security` before adding or upgrading any package.** The script checks every dependency against the npm registry and fails on violations.

### Blocking rules (do not add the package if any apply)

| Rule | Threshold | Reason |
|---|---|---|
| Package too young | first published < 14 days ago | Typosquatting and supply-chain attacks almost always use newly registered packages |
| Known HIGH/CRITICAL CVE | `npm audit --audit-level=high` fails | Directly exploitable vulnerabilities |

### Non-blocking warnings (investigate before proceeding)

- **Latest version published < 3 days ago** — a legitimate package that just received a suspicious new version is a common account-takeover vector; verify the release is intentional before upgrading to it.
- **Registry fetch failed** — could be a private/scoped package or a network issue; confirm the package exists on the public registry.

### General package hygiene

- Prefer packages with **>100 k weekly downloads** and **multiple maintainers** — single-maintainer packages are higher risk for account takeover.
- Do not add a package unless it is genuinely necessary; every new dependency is an attack surface.
- When a package is added or upgraded, re-run `npm run security` and commit the updated `package-lock.json`.
- If `npm audit fix` cannot resolve a vulnerability, document why it is acceptable or replace the dependency.

### Uncomment `ignore-scripts=true` in `.npmrc` if you need the strongest protection

It prevents npm from executing lifecycle hooks (`postinstall`, etc.) during install, which is how many supply-chain attacks execute their payload. Note: this will break packages that compile native binaries. Toggle only when you understand the trade-off.

## Architecture

**PageIndexRAG** is a vectorless RAG library. Instead of embedding chunks into a vector database, it uses an LLM to build a hierarchical tree index of a document, then uses that tree to guide retrieval — no embeddings required.

### Entry points

- **`PageIndexClient`** (`src/client.ts`) — the primary public API. Wraps indexing and retrieval, handles workspace persistence (writing/reading indexed documents as JSON files). When a `workspace` path is supplied, each document is saved as `<uuid>.json` with a `_meta.json` registry; heavy fields (`structure`, `pages`) are lazy-loaded on demand.
- **`src/cli.ts`** — thin CLI wrapper around `pageIndex` / `mdToTree` for one-off file processing; outputs JSON to `results/<name>_structure.json` by default.
- **`src/index.ts`** — library re-exports; the public API surface.

### Indexing pipelines

**PDF pipeline** (`src/pageIndex.ts` → `pageIndex()`):
1. Parse PDF into per-page text with token counts (`utils.getPdfPages`)
2. Detect TOC pages via LLM (checks up to `toc_check_page_num` pages)
3. If TOC found: transform it to structured JSON, detect whether page numbers are present, map logical page numbers to physical PDF page indices
4. If no TOC: generate the tree structure directly from content by chunking pages and calling the LLM
5. Verify that each section title actually appears at the start of its mapped page
6. Build the final `TreeNode[]` tree via `postProcessing`
7. Optionally attach page text, generate per-node summaries, generate a one-sentence document description, and assign sequential node IDs

**Markdown pipeline** (`src/pageIndexMd.ts` → `mdToTree()`):
1. Parse heading hierarchy (`#`–`######`) into a flat list, skipping code blocks
2. Attach the raw text of each node (content from this heading to the next)
3. Build the nested `TreeNode[]` hierarchy
4. Optionally thin nodes below a token threshold, generate summaries, assign node IDs

### LLM layer (`src/llm.ts`)

Model routing is determined by the model name prefix: names starting with `claude` or `claude-` route to the Anthropic SDK; everything else routes to OpenAI. Both clients are lazily instantiated as module-level singletons. All calls use `temperature: 0`. Retries up to 10 times with linear back-off on failure.

`llmCompletion` is the primary function; `llmCompletionWithFinish` is a convenience wrapper that always returns `[content, finishReason]` — used when the caller needs to detect truncated output (e.g. multi-turn TOC continuation).

### Retrieval (`src/retrieve.ts`)

Three functions designed to be used as LLM tool-use callbacks:

- `getDocument` — returns document metadata (name, type, page/line count) as a JSON string
- `getDocumentStructure` — returns the full `TreeNode[]` tree (with `text` fields stripped) as a JSON string
- `getPageContent` — returns raw content for specific pages/lines; accepts ranges like `"1-3"`, `"3,8"`, or `"12"`; falls back to re-reading the PDF from disk if cached page data is unavailable

### Shared utilities (`src/utils.ts`)

- **Token counting**: `countTokens` uses `js-tiktoken` with the `cl100k_base` encoding (lazy singleton)
- **JSON extraction**: `extractJson` handles LLM responses wrapped in ` ```json ``` ` fences, Python-style booleans/None, and trailing commas
- **Page grouping**: `pageListToGroupText` chunks pages into token-bounded groups with 1-page overlap for batch LLM calls
- **Tree utilities**: `listToTree` (flat `TocEntry[]` → nested `TreeNode[]`), `structureToList` (flatten), `writeNodeIds` (sequential zero-padded IDs), `removeFields` (deep field removal for serialization)

### Key types (`src/types.ts`)

- `TreeNode` — recursive node with `title`, `node_id`, `start_index`/`end_index` (1-based page numbers for PDFs, line numbers for Markdown), optional `summary`/`prefix_summary`/`text`, and `nodes[]`
- `DocumentRecord` — runtime representation of an indexed document stored in `PageIndexClient.documents`
- `PageIndexConfig` — all tunable knobs; defaults in `src/config.ts`

### Default config

| Setting | Default |
|---|---|
| `model` / `retrieve_model` | `claude-sonnet-4-6` |
| `toc_check_page_num` | 20 |
| `max_page_num_each_node` | 10 |
| `max_token_num_each_node` | 20 000 |
| `if_add_node_id` | yes |
| `if_add_node_summary` | yes |
| `if_add_doc_description` | no |
| `if_add_node_text` | no |
