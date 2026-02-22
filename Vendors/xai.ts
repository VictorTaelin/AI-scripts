import OpenAI from "openai";
import type {
  AskOptions,
  AskResult,
  AskToolsOptions,
  ChatInstance,
  ToolCall,
  ToolDef,
  VendorConfig,
} from "../GenAI";

type Role = "user" | "assistant" | "system";

function parseToolArgs(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, any>;
  }
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
  } catch {
    return {};
  }
  return {};
}

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

  async askTools(userMessage: string, options: AskToolsOptions): Promise<AskResult> {
    const tools = options.tools ?? [];
    if (tools.length === 0) {
      const reply = await this.ask(userMessage, options);
      return {
        text: typeof reply === "string" ? reply : "",
        toolCalls: [],
      };
    }

    this.ensureSystemMessage(options.system);
    this.messages.push({ role: "user", content: userMessage });

    const input = this.messages.map((message) => ({
      type: "message",
      role: message.role,
      content: [
        {
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: message.content,
        },
      ],
    }));

    const body: Record<string, any> = {
      model: this.model,
      input,
      tools: tools.map((tool: ToolDef) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      })),
    };

    if (typeof options.temperature === "number") {
      body.temperature = options.temperature;
    }

    const maxOutputTokens =
      typeof options.max_completion_tokens === "number"
        ? options.max_completion_tokens
        : typeof options.max_tokens === "number"
          ? options.max_tokens
          : undefined;
    if (typeof maxOutputTokens === "number") {
      body.max_output_tokens = maxOutputTokens;
    }

    const response: any = await (this.client as any).responses.create(body);
    let visible = "";
    const toolCalls: ToolCall[] = [];

    for (const item of response?.output ?? []) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        let wrote = false;
        for (const part of item.content) {
          if (part?.type === "output_text" && part?.text) {
            process.stdout.write(part.text);
            visible += part.text;
            wrote = true;
          }
        }
        if (wrote) {
          process.stdout.write("\n");
        }
        continue;
      }
      if (item?.type === "function_call") {
        const name = typeof item.name === "string" ? item.name : "";
        if (!name) {
          continue;
        }
        toolCalls.push({
          id: typeof item.call_id === "string" ? item.call_id : undefined,
          name,
          input: parseToolArgs(item.arguments),
        });
      }
    }

    this.messages.push({ role: "assistant", content: visible });
    return { text: visible, toolCalls };
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
