import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { pageIndex } from './pageIndex';
import { mdToTree } from './pageIndexMd';
import { loadConfig, DEFAULT_CONFIG } from './config';

const MD_EXTENSIONS = new Set(['.md', '.markdown']);
const OBSIDIAN_SKIP_DIRS = new Set(['.obsidian', '.trash', 'node_modules']);

function printUsage(): void {
  console.log(`
Usage:
  npx ts-node src/cli.ts --pdf   <file>       Index a PDF
  npx ts-node src/cli.ts --md    <file>       Index a Markdown file
  npx ts-node src/cli.ts --vault <dir>        Index all Markdown files in a folder (Obsidian vault)

Options:
  --model <model>           LLM model (default: ${DEFAULT_CONFIG.model})
  --no-summary              Skip node summary generation
  --add-description         Generate a document description
  --add-text                Include raw text in output nodes
  --output <path>           Output JSON path (single file only; default: results/<name>_structure.json)
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    printUsage();
    process.exit(0);
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
