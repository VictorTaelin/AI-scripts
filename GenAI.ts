import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AnthropicChat } from './Vendors/Anthropic';
import { GeminiChat } from './Vendors/Gemini';
import { OpenAIChat } from './Vendors/OpenAI';
import { CerebrasChat } from './Vendors/Cerebras';
import { XAIChat } from './Vendors/xai';
import { countTokens } from 'gpt-tokenizer/model/gpt-4o';

export const MODELS: Record<string, string> = {
  // OpenAI (Responses API)
  g:  'gpt-5',             // reasoning.effort = low (enforced in OpenAI.ts)
  gt: 'gpt-5-thinking',    // alias -> calls gpt-5 with reasoning.effort = medium
  G:  'gpt-5-thinking',
  Gt: 'gpt-5-thinking',

  // o‑series
  o: 'o4-mini',
  O: 'gpt-5-pro',

  // Anthropic
  cm: 'claude-3-5-haiku-20241022',
  c:  'claude-sonnet-4-5-20250929',
  C:  'claude-opus-4-1-20250805',
  ct: 'claude-sonnet-4-5-20250929-think',
  Ct: 'claude-opus-4-1-20250805-think',

  // DeepSeek
  d:  'deepseek-chat',
  dt: 'deepseek-reasoner',

  // Meta (via OpenRouter)
  lm: 'meta-llama/llama-3.1-8b-instruct',
  l:  'meta-llama/llama-3.3-70b-instruct',
  L:  'meta-llama/llama-3.1-405b-instruct',

  // Google
  i:  'gemini-2.5-flash',
  I:  'gemini-2.5-pro',

  // xAI
  x:  'grok-4-0709',
  xt: 'grok-code',

  // Qwen (via Cerebras)
  // q: "qwen-3-235b-a22b",
  q:  "qwen-3-coder-480b",
};

export interface AskOptions {
  system?: string;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  system_cacheable?: boolean; // Anthropic only
  reasoning_effort?: string;  // kept for non-Responses fallbacks
}

export interface ChatInstance {
  ask(userMessage: string | null, options: AskOptions): Promise<string | { messages: any[] }>;
}

function getVendor(model: string): string {
  const m = model.startsWith('gpt-5-thinking') ? 'gpt-5' : model;
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.startsWith('chat')) {
    return 'openai';
  } else if (m.startsWith('claude')) {
    return 'anthropic';
  } else if (m.startsWith('deepseek')) {
    return 'deepseek';
  } else if (m.startsWith('meta')) {
    return 'openrouter';
  } else if (m.startsWith('gemini')) {
    return 'gemini';
  } else if (m.startsWith('grok')) {
    return 'xai';
  } else if (m.startsWith('qwen')) {
    return 'cerebras';
  } else if (m === 'grok-4-0709') {
    return 'xai';
  } else {
    throw new Error(`Unsupported vendor: ${model}`);
  }
}

async function getToken(vendor: string): Promise<string> {
  const tokenPath = path.join(os.homedir(), '.config', `${vendor}.token`);
  try {
    return (await fs.readFile(tokenPath, 'utf8')).trim();
  } catch (err) {
    console.error(`Error reading ${vendor}.token file:`, (err as Error).message);
    process.exit(1);
  }
}

export async function GenAI(modelShortcode: string): Promise<ChatInstance> {
  const model = MODELS[modelShortcode] || modelShortcode;
  const vendor = getVendor(model);

  if (['openai', 'deepseek', 'openrouter'].includes(vendor)) {
    const apiKey = await getToken(vendor);
    let baseURL: string;
    if (vendor === 'openai') {
      baseURL = 'https://api.openai.com/v1';        // Responses API
    } else if (vendor === 'deepseek') {
      baseURL = 'https://api.deepseek.com/v1';      // Chat Completions fallback
    } else {
      baseURL = 'https://openrouter.ai/api/v1';     // Chat Completions fallback
    }
    return new OpenAIChat(apiKey, baseURL, model, vendor);
  } else if (vendor === 'anthropic') {
    const apiKey = await getToken(vendor);
    return new AnthropicChat(apiKey, model);
  } else if (vendor === 'gemini') {
    const apiKey = await getToken(vendor);
    return new GeminiChat(apiKey, model);
  } else if (vendor === 'cerebras') {
    const apiKey = await getToken(vendor);
    return new CerebrasChat(apiKey, model);
  } else if (vendor === 'xai') {
    const apiKey = await getToken(vendor);
    return new XAIChat(apiKey, model);
  } else {
    throw new Error(`Unsupported vendor: ${vendor}`);
  }
}

export function tokenCount(text: string): number {
  return countTokens(text);
}
