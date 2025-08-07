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
  g: 'gpt-5',
  G: 'gpt-5',
  o: 'o4-mini',
  O: 'o3',
  cm: 'claude-3-5-haiku-20241022',
  c: 'claude-sonnet-4-20250514',
  C: 'claude-opus-4-1-20250805',
  ct: 'claude-sonnet-4-20250514-think',
  Ct: 'claude-opus-4-1-20250805-think',
  d: 'deepseek-chat',
  dt: 'deepseek-reasoner',
  lm: 'meta-llama/llama-3.1-8b-instruct',
  l: 'meta-llama/llama-3.3-70b-instruct',
  L: 'meta-llama/llama-3.1-405b-instruct',
  i: 'gemini-2.5-flash',
  I: 'gemini-2.5-pro',
  x: "grok-4-0709",
  xt: "grok-4-0709",
  //q: "qwen-3-235b-a22b",
  q: "qwen-3-coder-480b",
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
    return 'xai';
  } else if (model.startsWith('qwen')) {
    return 'cerebras';
  } else if (model === 'grok-4-0709') {
    return 'xai';
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
