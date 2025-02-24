import { Anthropic } from '@anthropic-ai/sdk';
import { AskOptions, ChatInstance } from "../GenAI";

export class AnthropicChat implements ChatInstance {
  private client: Anthropic;
  private messages: { role: "user" | "assistant"; content: string }[] = [];
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({
      apiKey,
      defaultHeaders: {
        "anthropic-beta": "prompt-caching-2024-07-31"
      }
    });
    this.model = model;
  }

  async ask(userMessage: string | null, options: AskOptions): Promise<string | { messages: { role: string; content: string }[] }> {
    if (userMessage === null) {
      return { messages: this.messages };
    }

    let { system, temperature = 0.0, max_tokens = 8192, stream = true, system_cacheable = false } = options;

    this.messages.push({ role: "user", content: userMessage });

    const params: Anthropic.MessageCreateParams = {
      system: system_cacheable && system
        ? ([{ type: "text", text: system, cache_control: { type: "ephemeral" } }] as any)
        : system,
      model: this.model,
      temperature,
      max_tokens,
      stream,
      messages: this.messages,
    };

    let result = "";
    const response = this.client.messages.stream(params)
      .on('text', (text) => {
        if (stream) process.stdout.write(text);
        result += text;
      });

    await response.finalMessage();
    process.stdout.write("\n");

    this.messages.push({ role: "assistant", content: result });
    return result;
  }
}
