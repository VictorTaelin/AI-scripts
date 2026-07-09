import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AnthropicChat } from './Vendors/Anthropic';
import { GoogleChat } from './Vendors/Google';
import { OpenAIChat } from './Vendors/OpenAI';
import { XAIChat } from './Vendors/xai';
import { VastChat } from './Vendors/Vast';
import { FireworksChat } from './Vendors/Fireworks';
import { FusionChat, FusionMember } from './Vendors/Fusion';
import { countTokens } from 'gpt-tokenizer/model/gpt-4o';

export const MODELS: Record<string, string> = {
  // OpenAI GPT-5.6 family: Sol (flagship), Terra (balanced), Luna (cheapest).
  // 'gpt-5.6' is an alias for gpt-5.6-sol; there is no more gpt-5.x-pro.
  'g--': 'openai:gpt-5.6-sol:none',
  'g-' : 'openai:gpt-5.6-sol:low',
  'g'  : 'openai:gpt-5.6-sol:medium',
  'g+' : 'openai:gpt-5.6-sol:xhigh',
  'G'  : 'openai:gpt-5.6-sol:xhigh',

  // 'p' aliases: GPT-5.6 Sol in 'pro' mode (reasoning.mode='pro'). Not a
  // separate model — same gpt-5.6-sol, higher-quality answers on hard tasks.
  'p'  : 'openai:gpt-5.6-sol-pro:medium',
  'p+' : 'openai:gpt-5.6-sol-pro:high',
  'p++': 'openai:gpt-5.6-sol-pro:xhigh',
  'P'  : 'openai:gpt-5.6-sol-pro:xhigh',

  // GPT-5.6 Terra (balanced, ~5.5-level quality at ~2x lower cost)
  't-' : 'openai:gpt-5.6-terra:low',
  't'  : 'openai:gpt-5.6-terra:medium',
  't+' : 'openai:gpt-5.6-terra:xhigh',
  'T'  : 'openai:gpt-5.6-terra:xhigh',

  // GPT-5.6 Luna (fastest, cheapest)
  'n-' : 'openai:gpt-5.6-luna:low',
  'n'  : 'openai:gpt-5.6-luna:medium',
  'n+' : 'openai:gpt-5.6-luna:xhigh',
  'N'  : 'openai:gpt-5.6-luna:xhigh',

  // Anthropic Claude
  's--' : 'anthropic:claude-sonnet-5:none',
  's-'  : 'anthropic:claude-sonnet-5:low',
  's'   : 'anthropic:claude-sonnet-5:medium',
  's+'  : 'anthropic:claude-sonnet-5:high',
  's++' : 'anthropic:claude-sonnet-5:max',
  'S'   : 'anthropic:claude-sonnet-5:high',

  'o--' : 'anthropic:claude-opus-4-8:none',
  'o-'  : 'anthropic:claude-opus-4-8:low',
  'o'   : 'anthropic:claude-opus-4-8:medium',
  'o+'  : 'anthropic:claude-opus-4-8:high',
  'o++' : 'anthropic:claude-opus-4-8:max',
  'O'   : 'anthropic:claude-opus-4-8:high',

  // Anthropic Claude Fable 5 (adaptive thinking always on)
  'f--' : 'anthropic:claude-fable-5:none',
  'f-'  : 'anthropic:claude-fable-5:low',
  'f'   : 'anthropic:claude-fable-5:medium',
  'f+'  : 'anthropic:claude-fable-5:high',
  'f++' : 'anthropic:claude-fable-5:max',
  'F'   : 'anthropic:claude-fable-5:high',

  // Google Gemini
  'i-' : 'google:gemini-3.1-pro-preview:low',
  'i'  : 'google:gemini-3.1-pro-preview:medium',
  'i+' : 'google:gemini-3.1-pro-preview:high',
  'I'  : 'google:gemini-3.1-pro-preview:high',
  'l-' : 'google:gemini-3.1-flash-lite-preview:low',
  'l'  : 'google:gemini-3.1-flash-lite-preview:medium',
  'l+' : 'google:gemini-3.1-flash-lite-preview:high',
  'L'  : 'google:gemini-3.1-flash-lite-preview:high',

  // xAI Grok
  'x-' : 'xai:grok-4-0709:low',
  'x'  : 'xai:grok-4-0709:medium',
  'X'  : 'xai:grok-4-0709:high',

  // Self-hosted
  'm'  : 'vast:/root/model:none',
  // Qwen3.6-35B-A3B IQ3_S GGUF served by llama.cpp on ssh mini.
  'q'  : 'local:Qwen3.6-35B-A3B-IQ3S:none',

  // Gemma 4 12B QAT Q4_0 served by llama.cpp on cluster-81.
  'z-' : 'local:gemma-4-12b-it-qat-q4_0.gguf:none',
  'z'  : 'local:gemma-4-12b-it-qat-q4_0.gguf:none',
  'z+' : 'local:gemma-4-12b-it-qat-q4_0.gguf:high',

  // Gemma 4 31B dense served with the DFlash drafter on Vast.ai B200.
  'v'  : 'vast:google/gemma-4-31B-it:none',

  // DeepSeek
  'd-' : 'deepseek:deepseek-v4-pro:low',
  'd'  : 'deepseek:deepseek-v4-pro:medium',
  'd+' : 'deepseek:deepseek-v4-pro:high',
  'D'  : 'deepseek:deepseek-v4-pro:high',

  // Wafer (Z.ai GLM-5.2, OpenAI-compatible serverless)
  'w'  : 'wafer:GLM-5.2:low',
  'W'  : 'wafer:GLM-5.2:high',

  // Sakana Fugu (multi-agent orchestration, OpenAI-compatible)
  'u'  : 'sakana:fugu',
  'U'  : 'sakana:fugu-ultra',
};

export type Vendor = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'xai' | 'vast' | 'local' | 'fireworks' | 'deepseek' | 'wafer' | 'sakana' | 'fusion';
export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

export interface ResolvedModelSpec {
  vendor: Vendor;
  model: string;
  thinking: ThinkingLevel;
  fast: boolean;
}

export interface VendorConfig {
  openai?: {
    reasoning?: {
      effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
      // GPT-5.6 'pro' mode: higher-quality answers on the same model, set via
      // a '-pro' suffix on the alias (e.g. gpt-5.6-sol-pro). Not a separate model.
      mode?: 'pro';
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
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  vast?: {
    chat_template_kwargs?: Record<string, any>;
  };
  // Wafer / Z.ai GLM thinking control: GLM uses a `thinking` object to toggle
  // reasoning, and `reasoning_effort` to grade it (only honored when enabled).
  wafer?: {
    thinking?: { type: 'enabled' | 'disabled' };
    reasoning_effort?: 'low' | 'medium' | 'high';
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
  // Anthropic prompt caching (default: enabled). Set false to disable.
  cacheable?: boolean;
  vendorConfig?: VendorConfig;
  // Streaming sink. When set, vendors route streamed deltas to this callback
  // instead of writing to process.stdout. Used by Fusion to interleave the
  // output of several panel models into readable, per-model IRC-style lines.
  // `kind` is 'reasoning' for thinking traces and 'text' for the answer body.
  onStream?: (chunk: string, kind: StreamKind) => void;
}

export type StreamKind = 'reasoning' | 'text';

export interface AskToolsOptions extends AskOptions {
  tools: ToolDef[];
}

export interface ChatInstance {
  ask(userMessage: string | null, options: AskOptions): Promise<string | { messages: any[] }>;
  askTools(userMessage: string, options: AskToolsOptions): Promise<AskResult>;
}

const SUPPORTED_VENDORS = new Set<Vendor>(['openai', 'anthropic', 'google', 'openrouter', 'xai', 'vast', 'local', 'fireworks', 'deepseek', 'wafer', 'sakana', 'fusion']);

// ---------------------------------------------------------------------------
// Fusion panels
// ---------------------------------------------------------------------------
// A panel fans a prompt out to several models in parallel (no tools), then a
// synthesizer model combines their answers into a final one. Each agent has a
// hardcoded nickname + description that is shown to the synthesizer so it can
// weigh each answer against that agent's known strengths and weaknesses.

interface PanelAgent {
  spec: string;
  label: string; // short stream prefix, e.g. "GPT-5.6"
  nick: string; // synthesizer-facing nickname, e.g. "Fox"
  desc: string;
}

interface PanelDef {
  members: PanelAgent[];
  synth: { spec: string; label: string };
}

const AGENT_FOX: PanelAgent = {
  spec: 'openai:gpt-5.6-sol:high',
  label: 'GPT-5.6-Sol',
  nick: 'Fox',
  desc: "Most intelligent. Very careful. Spots edge cases. Produces the most correct code. Bad at following style conventions. Rarely delivers half-done work, but has a bad tendency to over-engineer and bloat the codebase with unnecessary functions, which is very harmful. Has trouble grasping intent and will often read the prompt too literally, misunderstanding it and working on the wrong thing. Tendency to reward hack, specially if there are loopholes in the prompt. Not familiar with the domain, which may affect performance. When it understands the request, its code is the most trustworthy, but almost always requires a format and style pass.",
};

const AGENT_PEPPY: PanelAgent = {
  spec: 'anthropic:claude-opus-4-8:high',
  label: 'Opus-4.8',
  nick: 'Peppy',
  desc: "Most productive and honest. Very good at understanding intent and following instructions. Best at style adherence and sticking to the format, which is very important. Familiar with the author's work, which causes it to occasionally outperform, specially when related to HVM, Interaction Calculus, Bend. Has a hard time understanding hard concepts and complex logic. Lazy and will often deliver work half-done, or without properly checking references, or double-checking every case. This often leads to bugs.",
};

const AGENT_SLIPPY: PanelAgent = {
  spec: 'google:gemini-3.1-pro-preview:high',
  label: 'Gemini-3.1-Pro',
  nick: 'Slippy',
  desc: "Most generally knowledgeable, but struggles to follow instructions. Extremely inconsistent. Has the highest highs, but the lowest lows. Will sometimes nail the task. Other times, it doesn't even understand the assignment. Should be consulted for diversity and inspiration, but considered a secondary contributor.",
};

const PANELS: Record<string, PanelDef> = {
  // 'b' / 'board' / 'Board': Gemini 3.1 Pro + GPT-5.6 Sol + Opus 4.8 as the panel,
  // with Opus 4.8 itself as the synthesizer.
  board: {
    members: [AGENT_SLIPPY, AGENT_FOX, AGENT_PEPPY],
    synth: { spec: 'anthropic:claude-opus-4-8:high', label: 'Opus-4.8' },
  },
};

// Panel aliases support the same +/- thinking modifiers as model aliases.
// The chosen level is applied to every panel member AND the synthesizer; each
// vendor then clamps it to what it actually supports (e.g. Gemini -> low/high,
// OpenAI 'max' -> 'xhigh'). Default (bare 'b'/'board') is 'high'.
const PANEL_ALIASES: Record<string, { panel: string; thinking: ThinkingLevel }> = {
  'b--':   { panel: 'board', thinking: 'low' },
  'b-':    { panel: 'board', thinking: 'medium' },
  'b':     { panel: 'board', thinking: 'high' },
  'b+':    { panel: 'board', thinking: 'xhigh' },
  'b++':   { panel: 'board', thinking: 'max' },
  'B':     { panel: 'board', thinking: 'xhigh' },
  'board': { panel: 'board', thinking: 'high' },
  'Board': { panel: 'board', thinking: 'high' },
};

// Rewrites a "vendor:model:thinking" spec with a new thinking level and fast
// flag, so a panel-wide modifier (e.g. 'b+') overrides each member's default.
function overrideSpec(spec: string, thinking: ThinkingLevel, fast: boolean): string {
  const [vendor, model] = spec.split(':');
  let out = `${vendor}:${model}:${thinking}`;
  if (fast) out = `.${out}`;
  return out;
}

async function buildFusionChat(
  panelName: string,
  thinking: ThinkingLevel,
  fast: boolean,
): Promise<ChatInstance> {
  const def = PANELS[panelName];
  if (!def) {
    throw new Error(`Unknown fusion panel: "${panelName}"`);
  }
  const members: FusionMember[] = [];
  for (const agent of def.members) {
    members.push({
      chat: await AskAI(overrideSpec(agent.spec, thinking, fast)),
      label: agent.label,
      nick: agent.nick,
      desc: agent.desc,
    });
  }
  const synth = {
    chat: await AskAI(overrideSpec(def.synth.spec, thinking, fast)),
    label: def.synth.label,
  };
  return new FusionChat(members, synth);
}

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
  local: [],
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
// (Opus 4.7 gained fast-mode support, so it's no longer listed here.)
const FAST_MODE_FALLBACKS: Record<string, string> = {};

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
    // Fusion panel aliases (e.g. 'b', 'b+', 'board') resolve to the pseudo-vendor
    // 'fusion'; AskAI() dispatches these to buildFusionChat(). The thinking level
    // is carried through and applied to every panel member + synthesizer.
    const panel = PANEL_ALIASES[trimmed];
    if (panel) {
      return { model: panel.panel, vendor: 'fusion', thinking: panel.thinking, fast };
    }
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
    if (!['none', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(normalized)) {
      throw new Error(
        `Unsupported thinking budget "${thinkingRaw}", expected one of none|low|medium|high|xhigh|max|auto`,
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
  // 'xhigh' is a real, distinct effort level for the gpt-5.6 family and must be
  // passed through (previously it was silently downgraded to 'high'). 'max' has
  // no OpenAI equivalent, so it maps to the strongest supported level, 'xhigh'.
  const effort = thinking === 'low'
    ? 'low'
    : thinking === 'medium'
      ? 'medium'
      : thinking === 'xhigh' || thinking === 'max'
        ? 'xhigh'
        : 'high';
  // A '-pro' suffix (e.g. gpt-5.6-sol-pro) requests OpenAI's 'pro' reasoning
  // mode. It is not a distinct model; the vendor strips the suffix before the
  // API call and we pass reasoning.mode='pro' alongside the effort.
  const mode = /^gpt-5\.6-(sol|terra|luna)-pro$/.test(model) ? { mode: 'pro' as const } : {};
  return { reasoning: { effort, ...mode } };
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
        : thinking === 'xhigh'
          ? 'xhigh' as const
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

function mapThinkingToWafer(
  thinking: ThinkingLevel,
): VendorConfig['wafer'] | undefined {
  if (thinking === 'none') {
    return { thinking: { type: 'disabled' } };
  }
  // 'auto' leaves it to the model default (thinking enabled, max effort).
  if (thinking === 'auto') {
    return { thinking: { type: 'enabled' } };
  }
  const effort: 'low' | 'medium' | 'high' =
    thinking === 'low' ? 'low' : thinking === 'medium' ? 'medium' : 'high';
  return { thinking: { type: 'enabled' }, reasoning_effort: effort };
}

function mapThinkingToVast(
  model: string,
  thinking: ThinkingLevel,
): VendorConfig['vast'] | undefined {
  const modelName = model.toLowerCase();
  if (!modelName.includes('gemma-4') && !modelName.includes('gemma4')) {
    return undefined;
  }
  return {
    chat_template_kwargs: {
      enable_thinking: thinking !== 'none',
    },
  };
}

function buildVendorConfig(vendor: Vendor, model: string, thinking: ThinkingLevel): VendorConfig {
  const cfg: VendorConfig = {};

  if (vendor === 'openai' || vendor === 'openrouter' || vendor === 'deepseek') {
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

  const vast = mapThinkingToVast(model, thinking);
  if ((vendor === 'vast' || vendor === 'local') && vast) {
    cfg.vast = vast;
  }

  const wafer = mapThinkingToWafer(thinking);
  if (vendor === 'wafer' && wafer) {
    cfg.wafer = wafer;
  }

  return cfg;
}

export async function AskAI(modelSpec: string): Promise<ChatInstance> {
  const resolved = resolveModelSpec(modelSpec);

  if (resolved.vendor === 'fusion') {
    return buildFusionChat(resolved.model, resolved.thinking, resolved.fast);
  }

  const vendorConfig = buildVendorConfig(resolved.vendor, resolved.model, resolved.thinking);

  if (resolved.vendor === 'openai' || resolved.vendor === 'openrouter' || resolved.vendor === 'deepseek' || resolved.vendor === 'wafer' || resolved.vendor === 'sakana') {
    const useCerebras = resolved.vendor === 'openai' && CEREBRAS_MODELS.has(resolved.model);
    const apiKey = await getToken(useCerebras ? 'cerebras' : resolved.vendor);
    const baseURL = useCerebras
      ? process.env.CEREBRAS_BASE_URL ?? 'https://api.cerebras.ai/v1'
      : resolved.vendor === 'deepseek'
        ? 'https://api.deepseek.com'
        : resolved.vendor === 'wafer'
          ? process.env.WAFER_BASE_URL ?? 'https://pass.wafer.ai/v1'
          : resolved.vendor === 'sakana'
            ? process.env.SAKANA_BASE_URL ?? 'https://api.sakana.ai/v1'
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
    // VastChat is also used as a generic OpenAI-compatible client, but this
    // branch is for actual Vast.ai / remote self-hosted models.
    const modelName = resolved.model.toLowerCase();
    const isQwen = modelName.includes('qwen3.6');
    const isGemma = modelName.includes('gemma-4');
    const baseURL = isQwen
      ? (process.env.QWEN_BASE_URL ?? 'http://52.32.147.192:42220/v1')
      : isGemma
        ? (process.env.GEMMA_BASE_URL ?? process.env.VAST_GEMMA_BASE_URL ?? 'http://44.227.210.72:42458/v1')
      : (process.env.VAST_BASE_URL ?? 'http://localhost:30000/v1');
    return new VastChat(baseURL, resolved.model, vendorConfig);
  }

  if (resolved.vendor === 'local') {
    // Local OpenAI-compatible servers.
    const modelName = resolved.model.toLowerCase();
    const isGemma = modelName.includes('gemma4') || modelName.includes('gemma-4');
    const baseURL = isGemma
      ? (process.env.GEMMA_CLUSTER_BASE_URL
        ?? process.env.LOCAL_GEMMA_BASE_URL
        ?? 'http://127.0.0.1:9379/v1')
      : (process.env.LOCAL_OPENAI_BASE_URL
        ?? process.env.QWEN_MINI_BASE_URL
        ?? 'http://100.100.15.51:18080/v1');
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
