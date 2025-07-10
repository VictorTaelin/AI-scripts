import OpenAI from "openai";
import { AskOptions, ChatInstance } from "../GenAI";

/**
 * xAI wrapper using OpenAI compatibility.
 * Supports grok-4-0709 model via API.
 */

type Role = "user" | "assistant" | "system";

export class XAIChat implements ChatInstance {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly messages: { role: Role; content?: string }[] = [];

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ 
      apiKey, 
      baseURL: "https://api.x.ai/v1" 
    });
    this.model = model;
  }

  private ensureSystemMessage(content?: string) {
    if (!content) return;
    if (this.messages[0] && this.messages[0].role === "system") {
      this.messages[0] = { role: "system", content };
    } else {
      this.messages.unshift({ role: "system", content });
    }
  }

  async ask(userMessage: string | null, options: AskOptions = {}): Promise<string | { messages: any[] }> {
    if (userMessage === null) return { messages: this.messages };

    const {
      system,
      temperature = 0,
      stream: wantStream = true,
      max_tokens = 8_192*2,
    } = options;

    this.ensureSystemMessage(system);
    this.messages.push({ role: "user", content: userMessage });

    // Build base request body
    const body: Record<string, any> = {
      model: this.model,
      messages: this.messages as any,
      temperature,
      max_tokens,
    };

    const doStream = !!wantStream;
    let visible = "";

    try {
      if (doStream) {
        const streamParams = body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
        const stream = await this.client.chat.completions.create({ ...streamParams, stream: true });

        for await (const chunk of stream) {
          const delta: any = chunk.choices[0]?.delta;
          if (delta?.content) {
            process.stdout.write(delta.content);
            visible += delta.content;
          }
        }
        process.stdout.write("\n");
      } else {
        const respParams = body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
        const resp: any = await this.client.chat.completions.create(respParams);
        const msg: any = resp.choices[0]?.message ?? {};
        visible = msg.content ?? "";
        process.stdout.write(visible + "\n");
      }
    } catch (err: any) {
      console.error("[XAIChat] API error:", err?.message || err);
      throw err;
    }

    this.messages.push({ role: "assistant", content: visible });
    return visible;
  }
}