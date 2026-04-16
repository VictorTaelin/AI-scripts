import OpenAI from "openai";
import type {
  AskOptions,
  AskResult,
  AskToolsOptions,
  ChatInstance,
  ToolCall,
  ToolDef,
  VendorConfig,
} from "../AskAI";

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

export class VastChat implements ChatInstance {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly vendorConfig?: VendorConfig;
  private readonly messages: { role: Role; content: string }[] = [];
  private systemInstruction?: string;

  constructor(baseURL: string, model: string, vendorConfig?: VendorConfig) {
    this.client = new OpenAI({
      apiKey: "not-needed",
      baseURL,
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

    const body: Record<string, any> = {
      model: this.model,
      messages: this.messages as any,
      max_tokens: 8192,
      tools: tools.map((tool: ToolDef) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      })),
    };

    if (typeof options.temperature === "number") {
      body.temperature = options.temperature;
    }
    if (typeof options.max_tokens === "number") {
      body.max_tokens = options.max_tokens;
    }

    const resp: any = await (this.client.chat.completions.create as any)(body);
    const message = resp?.choices?.[0]?.message ?? {};
    const content = typeof message.content === "string" ? message.content : "";
    if (content) {
      process.stdout.write(content + "\n");
    }

    const toolCalls: ToolCall[] = [];
    const responseToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of responseToolCalls) {
      const fn = call?.function ?? {};
      const name = typeof fn.name === "string" ? fn.name : "";
      if (!name) continue;
      toolCalls.push({
        id: typeof call?.id === "string" ? call.id : undefined,
        name,
        input: parseToolArgs(fn.arguments),
      });
    }

    this.messages.push({ role: "assistant", content });
    return { text: content, toolCalls };
  }

  async ask(
    userMessage: string | null,
    options: AskOptions = {},
  ): Promise<string | { messages: any[] }> {
    if (userMessage === null) {
      return { messages: this.messages };
    }

    const wantStream = false; // non-stream: thinking model streams silently during reasoning
    this.ensureSystemMessage(options.system);
    this.messages.push({ role: "user", content: userMessage });

    const body: Record<string, any> = {
      model: this.model,
      messages: this.messages as any,
      max_tokens: 16384,
      chat_template_kwargs: { enable_thinking: false },
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
        if (delta?.reasoning_content) continue; // skip thinking tokens
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
