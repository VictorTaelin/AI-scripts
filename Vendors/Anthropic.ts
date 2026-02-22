import Anthropic from "@anthropic-ai/sdk";
import type { AskOptions, ChatInstance, VendorConfig } from "../GenAI";

type Role = "user" | "assistant";

const DEFAULT_MAX_TOKENS = 128000;
const FAST_MODE_BETA = "fast-mode-2026-02-01";

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

  async ask(
    userMessage: string | null,
    options: AskOptions = {},
  ): Promise<string | { messages: any[] }> {
    if (userMessage === null) {
      return { messages: this.messages };
    }

    const wantStream = options.stream !== false;
    if (typeof options.system === "string") {
      this.systemPrompt = options.system;
    }
    if (typeof options.system_cacheable === "boolean") {
      this.systemCacheable = options.system_cacheable;
    }
    const mergedAnthropicConfig = {
      ...this.vendorConfig?.anthropic,
      ...options.vendorConfig?.anthropic,
    };

    const maxTokens = options.max_tokens ?? DEFAULT_MAX_TOKENS;
    const params: any = {
      model: this.model,
      stream: wantStream,
      max_tokens: maxTokens,
      messages: this.messages,
      betas: this.betas,
    };

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
      var effort = mergedAnthropicConfig?.effort;
      if (effort) {
        params.output_config = { effort };
      }
    } else if (typeof options.temperature === "number") {
      params.temperature = options.temperature;
    }

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
}
