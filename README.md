# pageindex-rag

Vectorless RAG using LLM-driven hierarchical document indexing — for PDF and Markdown files (including Obsidian vaults).

No embeddings. No vector database. The LLM reads the document structure once, builds a tree index, and then navigates that tree to answer questions.

> Based on [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex). Extended with multi-LLM provider support, Obsidian vault indexing, and a dependency security checker.

---

## What was added over the original

| Feature | Original | This fork |
|---|---|---|
| LLM providers | Anthropic only | Anthropic · OpenAI · Ollama · Claude Code (no API key) |
| Markdown indexing | — | Single file and full vault/folder |
| Obsidian vault support | — | `--vault <dir>` CLI flag |
| npm security rules | — | `npm run security` (age + CVE checks) |
| Env-var model override | — | `PAGEINDEX_MODEL` in `.env` |

---

## Installation

```bash
npm install @keleshteri/pageindex-rag
```

Requires **Node.js 18+** (uses built-in `fetch`).

---

## Quick start

```typescript
import { PageIndexClient } from '@keleshteri/pageindex-rag';

const client = new PageIndexClient({
  model: 'gpt-4o',           // or 'claude-sonnet-4-6', 'claude-code', 'ollama/llama3'
  workspace: './workspace',  // optional: persists indexes to disk
});

// Index a PDF
const docId = await client.index('./report.pdf');

// Index a Markdown file
const noteId = await client.index('./notes.md');

// Index an entire Obsidian vault
const results = await client.indexVault('./MyVault', { concurrency: 3 });

// Retrieve
const structure = client.getDocumentStructure(docId);
const pages     = await client.getPageContent(docId, '3-5');
```

---

## LLM options

Set the model in `.env` or pass it directly to `PageIndexClient`.

### Anthropic

```env
ANTHROPIC_API_KEY=sk-ant-...
PAGEINDEX_MODEL=claude-sonnet-4-6
```

### OpenAI

```env
OPENAI_API_KEY=sk-...
PAGEINDEX_MODEL=gpt-4o
```

### Claude Code — no API key needed

Uses your local Claude Code session. Requires the `claude` CLI to be installed and logged in.

```env
PAGEINDEX_MODEL=claude-code
```

### Ollama — fully local, no API key needed

```bash
ollama pull llama3
```

```env
PAGEINDEX_MODEL=ollama/llama3
# OLLAMA_BASE_URL=http://localhost:11434/v1  # override if needed
```

---

## CLI

```bash
# Single PDF
npx ts-node src/cli.ts --pdf report.pdf

# Single Markdown file
npx ts-node src/cli.ts --md notes.md

# Entire Obsidian vault
npx ts-node src/cli.ts --vault ~/Documents/MyVault

# Use a specific model
npx ts-node src/cli.ts --pdf report.pdf --model gpt-4o

# Options
#   --no-summary        skip per-node summaries (faster)
#   --add-description   generate a one-sentence doc description
#   --add-text          include raw page text in the output
#   --output <path>     custom output path (single-file mode only)
```

Output is saved to `results/` as JSON.

---

## Programmatic API

```typescript
const client = new PageIndexClient(options);

// Index
await client.index(filePath)               // auto-detects pdf/md
await client.indexVault(dirPath)           // all .md files in a folder

// Retrieve
client.getDocument(docId)                  // metadata (name, type, page count)
client.getDocumentStructure(docId)         // full tree (no raw text)
await client.getPageContent(docId, pages)  // pages: "1-3", "5,8", "12"
client.listDocuments()                     // all indexed docs
```

The three retrieve functions return JSON strings — they are designed to be passed directly as LLM tool-use callbacks.

---

## Security

```bash
npm run security   # checks all deps: age (< 14 days → blocked) + npm audit
```

See `scripts/check-deps.js` for thresholds and rules.

---

## Development

```bash
npm run build   # compile TypeScript → dist/
npm run dev     # watch mode
```

Copy `.env.example` to `.env` and configure your LLM provider before running.

---

## Credits

This project is a fork of [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex), licensed under MIT.

## License

MIT — see [LICENSE](LICENSE).
