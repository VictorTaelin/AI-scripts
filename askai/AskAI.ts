import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AnthropicChat } from './Vendors/Anthropic';
import { GoogleChat } from './Vendors/Google';
import { OpenAIChat, OPENAI_PRO_SUFFIX } from './Vendors/OpenAI';
import { XAIChat } from './Vendors/xai';
import { VastChat } from './Vendors/Vast';
import { FireworksChat } from './Vendors/Fireworks';
import { FusionChat, FusionMember } from './Vendors/Fusion';
import { countTokens } from 'gpt-tokenizer/model/gpt-4o';

export const MODELS: Record<string, string> = {
  // OpenAI GPT-6 Astra (flagship; 1.05M context, 128k output). Reasoning
  // effort accepts low|medium|high|xhigh|max ('none'/'minimal' are rejected;
  // 'none' here omits the field, leaving the server default).
  'g--': 'openai:gpt-6-astra:none',
  'g-' : 'openai:gpt-6-astra:low',
  'g'  : 'openai:gpt-6-astra:medium',
  'g+' : 'openai:gpt-6-astra:xhigh',
  'g++': 'openai:gpt-6-astra:max',
  'G'  : 'openai:gpt-6-astra:xhigh',

  // 'p' aliases: GPT-6 Astra in 'pro' mode (reasoning.mode='pro'). Not a
  // separate model — same gpt-6-astra, higher-quality answers on hard tasks.
  'p'  : 'openai:gpt-6-astra-pro:medium',
  'p+' : 'openai:gpt-6-astra-pro:high',
  'p++': 'openai:gpt-6-astra-pro:xhigh',
  'P'  : 'openai:gpt-6-astra-pro:xhigh',

  // GPT-5.6 tiers below Astra: Sol (previous flagship, no alias; use
  // 'openai:gpt-5.6-sol:<effort>'), Terra (balanced), Luna (cheapest).
  't-' : 'openai:gpt-5.6-terra:low',
  't'  : 'openai:gpt-5.6-terra:medium',
  't+' : 'openai:gpt-5.6-terra:xhigh',
  'T'  : 'openai:gpt-5.6-terra:xhigh',

  // GPT-5.6 Luna (fastest, cheapest)
  'l-' : 'openai:gpt-5.6-luna:low',
  'l'  : 'openai:gpt-5.6-luna:medium',
  'l+' : 'openai:gpt-5.6-luna:xhigh',
  'L'  : 'openai:gpt-5.6-luna:xhigh',

  // Anthropic Claude
  's--' : 'anthropic:claude-sonnet-5:none',
  's-'  : 'anthropic:claude-sonnet-5:low',
  's'   : 'anthropic:claude-sonnet-5:medium',
  's+'  : 'anthropic:claude-sonnet-5:high',
  's++' : 'anthropic:claude-sonnet-5:max',
  'S'   : 'anthropic:claude-sonnet-5:high',

  'o--' : 'anthropic:claude-opus-5-5:low',
  'o-'  : 'anthropic:claude-opus-5-5:low',
  'o'   : 'anthropic:claude-opus-5-5:medium',
  'o+'  : 'anthropic:claude-opus-5-5:high',
  'o++' : 'anthropic:claude-opus-5-5:xhigh',
  'O'   : 'anthropic:claude-opus-5-5:high',

  // Anthropic Claude Fable 5.1 (adaptive thinking always on)
  'f--' : 'anthropic:claude-fable-5-1:low',
  'f-'  : 'anthropic:claude-fable-5-1:low',
  'f'   : 'anthropic:claude-fable-5-1:medium',
  'f+'  : 'anthropic:claude-fable-5-1:high',
  'f++' : 'anthropic:claude-fable-5-1:xhigh',
  'F'   : 'anthropic:claude-fable-5-1:high',

  // Google Gemini
  'i-' : 'google:gemini-3.1-pro-preview:low',
  'i'  : 'google:gemini-3.1-pro-preview:medium',
  'i+' : 'google:gemini-3.1-pro-preview:high',
  'I'  : 'google:gemini-3.1-pro-preview:high',

  // xAI Grok
  'x-' : 'xai:grok-4-0709:low',
  'x'  : 'xai:grok-4-0709:medium',
  'X'  : 'xai:grok-4-0709:high',

  // Self-hosted
  'm'  : 'vast:/root/model:none',

  // Qwen3.8-27B-Uncensored (JonathanColetti abliteration, Q4_K_M) served by
  // llama.cpp with MTP on rtx (4090). The Vast B200 BF16 box (instance
  // 47762611, stopped) can take over via QWEN_BASE_URL when resumed.
  // Thinking maps to reasoning_effort (low|medium|xhigh; model default is
  // xhigh); 'none' disables thinking.
  'q--': 'local:Qwen/Qwen3.8-27B:none',
  'q-' : 'local:Qwen/Qwen3.8-27B:low',
  'q'  : 'local:Qwen/Qwen3.8-27B:medium',
  'q+' : 'local:Qwen/Qwen3.8-27B:xhigh',
  'Q'  : 'local:Qwen/Qwen3.8-27B:xhigh',

  // Z.ai official GLM-X Preview (OpenAI-compatible, api.z.ai). Always reasons
  // (thinking can't be disabled); reasoning_effort accepts low|high|max only.
  'z-' : 'zai:GLM-X-Preview-G:low',
  'z'  : 'zai:GLM-X-Preview-G:high',
  'z+' : 'zai:GLM-X-Preview-G:max',
  'Z'  : 'zai:GLM-X-Preview-G:max',

  // Gemma 4 31B dense served with the DFlash drafter on Vast.ai B200.
  'v'  : 'vast:google/gemma-4-31B-it:none',

  // DeepSeek V4.1 Flash on DeepSeek's official API (1M context, 384K output).
  // Thinking is on by default at effort high; 'none' disables it, and the
  // effort rungs are low|high|max (medium/xhigh clamp to high). V4 Pro stays
  // reachable as 'deepseek:deepseek-v4-pro:<effort>'.
  'd--': 'deepseek:deepseek-flash:none',
  'd-' : 'deepseek:deepseek-flash:low',
  'd'  : 'deepseek:deepseek-flash:high',
  'd+' : 'deepseek:deepseek-flash:max',
  'D'  : 'deepseek:deepseek-flash:max',

  // Wafer (Z.ai GLM-X Preview, OpenAI-compatible serverless)
  'w'  : 'wafer:GLM-X-Preview-G:low',
  'W'  : 'wafer:GLM-X-Preview-G:high',

  // Ox Alpha, a stealth coding/agentic model on OpenRouter (1M context, 128k
  // output). It always reasons; reasoning_effort accepts low|high|max only,
  // and defaults to max.
  'a-' : 'openrouter:stealth/ox-alpha:low',
  'a'  : 'openrouter:stealth/ox-alpha:high',
  'a+' : 'openrouter:stealth/ox-alpha:max',
  'A'  : 'openrouter:stealth/ox-alpha:max',

  // Sakana Fugu (multi-agent orchestration, OpenAI-compatible)
  'u'  : 'sakana:fugu',
  'U'  : 'sakana:fugu-ultra',
};

export type Vendor = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'xai' | 'vast' | 'local' | 'fireworks' | 'deepseek' | 'zai' | 'wafer' | 'sakana' | 'fusion';
export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

export interface ResolvedModelSpec {
  vendor: Vendor;
  model: string;
  thinking: ThinkingLevel;
  // speed tier: 0 = standard, 1 = fast, 2 = ultrafast (one per leading '.')
  fast: number;
}

export interface VendorConfig {
  openai?: {
    reasoning?: {
      // 'max' is the top rung on GPT-6 Astra, the gpt-5.6 family and Ox Alpha.
      effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      // OpenAI 'pro' mode: higher-quality answers on the same model, set via
      // a '-pro' suffix on the alias (e.g. gpt-6-astra-pro). Not a separate model.
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
  // DeepSeek-style thinking control, shared by DeepSeek's official API and
  // GLM (Z.ai official and Wafer resale): `thinking.type` toggles it and
  // reasoning_effort accepts low|high|max. GLM-X Preview always reasons
  // (never send `type: 'disabled'` there) and defaults to max; DeepSeek
  // defaults to high.
  deepseek?: {
    thinking?: { type: 'enabled' | 'disabled' };
    reasoning_effort?: 'low' | 'high' | 'max';
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
  // Anthropic prompt caching (default: enabled). Set false to disable.
  cacheable?: boolean;
  // Anthropic cache entry lifetime (default '1h').
  cache_ttl?: '5m' | '1h';
  // Char offsets into the outgoing user message that deserve cache
  // breakpoints (scheme note in Vendors/Anthropic.ts). The largest is the
  // stable|volatile seam and gets an exact chunk boundary; the others snap
  // to the content-defined boundary at or before them, so breakpoints stay
  // findable across runs whose cut offsets differ. Other vendors ignore
  // this (OpenAI/etc cache prefixes automatically).
  cache_cuts?: number[];
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

const SUPPORTED_VENDORS = new Set<Vendor>(['openai', 'anthropic', 'google', 'openrouter', 'xai', 'vast', 'local', 'fireworks', 'deepseek', 'zai', 'wafer', 'sakana', 'fusion']);

// ---------------------------------------------------------------------------
// Fusion panels
// ---------------------------------------------------------------------------
// A panel fans a prompt out to several models in parallel (no tools), then a
// synthesizer model combines their answers into a final one. Each agent has a
// hardcoded nickname + description that is shown to the synthesizer so it can
// weigh each answer against that agent's known strengths and weaknesses.

interface PanelAgent {
  spec: string;
  label: string; // short stream prefix, e.g. "GPT-6-Astra"
  nick: string; // synthesizer-facing nickname, e.g. "Fox"
  desc: string;
}

interface PanelDef {
  members: PanelAgent[];
  synth: { spec: string; label: string };
}

const AGENT_FOX: PanelAgent = {
  spec: 'openai:gpt-6-astra:high',
  label: 'GPT-6-Astra',
  nick: 'Fox',
  desc: "Most intelligent. Very careful. Spots edge cases. Produces the most correct code. Bad at following style conventions. Rarely delivers half-done work, but has a bad tendency to over-engineer and bloat the codebase with unnecessary functions, which is very harmful. Has trouble grasping intent and will often read the prompt too literally, misunderstanding it and working on the wrong thing. Tendency to reward hack, specially if there are loopholes in the prompt. Not familiar with the domain, which may affect performance. When it understands the request, its code is the most trustworthy, but almost always requires a format and style pass.",
};

const AGENT_PEPPY: PanelAgent = {
  spec: 'anthropic:claude-opus-5-5:high',
  label: 'Opus-5.5',
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
  // 'b' / 'board' / 'Board': Gemini 3.1 Pro + GPT-6 Astra + Opus 5 as the panel,
  // with Opus 5 itself as the synthesizer.
  board: {
    members: [AGENT_SLIPPY, AGENT_FOX, AGENT_PEPPY],
    synth: { spec: 'anthropic:claude-opus-5-5:high', label: 'Opus-5.5' },
  },
};

// Panel aliases support the same +/- thinking modifiers as model aliases.
// The chosen level is applied to every panel member AND the synthesizer; each
// vendor then clamps it to what it actually supports (e.g. Gemini -> low/high).
// Default (bare 'b'/'board') is 'high'.
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

// Rewrites a "vendor:model:thinking" spec with a new thinking level and speed
// tier, so a panel-wide modifier (e.g. 'b+') overrides each member's default.
function overrideSpec(spec: string, thinking: ThinkingLevel, fast: number): string {
  const [vendor, model] = spec.split(':');
  return `${'.'.repeat(fast)}${vendor}:${model}:${thinking}`;
}

async function buildFusionChat(
  panelName: string,
  thinking: ThinkingLevel,
  fast: number,
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
  if (normalized.startsWith('glm')) {
    return 'zai';
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

  // Each leading '.' raises the speed tier (e.g. '.o+' -> fast, '..g' -> ultrafast)
  let fast = 0;
  while (trimmed.startsWith('.')) {
    fast++;
    trimmed = trimmed.slice(1);
  }

  const parts = trimmed.split(':');

  // Check if last part is 'fast'
  if (parts.length > 1 && parts[parts.length - 1].trim().toLowerCase() === 'fast') {
    fast = Math.max(fast, 1);
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
        resolved.fast = Math.max(resolved.fast, fast);
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
  // 'xhigh' and 'max' are real, distinct effort levels on GPT-6 Astra and the
  // gpt-5.6 family, so they pass through unchanged.
  const effort = thinking === 'low'
    ? 'low'
    : thinking === 'medium'
      ? 'medium'
      : thinking === 'xhigh' || thinking === 'max'
        ? thinking
        : 'high';
  // A '-pro' suffix (e.g. gpt-6-astra-pro) requests OpenAI's 'pro' reasoning
  // mode. It is not a distinct model; the vendor strips the suffix before the
  // API call and we pass reasoning.mode='pro' alongside the effort.
  const mode = OPENAI_PRO_SUFFIX.test(model) ? { mode: 'pro' as const } : {};
  return { reasoning: { effort, ...mode } };
}

// Effort ladder for models that always reason and accept only low|high|max
// (GLM-X Preview on Z.ai/Wafer, Ox Alpha on OpenRouter). 'none' falls to the
// lightest rung, because these models cannot stop thinking.
function effortLowHighMax(thinking: ThinkingLevel): 'low' | 'high' | 'max' {
  if (thinking === 'none' || thinking === 'low') {
    return 'low';
  }
  if (thinking === 'medium' || thinking === 'high') {
    return 'high';
  }
  return 'max'; // xhigh | max
}

// OpenRouter uses OpenAI's `reasoning: { effort }` shape, but each model has
// its own rungs. Ox Alpha accepts low|high|max only (server default: max);
// every other OpenRouter model keeps the OpenAI ladder.
function mapThinkingToOpenRouter(
  model: string,
  thinking: ThinkingLevel,
): VendorConfig['openai'] | undefined {
  if (!model.toLowerCase().includes('ox-alpha')) {
    return mapThinkingToOpenAI(model, thinking);
  }
  if (thinking === 'auto') {
    return undefined;
  }
  return { reasoning: { effort: effortLowHighMax(thinking) } };
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

function mapThinkingToDeepSeek(
  thinking: ThinkingLevel,
  canDisable: boolean,
): VendorConfig['deepseek'] {
  // 'none' disables thinking where the model allows it (DeepSeek); GLM-X
  // Preview cannot stop, so there it falls to the lightest effort. 'auto'
  // omits effort (server default). Internal levels clamp to low|high|max.
  if (thinking === 'none' && canDisable) {
    return { thinking: { type: 'disabled' } };
  }
  if (thinking === 'auto') {
    return { thinking: { type: 'enabled' } };
  }
  return { thinking: { type: 'enabled' }, reasoning_effort: effortLowHighMax(thinking) };
}

function mapThinkingToVast(
  model: string,
  thinking: ThinkingLevel,
): VendorConfig['vast'] | undefined {
  const modelName = model.toLowerCase();
  // Qwen3.8: thinking is on by default at reasoning_effort=xhigh, which burns
  // 15k-100k+ reasoning tokens per turn. Map levels to the model's own
  // low|medium|xhigh rungs ('high' aliases xhigh server-side); 'none' turns
  // thinking off entirely. 'auto' omits the kwarg (server default: xhigh).
  if (modelName.includes('qwen3.8')) {
    if (thinking === 'none') {
      return { chat_template_kwargs: { enable_thinking: false } };
    }
    if (thinking === 'auto') {
      return undefined;
    }
    const effort = thinking === 'low' ? 'low' : thinking === 'medium' ? 'medium' : 'xhigh';
    return { chat_template_kwargs: { reasoning_effort: effort } };
  }
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

  if (vendor === 'openai' || vendor === 'openrouter') {
    const reasoning = vendor === 'openrouter'
      ? mapThinkingToOpenRouter(model, thinking)
      : mapThinkingToOpenAI(model, thinking);
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

  if (vendor === 'deepseek' || vendor === 'zai' || vendor === 'wafer') {
    cfg.deepseek = mapThinkingToDeepSeek(thinking, vendor === 'deepseek');
  }

  return cfg;
}

export async function AskAI(modelSpec: string): Promise<ChatInstance> {
  const resolved = resolveModelSpec(modelSpec);

  if (resolved.vendor === 'fusion') {
    return buildFusionChat(resolved.model, resolved.thinking, resolved.fast);
  }

  const vendorConfig = buildVendorConfig(resolved.vendor, resolved.model, resolved.thinking);

  if (resolved.vendor === 'openai' || resolved.vendor === 'openrouter' || resolved.vendor === 'deepseek' || resolved.vendor === 'zai' || resolved.vendor === 'wafer' || resolved.vendor === 'sakana') {
    const useCerebras = resolved.vendor === 'openai' && CEREBRAS_MODELS.has(resolved.model);
    const apiKey = await getToken(useCerebras ? 'cerebras' : resolved.vendor);
    const baseURL = useCerebras
      ? process.env.CEREBRAS_BASE_URL ?? 'https://api.cerebras.ai/v1'
      : resolved.vendor === 'deepseek'
        ? 'https://api.deepseek.com'
        : resolved.vendor === 'zai'
          ? process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/paas/v4'
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
    return new AnthropicChat(apiKey, resolved.model, vendorConfig, resolved.fast > 0);
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
    const isGemma = modelName.includes('gemma-4');
    const baseURL = isGemma
      ? (process.env.GEMMA_BASE_URL ?? process.env.VAST_GEMMA_BASE_URL ?? 'http://44.227.210.72:42458/v1')
      : (process.env.VAST_BASE_URL ?? 'http://localhost:30000/v1');
    return new VastChat(baseURL, resolved.model, vendorConfig);
  }

  if (resolved.vendor === 'local') {
    // Local OpenAI-compatible servers (Taelin's own machines).
    const modelName = resolved.model.toLowerCase();
    // Qwen3.8-27B-Uncensored on rtx (4090, llama.cpp, Tailscale). TLS with a
    // local CA (trust it via NODE_EXTRA_CA_CERTS=~/.config/qwen_ca.pem, set in
    // .zshrc) + API key at ~/.config/qwen.token. QWEN_BASE_URL overrides
    // (e.g. to the resumed Vast B200).
    const isQwen = modelName.includes('qwen3.8') || modelName.includes('qwen3.6');
    const isGemma = modelName.includes('gemma4') || modelName.includes('gemma-4');
    const baseURL = isQwen
      ? (process.env.QWEN_BASE_URL ?? 'https://100.90.75.65:18080/v1')
      : isGemma
        ? (process.env.GEMMA_CLUSTER_BASE_URL
          ?? process.env.LOCAL_GEMMA_BASE_URL
          ?? 'http://127.0.0.1:9379/v1')
        : (process.env.LOCAL_OPENAI_BASE_URL ?? 'http://127.0.0.1:18080/v1');
    let apiKey: string | undefined;
    if (isQwen) {
      try { apiKey = (await fs.readFile(path.join(os.homedir(), '.config', 'qwen.token'), 'utf8')).trim(); }
      catch {}
    }
    return new VastChat(baseURL, resolved.model, vendorConfig, apiKey);
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
