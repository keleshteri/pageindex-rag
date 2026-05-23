import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { LlmMessage, FinishReason } from './types';

const execAsync = promisify(exec);

// ── Singletons ─────────────────────────────────────────────────────────────────

let _anthropic: Anthropic | null = null;
let _openai: OpenAI | null = null;
let _ollama: OpenAI | null = null;

function getAnthropicClient(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

function getOpenAIClient(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

function getOllamaClient(): OpenAI {
  if (!_ollama) {
    const baseURL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
    _ollama = new OpenAI({ baseURL, apiKey: 'ollama' });
  }
  return _ollama;
}

// ── Model routing ──────────────────────────────────────────────────────────────

function isAnthropicModel(model: string): boolean {
  return model.startsWith('claude') || model.startsWith('anthropic/');
}

function isClaudeCodeModel(model: string): boolean {
  return model === 'claude-code';
}

function isOllamaModel(model: string): boolean {
  return model.startsWith('ollama/');
}

function normalizeAnthropicModel(model: string): string {
  return model.replace(/^anthropic\//, '');
}

// ── Provider calls ─────────────────────────────────────────────────────────────

async function callAnthropic(
  model: string,
  messages: LlmMessage[],
): Promise<{ content: string; finishReason: FinishReason }> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: normalizeAnthropicModel(model),
    max_tokens: 8096,
    temperature: 0,
    messages,
  });

  const block = response.content[0];
  const content = block.type === 'text' ? block.text : '';
  const finishReason: FinishReason =
    response.stop_reason === 'max_tokens' ? 'max_output_reached' : 'finished';

  return { content, finishReason };
}

async function callOpenAI(
  model: string,
  messages: LlmMessage[],
): Promise<{ content: string; finishReason: FinishReason }> {
  const client = getOpenAIClient();
  const response = await client.chat.completions.create({
    model,
    messages,
    temperature: 0,
  });

  const choice = response.choices[0];
  return {
    content: choice.message.content ?? '',
    finishReason: choice.finish_reason === 'length' ? 'max_output_reached' : 'finished',
  };
}

async function callOllama(
  model: string,
  messages: LlmMessage[],
): Promise<{ content: string; finishReason: FinishReason }> {
  const actualModel = model.replace(/^ollama\//, '');
  const client = getOllamaClient();
  const response = await client.chat.completions.create({
    model: actualModel,
    messages,
    temperature: 0,
  });

  const choice = response.choices[0];
  return {
    content: choice.message.content ?? '',
    finishReason: choice.finish_reason === 'length' ? 'max_output_reached' : 'finished',
  };
}

async function callClaudeCode(
  messages: LlmMessage[],
): Promise<{ content: string; finishReason: FinishReason }> {
  // Flatten multi-turn history into a single prompt.
  // Claude Code subprocess is stateless per call, so we serialise prior turns.
  let prompt: string;
  if (messages.length === 1) {
    prompt = messages[0].content;
  } else {
    const history = messages
      .slice(0, -1)
      .map((m) => `[${m.role}]\n${m.content}`)
      .join('\n\n');
    prompt = `${history}\n\n[user]\n${messages[messages.length - 1].content}`;
  }

  // Write prompt to a temp file and feed it via stdin redirect.
  // Passing the prompt as a shell argument breaks on Windows because special
  // characters in PDF text (backticks, quotes, etc.) are misinterpreted by
  // cmd.exe, causing "The system cannot find the file specified" errors.
  const tmpFile = join(tmpdir(), `pageindex-${process.pid}-${Date.now()}.txt`);
  writeFileSync(tmpFile, prompt, 'utf8');

  try {
    const { stdout } = await execAsync(
      `claude -p < "${tmpFile}"`,
      { maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
    );
    return { content: stdout.trim(), finishReason: 'finished' };
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function llmCompletion(
  model: string,
  prompt: string,
  options: {
    chatHistory?: LlmMessage[];
    returnFinishReason?: boolean;
    maxRetries?: number;
  } = {},
): Promise<string | [string, FinishReason]> {
  const { chatHistory, returnFinishReason = false, maxRetries = 10 } = options;

  const messages: LlmMessage[] = [
    ...(chatHistory ?? []),
    { role: 'user', content: prompt },
  ];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      let result: { content: string; finishReason: FinishReason };

      if (isClaudeCodeModel(model)) {
        result = await callClaudeCode(messages);
      } else if (isOllamaModel(model)) {
        result = await callOllama(model, messages);
      } else if (isAnthropicModel(model)) {
        result = await callAnthropic(model, messages);
      } else {
        result = await callOpenAI(model, messages);
      }

      return returnFinishReason
        ? [result.content, result.finishReason]
        : result.content;
    } catch (err) {
      console.warn(`LLM call failed (attempt ${attempt + 1}/${maxRetries}):`, err);
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  console.error('Max retries reached for prompt:', prompt.slice(0, 200));
  return returnFinishReason ? ['', 'error'] : '';
}

export async function llmCompletionWithFinish(
  model: string,
  prompt: string,
  chatHistory?: LlmMessage[],
): Promise<[string, FinishReason]> {
  return llmCompletion(model, prompt, {
    chatHistory,
    returnFinishReason: true,
  }) as Promise<[string, FinishReason]>;
}
