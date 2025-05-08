import Anthropic from "@anthropic-ai/sdk";
import { AskOptions, ChatInstance } from "../GenAI";

// ---------------------------------------------------------------------------
// NOTE: The Anthropic SDK’s type exports have been unstable across recent
//       versions.  To keep compilation green regardless of future renames, we
//       avoid direct named‑type imports and fall back to `any` where necessary.
// ---------------------------------------------------------------------------

type Role = "user" | "assistant";

export class AnthropicChat implements ChatInstance {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly messages: { role: Role; content: any }[] = [];

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({
      apiKey,
      defaultHeaders: {
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
    });
    this.model = model;
  }

  async ask(
    userMessage: string | null,
    options: AskOptions = {},
  ): Promise<string | { messages: any[] }> {
    if (userMessage === null) return { messages: this.messages };

    // ── options ----------------------------------------------------------
    const enableThinking = this.model.endsWith("-think");
    const baseModel = enableThinking ? this.model.replace("-think", "") : this.model;

    let {
      system,
      temperature = enableThinking ? 1 : 0,
      max_tokens = 32_000,
      stream = true,
      system_cacheable = false,
    } = options;

    // ── build message history -------------------------------------------
    this.messages.push({ role: "user", content: userMessage });

    // --------------------------------------------------------------------
    // Build request params (typeless to dodge SDK type churn)
    // --------------------------------------------------------------------
    const params: any = {
      model: baseModel,
      temperature,
      max_tokens,
      stream,
      messages: this.messages,
    };

    if (system) {
      params.system = system_cacheable
        ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
        : system;
    }

    if (enableThinking) {
      params.thinking = {
        type: "enabled",
        budget_tokens: 4096,
      };
    }

    // ── perform request --------------------------------------------------
    let plain = "";

    if (stream) {
      const streamResp: AsyncIterable<any> = (await this.client.messages.create(
        params,
      )) as any;

      let printedReasoning = false;
      for await (const event of streamResp) {
        if (event.type === "content_block_delta") {
          const delta: any = event.delta;
          if (delta.type === "thinking_delta") {
            process.stdout.write(`\x1b[2m${delta.thinking}\x1b[0m`);
            plain += delta.thinking;
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
      this.messages.push({ role: "assistant", content: plain });
    } else {
      const message: any = await this.client.messages.create({ ...params, stream: false });
      const blocks: any[] = message.content;
      let printedReasoning = false;
      for (const block of blocks) {
        if (block.type === "thinking") {
          process.stdout.write(`\x1b[2m${block.thinking}\x1b[0m`);
          plain += block.thinking;
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
      this.messages.push({ role: "assistant", content: blocks });
    }

    return plain;
  }
}
