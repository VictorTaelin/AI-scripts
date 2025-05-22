import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AnthropicChat } from './Vendors/Anthropic';
import { GeminiChat } from './Vendors/Gemini';
import { GrokChat } from './Vendors/Grok';
import { OpenAIChat } from './Vendors/OpenAI';
import { countTokens } from 'gpt-tokenizer/model/gpt-4o';

export const MODELS: Record<string, string> = {
  g: 'gpt-4.1',
  G: 'gpt-4.5-preview-2025-02-27',
  o: 'o4-mini',
  O: 'o3',
  cm: 'claude-3-5-haiku-20241022',
  c: 'claude-sonnet-4-20250514',
  C: 'claude-opus-4-20250514',
  ct: 'claude-sonnet-4-20250514-think',
  Ct: 'claude-opus-4-20250514-think',
  d: 'deepseek-chat',
  D: 'deepseek-reasoner',
  lm: 'meta-llama/llama-3.1-8b-instruct',
  l: 'meta-llama/llama-3.3-70b-instruct',
  L: 'meta-llama/llama-3.1-405b-instruct',
  i: 'gemini-2.5-pro-preview-05-06',
  I: 'gemini-2.0-flash-thinking-exp-01-21',
  x: "grok-3",
  X: "grok-3-think",
};

export interface AskOptions {
  system?: string;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  system_cacheable?: boolean;
  reasoning_effort?: string;
}

export interface ChatInstance {
  ask(userMessage: string | null, options: AskOptions): Promise<string | { messages: any[] }>;
}

function getVendor(model: string): string {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4') || model.startsWith('chat')) {
    return 'openai';
  } else if (model.startsWith('claude')) {
    return 'anthropic';
  } else if (model.startsWith('deepseek')) {
    return 'deepseek';
  } else if (model.startsWith('meta')) {
    return 'openrouter';
  } else if (model.startsWith('gemini')) {
    return 'gemini';
  } else if (model.startsWith('grok')) {
    return 'grok';
  } else {
    throw new Error(`Unsupported model: ${model}`);
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
      baseURL = 'https://api.openai.com/v1';
    } else if (vendor === 'deepseek') {
      baseURL = 'https://api.deepseek.com/v1';
    } else {
      baseURL = 'https://openrouter.ai/api/v1';
    }
    return new OpenAIChat(apiKey, baseURL, model, vendor);
  } else if (vendor === 'anthropic') {
    const apiKey = await getToken(vendor);
    return new AnthropicChat(apiKey, model);
  } else if (vendor === 'gemini') {
    const apiKey = await getToken(vendor);
    return new GeminiChat(apiKey, model);
  } else if (vendor === 'grok') {
    return new GrokChat(model);
  } else {
    throw new Error(`Unsupported vendor: ${vendor}`);
  }
}

export function tokenCount(text: string): number {
  return countTokens(text);
}
