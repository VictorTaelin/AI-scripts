import Anthropic from "@anthropic-ai/sdk";
import type {
  AskOptions,
  AskResult,
  AskToolsOptions,
  ChatInstance,
  ToolCall,
  ToolDef,
  VendorConfig,
} from "../GenAI";

type Role = "user" | "assistant";

const DEFAULT_MAX_TOKENS = 128000;
const FAST_MODE_BETA = "fast-mode-2026-02-01";
const TEXT_EDITOR_TOOL_NAME = "str_replace_based_edit_tool";
const TEXT_EDITOR_TOOL_TYPE = "text_editor_20250728";

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

function normalizeTextEditorCall(block: any): ToolCall | null {
  const input = block?.input ?? {};
  const command = typeof input.command === "string" ? input.command : "";
  const path = typeof input.path === "string" ? input.path : "";
  if (!path) {
    return null;
  }
  switch (command) {
    case "str_replace": {
      const oldStr = typeof input.old_str === "string" ? input.old_str : "";
      const newStr = typeof input.new_str === "string" ? input.new_str : "";
      return {
        id: block?.id,
        name: "str_replace",
        input: {
          path,
          old_str: oldStr,
          new_str: newStr,
        },
      };
    }
    case "create": {
      const fileText = typeof input.file_text === "string" ? input.file_text : "";
      return {
        id: block?.id,
        name: "create_file",
        input: {
          path,
          file_text: fileText,
        },
      };
    }
    default: {
      return null;
    }
  }
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

  private buildParams(options: AskOptions, wantStream: boolean): any {
    const mergedAnthropicConfig = this.mergeAnthropicConfig(options);
    const maxTokens = options.max_tokens ?? DEFAULT_MAX_TOKENS;
    const params: any = {
      model: this.model,
      stream: wantStream,
      max_tokens: maxTokens,
      messages: this.messages,
    };
    if (this.betas.length > 0) {
      params.betas = this.betas;
    }

    if (this.fast) {
      params.speed = "fast";
    }

    if (this.systemPrompt) {
      params.system = this.systemCacheable
        ? [{ type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } }]
        : this.systemPrompt;
    }

    const thinking = mergedAnthropicConfig?.thinking;
    const useThinking = thinking && typeof thinking === "object";
    if (useThinking) {
      params.thinking = thinking;
      const effort = mergedAnthropicConfig?.effort;
      if (effort) {
        params.output_config = { effort };
      }
    } else if (typeof options.temperature === "number") {
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
      const streamResp: AsyncIterable<any> = (await this.client.beta.messages.create(params)) as any;
      let printedReasoning = false;
      for await (const event of streamResp) {
        if (event.type === "content_block_delta") {
          const delta: any = event.delta;
          if (delta.type === "thinking_delta") {
            process.stdout.write(`\x1b[2m${delta.thinking}\x1b[0m`);
            printedReasoning = true;
          } else if (delta.type === "text_delta") {
            if (printedReasoning) {
              process.stdout.write("\n");
              printedReasoning = false;
            }
            process.stdout.write(delta.text);
            plain += delta.text;
          }
        } else if (event.type === "message_delta") {
          stopReason = event.delta?.stop_reason ?? "";
        }
      }
      process.stdout.write("\n");
    } else {
      const message: any = await this.client.beta.messages.create({ ...params, stream: false });
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
          process.stdout.write(block.text);
          plain += block.text;
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

    this.updateSystemOptions(options);
    this.messages.push({ role: "user", content: userMessage });

    const localOptions: AskOptions = { ...options };
    if (typeof localOptions.max_tokens !== "number") {
      localOptions.max_tokens = 8192;
    }
    const params = this.buildParams(localOptions, false);
    const useNativeEditor = canUseNativeEditor(tools);
    if (useNativeEditor) {
      params.tools = [{ type: TEXT_EDITOR_TOOL_TYPE, name: TEXT_EDITOR_TOOL_NAME }];
    } else {
      params.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema ?? { type: "object", properties: {} },
      }));
    }

    const message: any = await this.client.beta.messages.create({ ...params, stream: false });
    const stopReason = message?.stop_reason ?? "";
    const blocks: any[] = Array.isArray(message?.content) ? message.content : [];

    let plain = "";
    let printedReasoning = false;
    const toolCalls: ToolCall[] = [];

    for (const block of blocks) {
      if (block?.type === "thinking") {
        process.stdout.write(`\x1b[2m${block.thinking}\x1b[0m`);
        printedReasoning = true;
        continue;
      }
      if (block?.type === "text") {
        if (printedReasoning) {
          process.stdout.write("\n");
          printedReasoning = false;
        }
        process.stdout.write(block.text);
        plain += block.text;
        continue;
      }
      if (block?.type === "tool_use") {
        if (useNativeEditor && block.name === TEXT_EDITOR_TOOL_NAME) {
          const nativeCall = normalizeTextEditorCall(block);
          if (nativeCall) {
            toolCalls.push(nativeCall);
          }
        } else if (typeof block.name === "string") {
          toolCalls.push({
            id: typeof block.id === "string" ? block.id : undefined,
            name: block.name,
            input: block.input ?? {},
          });
        }
      }
    }

    if (printedReasoning || plain.length > 0) {
      process.stdout.write("\n");
    }

    if (stopReason === "max_tokens") {
      process.stderr.write("\x1b[33m[warning: response truncated by max_tokens limit]\x1b[0m\n");
    }

    this.messages.push({ role: "assistant", content: plain });
    return { text: plain, toolCalls };
  }
}
