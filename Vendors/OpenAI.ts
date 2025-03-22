import OpenAI from "openai";
import { AskOptions, ChatInstance } from "../GenAI";

export class OpenAIChat implements ChatInstance {
  private client: OpenAI;
  private messages: { role: "user" | "assistant" | "system"; content: string }[] = [];
  private model: string;
  private vendor: string;

  constructor(apiKey: string, baseURL: string, model: string, vendor: string) {
    if (vendor === 'openrouter') {
      this.client = new OpenAI({
        apiKey,
        baseURL,
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/OpenRouterTeam/openrouter-examples",
        },
      });
    } else {
      this.client = new OpenAI({ apiKey, baseURL });
    }
    this.model = model;
    this.vendor = vendor;
  }

  async ask(userMessage: string | null, options: AskOptions): Promise<string | { messages: { role: string; content: string }[] }> {
    if (userMessage === null) {
      return { messages: this.messages };
    }

    let { system, temperature = 0.0, max_tokens = 8192, stream = true } = options;

    const is_o_series = this.model.startsWith("o1") || this.model.startsWith("o3");

    let max_completion_tokens: number | undefined;
    let reasoning_effort: string | undefined;

    if (is_o_series) {
      stream = this.model.startsWith("o3"); // streaming only for o3
      temperature = 1;
      max_completion_tokens = 100000; // Default for o-series if not specified
      reasoning_effort = "high";
    }

    // Update or set the system message if provided
    if (system) {
      if (this.messages.length > 0 && this.messages[0].role === "system") {
        this.messages[0].content = system; // Update existing system message
      } else {
        this.messages.unshift({ role: is_o_series ? "user" : "system", content: system }); // Add new system message at the start
      }
    }

    this.messages.push({ role: "user", content: userMessage });

    const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      messages: this.messages,
      model: this.model,
      temperature,
      stream,
      ...(is_o_series ? { max_completion_tokens: max_completion_tokens ?? max_tokens } : { max_tokens }),
    };

    if (reasoning_effort && this.vendor === 'deepseek') {
      (params as any).reasoning_effort = reasoning_effort;
    }

    let result = "";
    if (stream) {
      const streamResponse = await this.client.chat.completions.create({
        ...params,
        stream: true,
      });
      var is_reasoning = false;
      for await (const chunk of streamResponse) {
        if (this.vendor === "deepseek" && (chunk as any).choices[0]?.delta?.reasoning_content) {
          const text = (chunk as any).choices[0].delta.reasoning_content;
          process.stdout.write('\x1b[2m' + text + '\x1b[0m');
          is_reasoning = true;
        } else if (chunk.choices[0]?.delta?.content) {
          if (is_reasoning) { is_reasoning = false; process.stdout.write("\n"); }
          const text = chunk.choices[0].delta.content;
          process.stdout.write(text);
          result += text;
        }
      }
      process.stdout.write("\n");
    } else {
      const completionResponse = await this.client.chat.completions.create({
        ...params,
        stream: false,
      });
      if (this.vendor === "deepseek") {
        const reasoning_content = (completionResponse as any).choices[0]?.message?.reasoning_content || "";
        if (reasoning_content) process.stdout.write(reasoning_content);
      }
      const text = completionResponse.choices[0]?.message?.content || "";
      result = text;
      if (is_o_series && this.model.startsWith("o1")) console.log(result);
    }

    this.messages.push({ role: "assistant", content: result });
    return result;
  }
}
