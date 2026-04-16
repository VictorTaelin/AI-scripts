import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AnthropicChat } from './Vendors/Anthropic';
import { GoogleChat } from './Vendors/Google';
import { OpenAIChat } from './Vendors/OpenAI';
import { XAIChat } from './Vendors/xai';
import { VastChat } from './Vendors/Vast';
import { FireworksChat } from './Vendors/Fireworks';
import { countTokens } from 'gpt-tokenizer/model/gpt-4o';

export const MODELS: Record<string, string> = {
  // OpenAI GPT-5.4 family
  'g-' : 'openai:gpt-5.4:low',
  'g'  : 'openai:gpt-5.4:medium',
  'g+' : 'openai:gpt-5.4:high',
  'G'  : 'openai:gpt-5.4:high',

  // OpenAI GPT-5.3 Codex Spark family
  'c-' : 'openai:gpt-5.3-codex-spark:low',
  'c'  : 'openai:gpt-5.3-codex-spark:medium',
  'c+' : 'openai:gpt-5.3-codex-spark:high',
  'C'  : 'openai:gpt-5.3-codex-spark:high',

  // Anthropic Claude
  's-'  : 'anthropic:claude-sonnet-4-6:low',
  's'   : 'anthropic:claude-sonnet-4-6:medium',
  's+'  : 'anthropic:claude-sonnet-4-6:high',
  's++' : 'anthropic:claude-sonnet-4-6:max',
  'S'   : 'anthropic:claude-sonnet-4-6:high',

  'o-'  : 'anthropic:claude-opus-4-7:low',
  'o'   : 'anthropic:claude-opus-4-7:medium',
  'o+'  : 'anthropic:claude-opus-4-7:high',
  'o++' : 'anthropic:claude-opus-4-7:max',
  'O'   : 'anthropic:claude-opus-4-7:high',

  // Google Gemini
  'i-' : 'google:gemini-3.1-pro-preview:low',
  'i'  : 'google:gemini-3.1-pro-preview:medium',
  'i+' : 'google:gemini-3.1-pro-preview:high',
  'I'  : 'google:gemini-3.1-pro-preview:high',
  'f-' : 'google:gemini-3.1-flash-lite-preview:low',
  'f'  : 'google:gemini-3.1-flash-lite-preview:medium',
  'f+' : 'google:gemini-3.1-flash-lite-preview:high',
  'F'  : 'google:gemini-3.1-flash-lite-preview:high',

  // xAI Grok
  'x-' : 'xai:grok-4-0709:low',
  'x'  : 'xai:grok-4-0709:medium',
  'X'  : 'xai:grok-4-0709:high',

  // Self-hosted (Vast.ai B200)
  'm'  : 'vast:/root/model:none',
  'q'  : 'vast:/root/model:none',

  // GLM-5.1 via Fireworks
  'z-' : 'fireworks:accounts/fireworks/models/glm-5p1:none',
  'z'  : 'fireworks:accounts/fireworks/models/glm-5p1:none',
  'z+' : 'fireworks:accounts/fireworks/models/glm-5p1:none',

  // GLM-5.1 on Vast.ai (needs SSH tunnel on port 30000)
  'v'  : 'vast:glm-5.1-fp4:none',
};

export type Vendor = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'xai' | 'vast' | 'fireworks';
export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high' | 'max' | 'auto';

export interface ResolvedModelSpec {
  vendor: Vendor;
  model: string;
  thinking: ThinkingLevel;
  fast: boolean;
}

export interface VendorConfig {
  openai?: {
    reasoning?: {
      effort: 'minimal' | 'low' | 'medium' | 'high';
    };
  };
  anthropic?: {
    thinking?: {
      type: 'adaptive';
    } | {
      type: 'disabled';
    } | {
      type: 'enabled';
      budget_tokens: number;
    } | null;
    effort?: 'low' | 'medium' | 'high' | 'max';
  };
  google?: {
    config?: {
      maxOutputTokens?: number;
      thinkingConfig?: {
        thinkingLevel?: 'low' | 'high';
        //thinkingBudget?: number;
        includeThoughts?: boolean;
      };
    };
  };
}

export type JsonSchema = Record<string, any>;

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

export interface ToolCall {
  id?: string;
  name: string;
  input: Record<string, any>;
}

export interface AskResult {
  text: string;
  toolCalls: ToolCall[];
}

export interface AskOptions {
  system?: string;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  system_cacheable?: boolean;
  vendorConfig?: VendorConfig;
}

export interface AskToolsOptions extends AskOptions {
  tools: ToolDef[];
}

export interface ChatInstance {
  ask(userMessage: string | null, options: AskOptions): Promise<string | { messages: any[] }>;
  askTools(userMessage: string, options: AskToolsOptions): Promise<AskResult>;
}

const SUPPORTED_VENDORS = new Set<Vendor>(['openai', 'anthropic', 'google', 'openrouter', 'xai', 'vast', 'fireworks']);

const CEREBRAS_MODELS = new Set<string>([
  'gpt-oss-120b',
  'gpt-oss-20b',
  'llama3.1-8b',
  'llama-3.3-70b',
  'qwen-3-32b',
  'qwen-3-235b-a22b-instruct-2507',
  'zai-glm-4.6',
]);

const API_KEY_ENV_VARS: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  xai: ['XAI_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  vast: [],
  fireworks: [],
};

function inferVendor(model: string): Vendor {
  const normalized = model.toLowerCase();
  if (normalized.startsWith('gpt') || normalized.startsWith('o')) {
    return 'openai';
  }
  if (normalized.startsWith('claude')) {
    return 'anthropic';
  }
  if (normalized.startsWith('gemini')) {
    return 'google';
  }
  if (normalized.startsWith('grok')) {
    return 'xai';
  }
  if (normalized.includes('/')) {
    return 'openrouter';
  }
  throw new Error(`Unsupported vendor for model "${model}"`);
}

async function getToken(vendor: string): Promise<string> {
  const envCandidates = API_KEY_ENV_VARS[vendor] ?? [`${vendor.toUpperCase()}_API_KEY`];
  for (const envVar of envCandidates) {
    const value = process.env[envVar]?.trim();
    if (value) {
      return value;
    }
  }

  const tokenPath = path.join(os.homedir(), '.config', `${vendor}.token`);
  try {
    const token = (await fs.readFile(tokenPath, 'utf8')).trim();
    if (token) {
      return token;
    }
    throw new Error(`${tokenPath} is empty`);
  } catch (err) {
    throw new Error(
      `Missing API key for "${vendor}". Set ${envCandidates.join(' or ')} or create ${tokenPath}. ` +
      `Underlying error: ${(err as Error).message}`,
    );
  }
}

// Models that do not yet support Anthropic's fast mode beta. When fast is
// requested on one of these, we silently fall back to the mapped model.
// This is a deliberately hardcoded switch — remove an entry once the upstream
// model gains fast-mode support.
const FAST_MODE_FALLBACKS: Record<string, string> = {
  'claude-opus-4-7': 'claude-opus-4-6',
};

function applyFastModeFallbacks(spec: ResolvedModelSpec): ResolvedModelSpec {
  if (!spec.fast) {
    return spec;
  }
  const fallback = FAST_MODE_FALLBACKS[spec.model];
  if (!fallback) {
    return spec;
  }
  return { ...spec, model: fallback };
}

export function resolveModelSpec(spec: string): ResolvedModelSpec {
  return applyFastModeFallbacks(resolveModelSpecRaw(spec));
}

function resolveModelSpecRaw(spec: string): ResolvedModelSpec {
  let trimmed = spec.trim();
  if (!trimmed) {
    throw new Error('Model spec must be provided');
  }

  // '.' prefix enables fast mode (e.g. '.o+' -> 'o+' with fast=true)
  let fast = false;
  if (trimmed.startsWith('.')) {
    fast = true;
    trimmed = trimmed.slice(1);
  }

  const parts = trimmed.split(':');

  // Check if last part is 'fast'
  if (parts.length > 1 && parts[parts.length - 1].trim().toLowerCase() === 'fast') {
    fast = true;
    parts.pop();
  }

  if (parts.length === 1) {
    const alias = MODELS[trimmed];
    if (alias) {
      if (alias.includes(':')) {
        const resolved = resolveModelSpecRaw(alias);
        resolved.fast = resolved.fast || fast;
        return resolved;
      }
      const vendor = inferVendor(alias);
      return { model: alias, vendor, thinking: 'auto', fast };
    }
    const vendor = inferVendor(trimmed);
    return { model: trimmed, vendor, thinking: 'auto', fast };
  }

  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      `Expected "vendor:model" or "vendor:model:thinking", got "${spec}"`,
    );
  }

  const [vendorRaw, modelRaw, thinkingRaw] = parts as [string, string, string | undefined];
  const vendor = vendorRaw.trim().toLowerCase() as Vendor;
  if (!SUPPORTED_VENDORS.has(vendor)) {
    throw new Error(`Unsupported vendor: ${vendorRaw}`);
  }

  const modelValue = modelRaw.trim();
  if (!modelValue) {
    throw new Error('Model name must be provided after vendor');
  }

  let model = modelValue;
  let aliasThinking: ThinkingLevel | undefined;
  if (MODELS[modelValue]) {
    const aliasSpec = resolveModelSpecRaw(MODELS[modelValue]);
    if (aliasSpec.vendor !== vendor) {
      throw new Error(
        `Model alias "${modelValue}" belongs to vendor "${aliasSpec.vendor}", not "${vendorRaw}"`,
      );
    }
    model = aliasSpec.model;
    aliasThinking = aliasSpec.thinking;
  }

  let thinking: ThinkingLevel = 'auto';
  if (thinkingRaw) {
    const normalized = thinkingRaw.trim().toLowerCase();
    if (!['none', 'low', 'medium', 'high', 'max', 'auto'].includes(normalized)) {
      throw new Error(
        `Unsupported thinking budget "${thinkingRaw}", expected one of none|low|medium|high|max|auto`,
      );
    }
    thinking = normalized as ThinkingLevel;
  } else if (aliasThinking) {
    thinking = aliasThinking;
  }

  return { vendor, model, thinking, fast };
}

function mapThinkingToOpenAI(
  model: string,
  thinking: ThinkingLevel,
): VendorConfig['openai'] | undefined {
  if (!model.startsWith('gpt') && !model.startsWith('o')) {
    return undefined;
  }
  if (thinking === 'none' || thinking === 'auto') {
    return undefined;
  }
  const effort = thinking === 'low'
    ? 'low'
    : thinking === 'medium'
      ? 'medium'
      : 'high';
  return { reasoning: { effort } };
}

// Maps thinking level to Anthropic thinking config
function mapThinkingToAnthropic(
  thinking: ThinkingLevel,
): VendorConfig['anthropic'] | undefined {
  if (thinking === 'none') {
    return { thinking: { type: 'disabled' as const } };
  }
  const effort = thinking === 'low'
    ? 'low' as const
    : thinking === 'medium'
      ? 'medium' as const
      : thinking === 'high'
        ? 'high' as const
        : thinking === 'max'
          ? 'max' as const
          : 'medium' as const; // auto -> medium
  return {
    thinking: { type: 'adaptive' as const },
    effort,
  };
}

function mapThinkingToGoogle(
  model: string,
  thinking: ThinkingLevel,
): VendorConfig['google'] | undefined {
  const baseConfig = {
    maxOutputTokens: 65536,
  };
  if (thinking === 'none') {
    return {
      config: {
        ...baseConfig,
        thinkingConfig: {
          includeThoughts: false,
        },
      },
    };
  }
  if (thinking === 'auto') {
    return {
      config: {
        ...baseConfig,
        thinkingConfig: {
          includeThoughts: true,
        },
      },
    };
  }
  const level: 'low' | 'high' = thinking === 'low' ? 'low' : 'high';
  const budget = thinking === 'low' ? 2048 : thinking === 'medium' ? 4096 : 8192;
  const modelName = model.toLowerCase();
  const prefersBudget = modelName.includes('gemini-2.5');
  return {
    config: {
      ...baseConfig,
      thinkingConfig: {
        includeThoughts: true,
        ...(prefersBudget ? { thinkingBudget: budget } : { thinkingLevel: level }),
      },
    },
  };
}

function buildVendorConfig(vendor: Vendor, model: string, thinking: ThinkingLevel): VendorConfig {
  const cfg: VendorConfig = {};

  if (vendor === 'openai' || vendor === 'openrouter') {
    const reasoning = mapThinkingToOpenAI(model, thinking);
    if (reasoning) {
      cfg.openai = reasoning;
    }
  }

  const anthropic = mapThinkingToAnthropic(thinking);
  if (vendor === 'anthropic' && anthropic) {
    cfg.anthropic = anthropic;
  }

  const google = mapThinkingToGoogle(model, thinking);
  if (vendor === 'google' && google) {
    cfg.google = google;
  }

  return cfg;
}

export async function AskAI(modelSpec: string): Promise<ChatInstance> {
  const resolved = resolveModelSpec(modelSpec);
  const vendorConfig = buildVendorConfig(resolved.vendor, resolved.model, resolved.thinking);

  if (resolved.vendor === 'openai' || resolved.vendor === 'openrouter') {
    const useCerebras = resolved.vendor === 'openai' && CEREBRAS_MODELS.has(resolved.model);
    const apiKey = await getToken(useCerebras ? 'cerebras' : resolved.vendor);
    const baseURL = useCerebras
      ? process.env.CEREBRAS_BASE_URL ?? 'https://api.cerebras.ai/v1'
      : resolved.vendor === 'openai'
        ? 'https://api.openai.com/v1'
        : 'https://openrouter.ai/api/v1';
    return new OpenAIChat(
      apiKey,
      baseURL,
      resolved.model,
      resolved.vendor,
      vendorConfig,
      resolved.fast,
    );
  }

  if (resolved.vendor === 'anthropic') {
    const apiKey = await getToken(resolved.vendor);
    return new AnthropicChat(apiKey, resolved.model, vendorConfig, resolved.fast);
  }

  if (resolved.vendor === 'google') {
    const apiKey = await getToken(resolved.vendor);
    return new GoogleChat(apiKey, resolved.model, vendorConfig);
  }

  if (resolved.vendor === 'xai') {
    const apiKey = await getToken(resolved.vendor);
    return new XAIChat(apiKey, resolved.model, vendorConfig);
  }

  if (resolved.vendor === 'vast') {
    const baseURL = process.env.VAST_BASE_URL ?? 'http://localhost:30000/v1';
    return new VastChat(baseURL, resolved.model, vendorConfig);
  }

  if (resolved.vendor === 'fireworks') {
    const apiKey = await getToken(resolved.vendor);
    return new FireworksChat(apiKey, resolved.model, vendorConfig);
  }

  throw new Error(`Unsupported vendor: ${resolved.vendor}`);
}

export function tokenCount(text: string): number {
  return countTokens(text);
}
