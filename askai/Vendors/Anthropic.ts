import Anthropic from "@anthropic-ai/sdk";
import type {
  AskOptions,
  AskResult,
  AskToolsOptions,
  ChatInstance,
  ToolCall,
  ToolDef,
  VendorConfig,
} from "../AskAI";

type Role = "user" | "assistant";

const FALLBACK_MAX_OUTPUT_TOKENS = 128000;
// 128k is a HARD cap on the synchronous Messages API (the 300k beta is
// Batch-only), and thinking tokens count against max_tokens: Opus 5.5 can
// think past 128k on a big one-shot generation even at medium effort, and
// then emits no text at all. Two defenses:
//   1. every request with an effort carries a task budget, so the model
//      KNOWS its output room and paces its thinking (setTaskBudget);
//   2. when a response still stops with stop_reason === "max_tokens", ask()
//      feeds the partial content blocks back (signed thinking included, so
//      a thinking-only cut resumes too) and asks to continue, up to this
//      many extra rounds.
const MAX_CONTINUATION_ROUNDS = 8;
const TASK_BUDGET_BETA = "task-budgets-2026-03-13";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
// Keep this plain. A wordier prompt ("continue from EXACTLY where it
// stopped, output only the continuation, do not repeat...") after a turn
// that holds thinking trips Anthropic's anti-distillation classifier: a
// "refusal" for "reverse engineering or duplicating model outputs" (9/9
// probes, 2026-09-22; this wording 0/15).
const CONTINUE_PROMPT = "Continue your reply from where it was cut off.";
const FAST_MODE_BETA = "fast-mode-2026-02-01";
const TEXT_EDITOR_TOOL_NAME = "str_replace_based_edit_tool";
const TEXT_EDITOR_TOOL_TYPE = "text_editor_20250728";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const STREAM_END_MARKER = "☮";
const STREAM_END_INSTRUCTION = "END-OF-SEQUENCE: the final character of your entire response MUST be ☮. (IMPORTANT)";

function canUseNativeEditor(tools: ToolDef[]): boolean {
  if (tools.length === 0) {
    return false;
  }
  const names = new Set(tools.map(tool => tool.name));
  if (!names.has("str_replace")) {
    return false;
  }
  if (!names.has("create_file")) {
    return false;
  }
  return names.size === 2;
}

function hasStringField(obj: Record<string, any>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key) && typeof obj[key] === "string";
}

function normalizeTextEditorCall(block: any): ToolCall {
  const input = block?.input ?? {};
  const command = typeof input.command === "string" ? input.command : "";
  const path = typeof input.path === "string" ? input.path : "";
  if (!path) {
    throw new Error("missing text_editor path");
  }
  switch (command) {
    case "str_replace": {
      if (!hasStringField(input, "old_str")) {
        throw new Error("missing text_editor old_str");
      }
      if (!hasStringField(input, "new_str")) {
        throw new Error("missing text_editor new_str");
      }
      return {
        id: block?.id,
        name: "str_replace",
        input: {
          path,
          old_str: input.old_str,
          new_str: input.new_str,
        },
      };
    }
    case "create": {
      if (!hasStringField(input, "file_text")) {
        throw new Error("missing text_editor file_text");
      }
      return {
        id: block?.id,
        name: "create_file",
        input: {
          path,
          file_text: input.file_text,
        },
      };
    }
    default: {
      throw new Error(`unsupported text_editor command "${command || "(empty)"}"`);
    }
  }
}

function textEditorError(toolUseId: string, message: string): any {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: message,
    is_error: true,
  };
}

function appendStreamEndInstruction(systemPrompt?: string): string {
  if (!systemPrompt) {
    return STREAM_END_INSTRUCTION;
  }
  return `${systemPrompt}\n\n${STREAM_END_INSTRUCTION}`;
}

function stripTrailingMarker(text: string): string {
  return text.endsWith(STREAM_END_MARKER) ? text.slice(0, -STREAM_END_MARKER.length) : text;
}

function stripMarkerFromBlocks(blocks: any[]): any[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    block.text = stripTrailingMarker(block.text);
    break;
  }
  return blocks;
}

function createStreamMarkerState(onText: (text: string) => void) {
  let seenMarker = false;
  return {
    get seenMarker(): boolean {
      return seenMarker;
    },
    push(chunk: string): boolean {
      if (!chunk || seenMarker) {
        return seenMarker;
      }
      const markerIndex = chunk.indexOf(STREAM_END_MARKER);
      if (markerIndex === -1) {
        onText(chunk);
        return false;
      }
      onText(chunk.slice(0, markerIndex));
      seenMarker = true;
      return true;
    },
  };
}

/* ==================================================================
 * Prompt caching
 *
 * Anthropic caching facts (docs, 2026-07):
 *   - A cache entry is written ONLY where a block carries cache_control
 *     (max 4 per request); its key hashes tools + system + every block
 *     up to and including that one.
 *   - Lookup checks each breakpoint, then walks back up to 20 blocks.
 *   - Hashes are over concatenated content, so block boundaries only
 *     decide WHERE a lookup can land, not whether content matches.
 *
 * The dominant pattern in these tools is: send a huge prompt, read the
 * answer, edit the prompt near its END, send it again (holefill on a
 * 60k+ token file). A single end-of-prompt breakpoint never hits in
 * that pattern — the tail always changed — so instead we:
 *   1. split large user texts into ~1k-token blocks, cut at line
 *      boundaries chosen greedily from the START, so an unchanged
 *      beginning always yields identical blocks;
 *   2. place breakpoints at graduated depths from the end (0, 5, 15,
 *      35 blocks). Consecutive gaps stay <= 20, so the next request's
 *      lookback finds the deepest entry that precedes the edit and
 *      pays full input price only for the changed tail.
 * The depth-0 breakpoint is also the classic move-forward-each-turn
 * scheme, so multi-turn chat caches exactly as before.
 *
 * TTL defaults to 1h (write premium 2x on the newly-written tail, vs
 * 1.25x for 5m): hand-editing a large file between runs routinely
 * exceeds 5 minutes, and one surviving prefix repays many tail
 * writes. Override with AskOptions.cache_ttl.
 *
 * AskOptions.cache_cuts refines this for callers that KNOW where their
 * prompt's cacheable structure lies (holefill: the hole's offset, the
 * divergence from the previous run's prompt, and the rendered-file |
 * user-prompt seam). The largest cut is the seam: it forces a chunk
 * boundary, so an unchanged stable prefix re-hits in full. The other
 * cuts claim breakpoints at the content-defined boundary at or before
 * them, never moving a boundary: runs that share a prefix chunk it
 * identically, so one run's breakpoints sit where a later run's
 * lookup can land. Remaining slots fall back to the depth scheme.
 * ================================================================== */

const CACHE_CHUNK_CHARS = 4096;      // ~1k tokens
const CACHE_DEPTHS = [0, 5, 15, 35]; // breakpoint depths, in blocks from the end

// Cuts text into ~CACHE_CHUNK_CHARS blocks at line boundaries, scanning from
// the start so each cut depends only on the text before it (an edit near the
// end never moves earlier cuts). Newline-less stretches get a hard cut,
// nudged off UTF-16 surrogate pairs.
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let pos = 0;
  while (text.length - pos > CACHE_CHUNK_CHARS * 2) {
    let cut = text.lastIndexOf("\n", pos + CACHE_CHUNK_CHARS) + 1;
    if (cut <= pos) {
      cut = pos + CACHE_CHUNK_CHARS;
      const code = text.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
    }
    chunks.push(text.slice(pos, cut));
    pos = cut;
  }
  chunks.push(text.slice(pos));
  return chunks;
}

// Chunks a user text that carries cache cuts. The largest cut is the
// stable|volatile seam and forces a real chunk boundary there; before it,
// boundaries come from chunkText alone, so they depend only on the content,
// and two runs sharing a prefix chunk it identically. Each cut claims an
// anchor (a priority breakpoint spot) at the last chunk ending at or before
// it: a breakpoint one run writes therefore sits at a boundary a later
// run's lookup (its own cuts + the 20-block walk-back) can land on, even
// though the runs' cut offsets differ.
function chunkTextCuts(text: string, offsets: number[]): { texts: string[]; anchors: Set<number> } {
  const cuts = offsets
    .filter((off) => off > 0 && off < text.length)
    .sort((a, b) => a - b);
  if (cuts.length === 0) {
    return { texts: chunkText(text), anchors: new Set() };
  }
  const seam = cuts[cuts.length - 1];
  const texts = chunkText(text.slice(0, seam));
  for (const chunk of chunkText(text.slice(seam))) texts.push(chunk);
  const ends: number[] = [];
  let end = 0;
  for (const chunk of texts) {
    end += chunk.length;
    ends.push(end);
  }
  const anchors = new Set<number>();
  for (const off of cuts) {
    let i = -1;
    while (i + 1 < ends.length && ends[i + 1] <= off) i++;
    if (i >= 0) anchors.add(i);
  }
  return { texts, anchors };
}

// Rebuilds messages with cache_control breakpoints per the scheme above.
// Non-destructive: copies every message and block it touches. Only user text
// is chunked (assistant turns can carry signed thinking blocks; leave their
// structure alone). Anthropic ignores breakpoints below the model's minimum
// cacheable prefix, so small prompts are unaffected. `cuts` identifies the
// outgoing user message by content and forces anchored breakpoints at its
// offsets; anchors claim slots first, depths fill the rest.
function planCache(messages: any[], ttl: "5m" | "1h", cuts?: { text: string; offsets: number[] }): any[] {
  const cacheControl = { type: "ephemeral", ttl };
  const out: any[] = [];
  const spots: any[] = []; // blocks eligible for cache_control, in prompt order
  const anchorSpots: any[] = [];
  for (const msg of messages) {
    let blocks: any[];
    if (typeof msg.content === "string") {
      if (msg.role === "user" && cuts && msg.content === cuts.text) {
        const { texts, anchors } = chunkTextCuts(msg.content, cuts.offsets);
        blocks = texts.map((text) => ({ type: "text", text }));
        for (const idx of anchors) anchorSpots.push(blocks[idx]);
      } else {
        const texts = msg.role === "user" ? chunkText(msg.content) : [msg.content];
        blocks = texts.map((text) => ({ type: "text", text }));
      }
    } else if (Array.isArray(msg.content)) {
      blocks = msg.content.flatMap((block: any) =>
        msg.role === "user" && block?.type === "text" && typeof block.text === "string"
          ? chunkText(block.text).map((text) => ({ ...block, text }))
          : [{ ...block }]);
    } else {
      out.push(msg);
      continue;
    }
    for (const block of blocks) {
      const t = block?.type;
      if ((t === "text" && block.text.length > 0) ||
          t === "image" || t === "document" || t === "tool_use" || t === "tool_result") {
        spots.push(block);
      }
    }
    out.push({ ...msg, content: blocks });
  }
  let slots = 4;
  for (const spot of anchorSpots) {
    if (slots === 0) break;
    if (spot.text.length === 0) continue;
    spot.cache_control = cacheControl;
    slots--;
  }
  for (const depth of CACHE_DEPTHS) {
    if (slots === 0) break;
    const spot = spots[spots.length - 1 - depth];
    if (spot && !spot.cache_control) {
      spot.cache_control = cacheControl;
      slots--;
    }
  }
  return out;
}

// Safety classifiers on Opus 5+/Fable 5+ decline requests stochastically,
// before or mid-output, with stop_reason "refusal" (e.g. a Star Fox game
// prompt flagged "cyber" after ~95k thinking tokens, 2 of 6 runs). Every
// request sets fallbacks: "default", so the API itself reruns a declined
// request on the model Anthropic recommends for that category (Opus 5.5 ->
// Opus 5 / Opus 4.8), on the same stream, and marks the handoff with a
// "fallback" content block. A refusal that still gets through (no fallback
// for its category) is no answer, so it throws: callers must never take it
// for an empty reply (holefill would erase the hole).
function refusalError(details: any): Error {
  const why = details?.explanation ?? "the API refused this request (no explanation given)";
  return new Error(`refusal: ${why}`);
}

function printFallback(block: any): void {
  process.stderr.write(`\x1b[33m[fallback: ${block.from?.model} declined, ${block.to?.model} continues]\x1b[0m\n`);
}

// Blocks of an assistant turn to echo back on the next request, per the
// fallback docs: thinking and client tool_use before the last fallback
// block are dropped (the API validates thinking against that boundary),
// and empty text is rejected.
function echoBlocks(blocks: any[]): any[] {
  const last = blocks.map((block) => block.type).lastIndexOf("fallback");
  const declined = new Set(["thinking", "redacted_thinking", "tool_use"]);
  return blocks.filter((block, i) =>
    !(i < last && declined.has(block.type)) &&
    !(block.type === "text" && block.text.length === 0));
}

// One dim stderr line per API call, so cache behavior is verifiable live.
function printCacheUsage(usage: any): void {
  const read = usage?.cache_read_input_tokens ?? 0;
  const wrote = usage?.cache_creation_input_tokens ?? 0;
  if (read + wrote === 0) return;
  process.stderr.write(`${DIM}[cache: read ${read} write ${wrote} uncached ${usage?.input_tokens ?? 0}]${RESET}\n`);
}

// Max output tokens on the SYNCHRONOUS Messages API, per the models overview
// docs (2026-07). Sending more than the model's cap is a 400 error, so lower
// caps must be listed explicitly; everything current supports 128k:
//   128k: fable-5-1, fable-5, mythos-5, opus-5-5, opus-5, opus-4-8, opus-4-7, opus-4-6, sonnet-5, sonnet-4-6
//   64k:  haiku-4-5, sonnet-4-5, opus-4-5
//   32k:  opus-4-1
function anthropicMaxOutputTokens(model: string): number {
  const normalized = model.toLowerCase();
  if (normalized.includes("claude-opus-4-1")) {
    return 32000;
  }
  if (
    normalized.includes("claude-haiku-4-5") ||
    normalized.includes("claude-sonnet-4-5") ||
    normalized.includes("claude-opus-4-5")
  ) {
    return 64000;
  }
  return FALLBACK_MAX_OUTPUT_TOKENS;
}

export class AnthropicChat implements ChatInstance {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly vendorConfig?: VendorConfig;
  private readonly fast: boolean;
  private readonly betas: string[];
  private readonly messages: { role: Role; content: string }[] = [];
  private systemPrompt?: string;
  private cacheable = true;
  private cacheTtl: "5m" | "1h" = "1h";
  private cacheCuts?: { text: string; offsets: number[] };

  constructor(apiKey: string, model: string, vendorConfig?: VendorConfig, fast: boolean = false) {
    const betas: string[] = [TASK_BUDGET_BETA, FALLBACK_BETA];
    if (fast) {
      betas.push(FAST_MODE_BETA);
    }
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.vendorConfig = vendorConfig;
    this.fast = fast;
    this.betas = betas;
  }

  private updateSystemOptions(options: AskOptions): void {
    if (typeof options.system === "string") {
      this.systemPrompt = options.system;
    }
    if (typeof options.cacheable === "boolean") {
      this.cacheable = options.cacheable;
    }
    if (options.cache_ttl) {
      this.cacheTtl = options.cache_ttl;
    }
  }

  private mergeAnthropicConfig(options: AskOptions): VendorConfig["anthropic"] {
    return {
      ...this.vendorConfig?.anthropic,
      ...options.vendorConfig?.anthropic,
    };
  }

  private async createMessage(params: any): Promise<any> {
    return this.client.beta.messages.create(params);
  }

  private streamMessage(params: any): any {
    return this.client.beta.messages.stream(params);
  }

  private buildParams(options: AskOptions, wantStream: boolean, messages?: any[]): any {
    const mergedAnthropicConfig = this.mergeAnthropicConfig(options);
    // Always allow the model's full output budget — never cap it artificially.
    const maxTokens = anthropicMaxOutputTokens(this.model);
    const params: any = {
      model: this.model,
      stream: wantStream,
      max_tokens: maxTokens,
      messages: this.cacheable
        ? planCache(messages ?? this.messages, this.cacheTtl, this.cacheCuts)
        : (messages ?? this.messages),
    };
    params.betas = this.betas;
    params.fallbacks = "default";

    if (this.fast) {
      params.speed = "fast";
    }

    // No breakpoint on the system prompt: message breakpoints already hash
    // tools + system + messages, so a separate one would only spend a slot.
    const systemPrompt = wantStream
      ? appendStreamEndInstruction(this.systemPrompt)
      : this.systemPrompt;
    if (systemPrompt) {
      params.system = systemPrompt;
    }

    const thinking = mergedAnthropicConfig?.thinking;
    const useThinking = thinking && typeof thinking === "object";
    if (useThinking) {
      if (thinking.type === "enabled") {
        if (maxTokens > 1024) {
          const budgetMax = maxTokens - 1;
          const budgetRaw = typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : 1024;
          const budget = Math.max(1024, Math.min(budgetRaw, budgetMax));
          params.thinking = {
            type: "enabled",
            budget_tokens: budget,
          };
        } else {
          params.thinking = { type: "disabled" };
        }
      } else {
        params.thinking = { ...thinking };
      }
      // On Claude Opus 4.7+ the default `thinking.display` is `"omitted"`,
      // which means no thinking blocks are emitted at all (not even deltas
      // during streaming). Request `"summarized"` so we can render the
      // reasoning trace in dim gray. Harmless on older models that already
      // default to summarized.
      if (params.thinking && params.thinking.type !== "disabled" && !params.thinking.display) {
        params.thinking.display = "summarized";
      }
    }

    const effort = mergedAnthropicConfig?.effort;
    if (effort) {
      params.output_config = { effort };
    }

    const noThinking = !params.thinking || params.thinking.type === "disabled";
    if (noThinking && typeof options.temperature === "number") {
      params.temperature = options.temperature;
    }

    return params;
  }

  // The task budget counts the prompt too: with total = max_tokens, a
  // 273k-token prompt showed the model -144,942 tokens left. So the total
  // is the prompt's exact size (count_tokens, free) plus max_tokens, and
  // the model sees exactly its output room.
  private async setTaskBudget(params: any): Promise<void> {
    if (!params.output_config) {
      return;
    }
    const { input_tokens } = await this.client.beta.messages.countTokens({
      model: params.model,
      system: params.system,
      messages: params.messages,
      tools: params.tools,
      thinking: params.thinking,
      betas: params.betas,
    });
    params.output_config.task_budget = { type: "tokens", total: input_tokens + params.max_tokens };
  }

  async ask(
    userMessage: string | null,
    options: AskOptions = {},
  ): Promise<string | { messages: any[] }> {
    if (userMessage === null) {
      return { messages: this.messages };
    }

    const wantStream = options.stream !== false;
    this.updateSystemOptions(options);
    this.cacheCuts = options.cache_cuts && options.cache_cuts.length > 0
      ? { text: userMessage, offsets: options.cache_cuts }
      : undefined;
    // Push the user message BEFORE building params so the cache breakpoint
    // lands on it (buildParams snapshots the messages array when caching).
    this.messages.push({ role: "user", content: userMessage });
    // Local conversation copy: continuation rounds append partial assistant
    // content + a continue instruction here without polluting this.messages.
    const conversation: { role: Role; content: any }[] = this.messages.slice();

    let plain       = "";
    let stopReason  = "";
    let stopDetails: any = null;

    const sink = options.onStream;

    for (let round = 0; round <= MAX_CONTINUATION_ROUNDS; round++) {
      const params = this.buildParams(options, wantStream, conversation);
      await this.setTaskBudget(params);
      let roundText = "";
      let blocks: any[] = [];
      stopReason = "";

      if (wantStream) {
        const streamResp: AsyncIterable<any> = (await this.createMessage(params)) as any;
        let printedReasoning = false;
        const marker = createStreamMarkerState((text: string) => {
          if (!text) {
            return;
          }
          roundText += text;
          blocks[blocks.length - 1].text += text;
          if (sink) {
            sink(text, "text");
            return;
          }
          if (printedReasoning) {
            process.stdout.write("\n");
            printedReasoning = false;
          }
          process.stdout.write(text);
        });
        for await (const event of streamResp) {
          if (event.type === "content_block_start") {
            blocks.push({ ...event.content_block });
            if (event.content_block.type === "fallback") {
              printFallback(event.content_block);
            }
          } else if (event.type === "content_block_delta") {
            const delta: any = event.delta;
            if (delta.type === "signature_delta") {
              blocks[blocks.length - 1].signature = delta.signature;
            } else if (delta.type === "thinking_delta") {
              blocks[blocks.length - 1].thinking += delta.thinking;
              if (sink) {
                sink(delta.thinking, "reasoning");
              } else {
                process.stdout.write(`\x1b[2m${delta.thinking}\x1b[0m`);
                printedReasoning = true;
              }
            } else if (delta.type === "text_delta") {
              if (marker.push(delta.text)) {
                stopReason = "end_turn";
                break;
              }
            }
          } else if (event.type === "message_start") {
            printCacheUsage(event.message?.usage);
          } else if (event.type === "message_delta") {
            stopReason = event.delta?.stop_reason ?? "";
            stopDetails = event.delta?.stop_details ?? stopDetails;
          }
        }
      } else {
        const message: any = await this.createMessage({ ...params, stream: false });
        printCacheUsage(message.usage);
        stopReason = message.stop_reason ?? "";
        stopDetails = message.stop_details ?? null;
        blocks = message.content;
        let printedReasoning = false;
        for (const block of blocks) {
          if (block.type === "fallback") {
            printFallback(block);
          } else if (block.type === "thinking") {
            process.stdout.write(`\x1b[2m${block.thinking}\x1b[0m`);
            printedReasoning = true;
          } else if (block.type === "text") {
            if (printedReasoning) {
              process.stdout.write("\n");
              printedReasoning = false;
            }
            const text = stripTrailingMarker(block.text);
            process.stdout.write(text);
            roundText += text;
          }
        }
      }

      plain += roundText;

      if (stopReason === "refusal") {
        throw refusalError(stopDetails);
      }
      if (stopReason !== "max_tokens") {
        break;
      }
      // A thinking block cut mid-way still carries its signature, so a
      // thinking-only cut resumes like any other.
      blocks = echoBlocks(blocks);
      if (round === MAX_CONTINUATION_ROUNDS || blocks.length === 0) {
        throw new Error("response truncated by max_tokens limit");
      }
      process.stderr.write(`\x1b[33m[max_tokens hit: auto-continuing response (round ${round + 1}/${MAX_CONTINUATION_ROUNDS})]\x1b[0m\n`);
      conversation.push({ role: "assistant", content: blocks });
      conversation.push({ role: "user", content: CONTINUE_PROMPT });
    }

    if (!wantStream || !sink) process.stdout.write("\n");

    this.messages.push({ role: "assistant", content: plain });
    return plain;
  }

  async askTools(userMessage: string, options: AskToolsOptions): Promise<AskResult> {
    const tools = options.tools ?? [];
    if (tools.length === 0) {
      const reply = await this.ask(userMessage, options);
      return {
        text: typeof reply === "string" ? reply : "",
        toolCalls: [],
      };
    }

    const wantStream = options.stream !== false;
    this.updateSystemOptions(options);
    this.cacheCuts = undefined;
    const conversation: any[] = this.messages.map((msg) => ({ role: msg.role, content: msg.content }));
    conversation.push({ role: "user", content: userMessage });

    const localOptions: AskOptions = { ...options };
    const useNativeEditor = canUseNativeEditor(tools);
    let plain = "";
    let printedReasoning = false;
    const toolCalls: ToolCall[] = [];
    const maxRounds = 4;

    for (let round = 0; round < maxRounds; round++) {
      const params = this.buildParams(localOptions, wantStream, conversation);
      if (useNativeEditor) {
        params.tools = [{ type: TEXT_EDITOR_TOOL_TYPE, name: TEXT_EDITOR_TOOL_NAME }];
      } else {
        params.tools = tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema ?? { type: "object", properties: {} },
        }));
      }
      await this.setTaskBudget(params);

      let message: any;
      if (wantStream) {
        const stream = this.streamMessage({ ...params, stream: true });
        let roundPrintedAny = false;
        let lastKind: "thinking" | "text" | "tool" | null = null;
        let lastChar = "\n";
        let abortedOnMarker = false;
        const ensureBoundary = (next: "thinking" | "text" | "tool") => {
          if (lastKind && lastKind !== next && lastChar !== "\n") {
            process.stdout.write("\n");
            lastChar = "\n";
          }
          lastKind = next;
        };
        const writeChunk = (chunk: string, kind: "thinking" | "text" | "tool", dim: boolean) => {
          if (!chunk) {
            return;
          }
          ensureBoundary(kind);
          if (dim) {
            process.stdout.write(DIM + chunk + RESET);
          } else {
            process.stdout.write(chunk);
          }
          roundPrintedAny = true;
          const end = chunk[chunk.length - 1];
          if (end) {
            lastChar = end;
          }
        };
        const marker = createStreamMarkerState((text: string) => {
          writeChunk(text, "text", false);
        });
        stream.on("thinking", (delta: string) => {
          writeChunk(delta, "thinking", true);
        });
        stream.on("text", (delta: string) => {
          if (marker.push(delta)) {
            abortedOnMarker = true;
            stream.abort();
          }
        });
        stream.on("inputJson", (delta: string) => {
          writeChunk(delta, "tool", false);
        });
        try {
          message = await stream.finalMessage();
        } catch (err) {
          if (!abortedOnMarker || !stream.currentMessage) {
            throw err;
          }
          message = stream.currentMessage;
        }
        if (abortedOnMarker && Array.isArray(message?.content)) {
          stripMarkerFromBlocks(message.content);
        }
        if (roundPrintedAny && lastChar !== "\n") {
          process.stdout.write("\n");
        }
      } else {
        message = await this.createMessage({ ...params, stream: false });
      }
      printCacheUsage(message?.usage);

      const stopReason = message?.stop_reason ?? "";
      if (stopReason === "refusal") {
        throw refusalError(message?.stop_details);
      }
      const blocks: any[] = Array.isArray(message?.content) ? echoBlocks(stripMarkerFromBlocks(message.content)) : [];

      const nativeToolUses: any[] = [];
      const toolResults: any[] = [];

      for (const block of blocks) {
        if (block?.type === "fallback") {
          printFallback(block);
          continue;
        }
        if (block?.type === "thinking") {
          if (!wantStream) {
            process.stdout.write(`\x1b[2m${block.thinking}\x1b[0m`);
            printedReasoning = true;
          }
          continue;
        }
        if (block?.type === "text") {
          if (!wantStream) {
            if (printedReasoning) {
              process.stdout.write("\n");
              printedReasoning = false;
            }
            process.stdout.write(block.text);
          }
          plain += block.text;
          continue;
        }
        if (block?.type !== "tool_use") {
          continue;
        }
        if (useNativeEditor && block.name === TEXT_EDITOR_TOOL_NAME) {
          nativeToolUses.push(block);
          const toolUseId = typeof block.id === "string" ? block.id : "";
          if (!toolUseId) {
            continue;
          }
          const input = block.input ?? {};
          const command = typeof input.command === "string" ? input.command : "";
          if (command === "view") {
            toolResults.push(
              textEditorError(
                toolUseId,
                "view is disabled for this task. All files are already in the prompt context; use str_replace or create.",
              ),
            );
            continue;
          }
          try {
            const nativeCall = normalizeTextEditorCall(block);
            toolCalls.push(nativeCall);
          } catch (err) {
            toolResults.push(
              textEditorError(
                toolUseId,
                `unsupported editor command: ${(err as Error).message}`,
              ),
            );
          }
          continue;
        }
        if (typeof block.name === "string") {
          toolCalls.push({
            id: typeof block.id === "string" ? block.id : undefined,
            name: block.name,
            input: block.input ?? {},
          });
        }
      }

      if (stopReason === "max_tokens") {
        process.stderr.write("\x1b[33m[warning: response truncated by max_tokens limit]\x1b[0m\n");
      }

      if (toolCalls.length > 0) {
        break;
      }

      const canContinueToolRoundtrip = (
        useNativeEditor &&
        nativeToolUses.length > 0 &&
        toolResults.length === nativeToolUses.length
      );
      if (!canContinueToolRoundtrip) {
        break;
      }

      conversation.push({ role: "assistant", content: blocks });
      conversation.push({ role: "user", content: toolResults });
    }

    if (!wantStream && (printedReasoning || plain.length > 0)) {
      process.stdout.write("\n");
    }

    this.messages.push({ role: "user", content: userMessage });
    this.messages.push({ role: "assistant", content: plain });
    return { text: plain, toolCalls };
  }
}
