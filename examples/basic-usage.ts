/**
 * Basic usage example — index a PDF and retrieve content from it.
 * Run: npx ts-node examples/basic-usage.ts
 */
import 'dotenv/config';
import { PageIndexClient } from '../src/client';

async function main() {
  const client = new PageIndexClient({
    model: 'claude-sonnet-4-6',
    workspace: './workspace',
  });

  // --- Index a document ---
  const docId = await client.index('./sample.pdf');

  // --- Get document metadata ---
  const meta = client.getDocument(docId);
  console.log('\nDocument metadata:');
  console.log(meta);

  // --- Get hierarchical structure (tree) ---
  const structure = client.getDocumentStructure(docId);
  console.log('\nDocument structure (tree):');
  console.log(structure);

  // --- Retrieve specific pages ---
  const pages = await client.getPageContent(docId, '1-3');
  console.log('\nPage 1-3 content:');
  console.log(pages);
}

main().catch(console.error);
