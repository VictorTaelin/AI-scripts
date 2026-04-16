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

const DEFAULT_MAX_TOKENS = 128000;
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

export class AnthropicChat implements ChatInstance {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly vendorConfig?: VendorConfig;
  private readonly fast: boolean;
  private readonly betas: string[];
  private readonly messages: { role: Role; content: string }[] = [];
  private systemPrompt?: string;
  private systemCacheable = false;

  constructor(apiKey: string, model: string, vendorConfig?: VendorConfig, fast: boolean = false) {
    const betas: string[] = [];
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
    if (typeof options.system_cacheable === "boolean") {
      this.systemCacheable = options.system_cacheable;
    }
  }

  private mergeAnthropicConfig(options: AskOptions): VendorConfig["anthropic"] {
    return {
      ...this.vendorConfig?.anthropic,
      ...options.vendorConfig?.anthropic,
    };
  }

  private async createMessage(params: any): Promise<any> {
    if (this.fast) {
      return this.client.beta.messages.create(params);
    }
    return this.client.messages.create(params);
  }

  private streamMessage(params: any): any {
    if (this.fast) {
      return this.client.beta.messages.stream(params);
    }
    return this.client.messages.stream(params);
  }

  private buildParams(options: AskOptions, wantStream: boolean, messages?: any[]): any {
    const mergedAnthropicConfig = this.mergeAnthropicConfig(options);
    const maxTokens = options.max_tokens ?? DEFAULT_MAX_TOKENS;
    const params: any = {
      model: this.model,
      stream: wantStream,
      max_tokens: maxTokens,
      messages: messages ?? this.messages,
    };
    if (this.betas.length > 0) {
      params.betas = this.betas;
    }

    if (this.fast) {
      params.speed = "fast";
    }

    const systemPrompt = wantStream
      ? appendStreamEndInstruction(this.systemPrompt)
      : this.systemPrompt;
    if (systemPrompt) {
      params.system = this.systemCacheable
        ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
        : systemPrompt;
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

  async ask(
    userMessage: string | null,
    options: AskOptions = {},
  ): Promise<string | { messages: any[] }> {
    if (userMessage === null) {
      return { messages: this.messages };
    }

    const wantStream = options.stream !== false;
    this.updateSystemOptions(options);
    const params = this.buildParams(options, wantStream);

    this.messages.push({ role: "user", content: userMessage });

    let plain      = "";
    let stopReason = "";

    if (wantStream) {
      const streamResp: AsyncIterable<any> = (await this.createMessage(params)) as any;
      let printedReasoning = false;
      const marker = createStreamMarkerState((text: string) => {
        if (!text) {
          return;
        }
        if (printedReasoning) {
          process.stdout.write("\n");
          printedReasoning = false;
        }
        process.stdout.write(text);
        plain += text;
      });
      for await (const event of streamResp) {
        if (event.type === "content_block_delta") {
          const delta: any = event.delta;
          if (delta.type === "thinking_delta") {
            process.stdout.write(`\x1b[2m${delta.thinking}\x1b[0m`);
            printedReasoning = true;
          } else if (delta.type === "text_delta") {
            if (marker.push(delta.text)) {
              stopReason = "end_turn";
              break;
            }
          }
        } else if (event.type === "message_delta") {
          stopReason = event.delta?.stop_reason ?? "";
        }
      }
      process.stdout.write("\n");
    } else {
      const message: any = await this.createMessage({ ...params, stream: false });
      stopReason = message.stop_reason ?? "";
      const blocks: any[] = message.content;
      let printedReasoning = false;
      for (const block of blocks) {
        if (block.type === "thinking") {
          process.stdout.write(`\x1b[2m${block.thinking}\x1b[0m`);
          printedReasoning = true;
        } else if (block.type === "text") {
          if (printedReasoning) {
            process.stdout.write("\n");
            printedReasoning = false;
          }
          const text = stripTrailingMarker(block.text);
          process.stdout.write(text);
          plain += text;
        }
      }
      process.stdout.write("\n");
    }

    if (stopReason === "max_tokens") {
      process.stderr.write("\x1b[33m[warning: response truncated by max_tokens limit]\x1b[0m\n");
    }

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
    const conversation: any[] = this.messages.map((msg) => ({ role: msg.role, content: msg.content }));
    conversation.push({ role: "user", content: userMessage });

    const localOptions: AskOptions = { ...options };
    if (typeof localOptions.max_tokens !== "number") {
      localOptions.max_tokens = 8192;
    }
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

      const stopReason = message?.stop_reason ?? "";
      const blocks: any[] = Array.isArray(message?.content) ? stripMarkerFromBlocks(message.content) : [];

      const nativeToolUses: any[] = [];
      const toolResults: any[] = [];

      for (const block of blocks) {
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
