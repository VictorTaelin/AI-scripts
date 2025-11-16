import Anthropic from "@anthropic-ai/sdk";
import type { AskOptions, ChatInstance, VendorConfig } from "../GenAI";

type Role = "user" | "assistant";

const DEFAULT_MAX_TOKENS = 32000;
const MIN_THINKING_BUDGET = 1024;
const MIN_ANSWER_RESERVE = 2048;

export class AnthropicChat implements ChatInstance {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly vendorConfig?: VendorConfig;
  private readonly messages: { role: Role; content: string }[] = [];
  private systemPrompt?: string;
  private systemCacheable = false;

  constructor(apiKey: string, model: string, vendorConfig?: VendorConfig) {
    this.client = new Anthropic({
      apiKey,
      defaultHeaders: {
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
    });
    this.model = model;
    this.vendorConfig = vendorConfig;
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
    };

    if (this.systemPrompt) {
      params.system = this.systemCacheable
        ? [{ type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } }]
        : this.systemPrompt;
    }

    const thinking = mergedAnthropicConfig?.thinking;
    if (thinking && typeof thinking === "object") {
      const requested = Math.max(MIN_THINKING_BUDGET, thinking.budget_tokens);
      const maxAllowed = Math.max(MIN_THINKING_BUDGET, maxTokens - MIN_ANSWER_RESERVE);
      params.thinking = {
        ...thinking,
        budget_tokens: Math.min(requested, maxAllowed),
      };
    } else if (typeof options.temperature === "number") {
      params.temperature = options.temperature;
    }

    this.messages.push({ role: "user", content: userMessage });

    let plain = "";

    if (wantStream) {
      const streamResp: AsyncIterable<any> = (await this.client.messages.create(params)) as any;
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
        }
      }
      process.stdout.write("\n");
    } else {
      const message: any = await this.client.messages.create({ ...params, stream: false });
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

    this.messages.push({ role: "assistant", content: plain });
    return plain;
  }
}
