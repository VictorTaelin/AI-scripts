import OpenAI from "openai";
import type { AskOptions, ChatInstance, VendorConfig } from "../GenAI";

type Role = "user" | "assistant" | "system";

export class XAIChat implements ChatInstance {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly vendorConfig?: VendorConfig;
  private readonly messages: { role: Role; content: string }[] = [];
  private systemInstruction?: string;

  constructor(apiKey: string, model: string, vendorConfig?: VendorConfig) {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.x.ai/v1",
    });
    this.model = model;
    this.vendorConfig = vendorConfig;
  }

  private ensureSystemMessage(update?: string) {
    if (typeof update === "string") {
      this.systemInstruction = update;
    }
    if (!this.systemInstruction) return;
    if (this.messages[0] && this.messages[0].role === "system") {
      this.messages[0] = { role: "system", content: this.systemInstruction };
    } else {
      this.messages.unshift({ role: "system", content: this.systemInstruction });
    }
  }

  async ask(
    userMessage: string | null,
    options: AskOptions = {},
  ): Promise<string | { messages: any[] }> {
    if (userMessage === null) {
      return { messages: this.messages };
    }

    const wantStream = options.stream !== false;
    this.ensureSystemMessage(options.system);
    this.messages.push({ role: "user", content: userMessage });

    const body: Record<string, any> = {
      model: this.model,
      messages: this.messages as any,
    };

    if (typeof options.temperature === "number") {
      body.temperature = options.temperature;
    }
    if (typeof options.max_tokens === "number") {
      body.max_tokens = options.max_tokens;
    }

    let visible = "";

    if (wantStream) {
      const stream: AsyncIterable<any> = await (this.client.chat.completions.create as any)({
        ...(body as any),
        stream: true,
      });
      for await (const chunk of stream) {
        const delta: any = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          process.stdout.write(delta.content);
          visible += delta.content;
        }
      }
      process.stdout.write("\n");
    } else {
      const resp: any = await (this.client.chat.completions.create as any)(body as any);
      const msg: any = resp.choices?.[0]?.message ?? {};
      visible = msg.content ?? "";
      if (visible) {
        process.stdout.write(visible + "\n");
      }
    }

    this.messages.push({ role: "assistant", content: visible });
    return visible;
  }
}
