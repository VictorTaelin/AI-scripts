import OpenAI from "openai";
import type { AskOptions, ChatInstance, Vendor, VendorConfig } from "../GenAI";

type Role = "user" | "assistant";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export class OpenAIChat implements ChatInstance {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly vendor: Vendor;
  private readonly vendorConfig?: VendorConfig;
  private readonly messages: { role: Role; content: string }[] = [];
  private instructions?: string;

  constructor(
    apiKey: string,
    baseURL: string,
    model: string,
    vendor: Vendor,
    vendorConfig?: VendorConfig,
  ) {
    const defaultHeaders =
      vendor === "openrouter"
        ? { "HTTP-Referer": "https://github.com/victortaelin/ai-scripts" }
        : undefined;

    this.client = new OpenAI({ apiKey, baseURL, defaultHeaders });
    this.model = model;
    this.vendor = vendor;
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
      this.instructions = options.system;
    }

    this.messages.push({ role: "user", content: userMessage });

    const mergedOpenAIConfig = {
      ...this.vendorConfig?.openai,
      ...options.vendorConfig?.openai,
    };

    if (this.vendor === "openai") {
      return this.askViaResponsesAPI({ options, wantStream, mergedOpenAIConfig });
    }

    return this.askViaChatCompletions({ options, wantStream, mergedOpenAIConfig });
  }

  private async askViaResponsesAPI({
    options,
    wantStream,
    mergedOpenAIConfig,
  }: {
    options: AskOptions;
    wantStream: boolean;
    mergedOpenAIConfig: VendorConfig["openai"];
  }): Promise<string> {
    const history = this.messages.map((message) => ({
      type: "message",
      role: message.role,
      content: [
        {
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: message.content,
        },
      ],
    }));

    const params: Record<string, any> = {
      model: this.model,
      input: history,
    };

    if (this.instructions) {
      params.instructions = this.instructions;
    }
    if (typeof options.temperature === "number") {
      params.temperature = options.temperature;
    }

    const maxOutputTokens =
      typeof options.max_completion_tokens === "number"
        ? options.max_completion_tokens
        : typeof options.max_tokens === "number"
          ? options.max_tokens
          : undefined;
    if (typeof maxOutputTokens === "number") {
      params.max_output_tokens = maxOutputTokens;
    }

    if (mergedOpenAIConfig?.reasoning) {
      params.reasoning = {
        ...mergedOpenAIConfig.reasoning,
        summary: "auto",
      };
    }

    let visible = "";
    let lastType: "reasoning" | "text" | null = null;
    let lastChar = "\n";

    const ensureBoundary = (next: "reasoning" | "text") => {
      if (lastType && lastType !== next && lastChar !== "\n") {
        process.stdout.write("\n");
        lastChar = "\n";
      }
      lastType = next;
    };

    const writeChunk = (chunk: string, kind: "reasoning" | "text") => {
      if (!chunk) return;
      if (kind === "reasoning") {
        ensureBoundary("reasoning");
        process.stdout.write(DIM + chunk + RESET);
      } else {
        ensureBoundary("text");
        process.stdout.write(chunk);
        visible += chunk;
      }
      const end = chunk[chunk.length - 1];
      if (end) lastChar = end;
    };

    if (wantStream) {
      const stream = await (this.client as any).responses.stream(params);
      stream.on("response.reasoning_summary_text.delta", (evt: any) =>
        writeChunk(evt?.delta ?? "", "reasoning"),
      );
      stream.on("response.reasoning_summary_part.done", () => {
        if (lastChar !== "\n") {
          process.stdout.write("\n");
          lastChar = "\n";
        }
      });
      stream.on("response.output_text.delta", (evt: any) =>
        writeChunk(evt?.delta ?? "", "text"),
      );
      stream.on("response.completed", () => {
        if (lastChar !== "\n") {
          process.stdout.write("\n");
          lastChar = "\n";
        }
      });
      stream.on("error", (err: any) => {
        console.error("[OpenAIChat stream error]:", err?.message || err);
      });
      await stream.done();
    } else {
      const response: any = await (this.client as any).responses.create(params);
      for (const item of response?.output ?? []) {
        if (item?.type === "reasoning" && Array.isArray(item.summary)) {
          for (const block of item.summary) {
            if (block?.type === "summary_text") {
              process.stdout.write(DIM + block.text + RESET);
            }
          }
          process.stdout.write("\n");
        }
        if (item?.type === "message" && Array.isArray(item?.content)) {
          for (const part of item.content) {
            if (part?.type === "output_text" && part?.text) {
              process.stdout.write(part.text);
              visible += part.text;
            }
          }
          process.stdout.write("\n");
        }
      }
    }

    this.messages.push({ role: "assistant", content: visible });
    return visible;
  }

  private async askViaChatCompletions({
    options,
    wantStream,
    mergedOpenAIConfig,
  }: {
    options: AskOptions;
    wantStream: boolean;
    mergedOpenAIConfig: VendorConfig["openai"];
  }): Promise<string> {
    const chatMessages = [
      ...(this.instructions ? [{ role: "system", content: this.instructions }] : []),
      ...this.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const params: Record<string, any> = {
      model: this.model,
      messages: chatMessages,
    };

    if (typeof options.temperature === "number") {
      params.temperature = options.temperature;
    }
    if (typeof options.max_tokens === "number") {
      params.max_tokens = options.max_tokens;
    }
    if (mergedOpenAIConfig?.reasoning) {
      params.reasoning = mergedOpenAIConfig.reasoning;
    }

    let visible = "";

    if (wantStream) {
      const stream: AsyncIterable<any> = await (this.client.chat.completions.create as any)({
        ...params,
        stream: true,
      });
      let printedReasoning = false;
      for await (const chunk of stream) {
        const delta: any = chunk.choices?.[0]?.delta ?? {};
        if (delta.reasoning_content) {
          process.stdout.write(DIM + delta.reasoning_content + RESET);
          printedReasoning = true;
        }
        if (delta.content) {
          if (printedReasoning && !visible.endsWith("\n")) {
            process.stdout.write("\n");
            printedReasoning = false;
          }
          process.stdout.write(delta.content);
          visible += delta.content;
        }
      }
      process.stdout.write("\n");
    } else {
      const resp: any = await (this.client.chat.completions.create as any)(params);
      const message = resp?.choices?.[0]?.message;
      if (message?.reasoning_content) {
        process.stdout.write(DIM + message.reasoning_content + RESET + "\n");
      }
      const content = message?.content ?? "";
      process.stdout.write(content + "\n");
      visible = content;
    }

    this.messages.push({ role: "assistant", content: visible });
    return visible;
  }
}
