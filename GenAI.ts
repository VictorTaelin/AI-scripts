import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AnthropicChat } from './Vendors/Anthropic';
import { GeminiChat } from './Vendors/Gemini';
import { GrokChat } from './Vendors/Grok';
import { countTokens } from 'gpt-tokenizer/model/gpt-4o';

export const MODELS = {
  g: 'gpt-4o-2024-11-20',
  G: 'gpt-4.5-preview-2025-02-27',
  o: 'o1-mini',
  O: 'o1',
  cm: 'claude-3-5-haiku-20241022',
  c: 'claude-3-7-sonnet-20250219',
  C: 'claude-3-7-sonnet-20250219-think',
  d: 'deepseek-chat',
  D: 'deepseek-reasoner',
  lm: 'meta-llama/llama-3.1-8b-instruct',
  l: 'meta-llama/llama-3.3-70b-instruct',
  L: 'meta-llama/llama-3.1-405b-instruct',
  i: 'gemini-2.0-pro-exp-02-05',
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
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) {
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

export class OpenAIChat {
  constructor(apiKey: string, baseURL: string, model: string, vendor: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.model = model;
    this.vendor = vendor;
  }

  async ask(userMessage: string | null, options: AskOptions): Promise<string | { messages: any[] }> {
    const { system, temperature, max_tokens, stream } = options;

    let endpoint, payload;
    const isO1Model = this.model.startsWith('o1');

    if (isO1Model) {
      // Use completions endpoint for o1 models like o1-pro
      endpoint = `${this.baseURL}/v1/completions`;
      const prompt = userMessage ? `${system || ''}\n\n${userMessage}` : system || '';
      payload = {
        model: this.model,
        prompt,
        temperature: temperature || 0.7,
        max_tokens: max_tokens || 1000,
        stream: false // o1 models don’t support streaming
      };
    } else {
      // Use chat completions endpoint for other OpenAI models
      endpoint = `${this.baseURL}/v1/chat/completions`;
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      if (userMessage) messages.push({ role: 'user', content: userMessage });
      payload = {
        model: this.model,
        messages,
        temperature: temperature || 0.7,
        max_tokens: max_tokens || 1000,
        stream: stream || false // Preserve streaming for non-o1 models
      };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`API Error: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    if (payload.stream) {
      // Handle streaming response (for non-o1 models that support it)
      const messages = [];
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            const parsed = JSON.parse(data);
            const content = parsed.choices[0].delta.content;
            if (content) messages.push({ role: 'assistant', content });
          }
        }
      }

      return { messages };
    } else {
      // Handle non-streaming response
      const data = await response.json();
      if (isO1Model) {
        return data.choices[0].text; // Completions endpoint for o1 models
      } else {
        return data.choices[0].message.content; // Chat completions for others
      }
    }
  }
}

export async function GenAI(modelShortcode: string): Promise<ChatInstance> {
  const model = MODELS[modelShortcode] || modelShortcode;
  const vendor = getVendor(model);

  if (['openai', 'deepseek', 'openrouter'].includes(vendor)) {
    const apiKey = await getToken(vendor);
    let baseURL;
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










