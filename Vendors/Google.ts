import { GoogleGenAI } from "@google/genai";
import type {
  AskOptions,
  AskResult,
  AskToolsOptions,
  ChatInstance,
  ToolCall,
  ToolDef,
  VendorConfig,
} from "../GenAI";

type Role = "user" | "assistant";
interface Turn {
  role: Role;
  content: string;
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function normalizeGoogleSchema(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(normalizeGoogleSchema);
  }

  const type = typeof schema.type === "string" ? schema.type.toUpperCase() : schema.type;
  const normalized: Record<string, any> = { ...schema };
  if (type) {
    normalized.type = type;
  }

  if (schema.properties && typeof schema.properties === "object") {
    const properties: Record<string, any> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      properties[key] = normalizeGoogleSchema(value);
    }
    normalized.properties = properties;
  }
  if (schema.items) {
    normalized.items = normalizeGoogleSchema(schema.items);
  }
  return normalized;
}

function normalizeGoogleToolCall(call: any): ToolCall | null {
  const name = typeof call?.name === "string" ? call.name : "";
  if (!name) {
    return null;
  }
  let input: Record<string, any> = {};
  if (call?.args && typeof call.args === "object" && !Array.isArray(call.args)) {
    input = call.args as Record<string, any>;
  }
  return { name, input };
}

export class GoogleChat implements ChatInstance {
  private readonly client: GoogleGenAI;
  private readonly modelName: string;
  private readonly vendorConfig?: VendorConfig;
  private readonly history: Turn[] = [];
  private systemInstruction?: string;

  constructor(apiKey: string, modelName: string, vendorConfig?: VendorConfig) {
    this.client = new GoogleGenAI({ apiKey });
    this.modelName = modelName;
    this.vendorConfig = vendorConfig;
  }

  async ask(
    userMessage: string | null,
    options: AskOptions = {},
  ): Promise<string | { messages: any[] }> {
    if (userMessage === null) {
      return { messages: this.history };
    }

    const wantStream = options.stream !== false;
    if (typeof options.system === "string") {
      this.systemInstruction = options.system;
    }

    const contents = this.buildContents(userMessage);
    this.history.push({ role: "user", content: userMessage });

    const config = this.buildConfig(options);

    const request: any = {
      model: this.modelName,
      contents,
    };

    if (Object.keys(config).length > 0) {
      request.config = config;
    }

    let visible = "";
    if (wantStream) {
      const response = await this.client.models.generateContentStream(request);
      visible = await this.handleStream(response);
    } else {
      const response = await this.client.models.generateContent(request);
      visible = this.printCandidate(response.candidates?.[0]);
    }

    this.history.push({ role: "assistant", content: visible });
    return visible;
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

    if (typeof options.system === "string") {
      this.systemInstruction = options.system;
    }

    const contents = this.buildContents(userMessage);
    this.history.push({ role: "user", content: userMessage });

    const config = this.buildConfig(options);
    config.tools = [{
      functionDeclarations: tools.map((tool: ToolDef) => ({
        name: tool.name,
        description: tool.description,
        parameters: normalizeGoogleSchema(tool.inputSchema ?? { type: "object", properties: {} }),
      })),
    }];
    config.toolConfig = {
      functionCallingConfig: {
        mode: "AUTO",
      },
    };

    const request: any = {
      model: this.modelName,
      contents,
      config,
    };

    const response: any = await this.client.models.generateContent(request);
    const visible = this.printCandidate(response?.candidates?.[0]);

    const toolCalls: ToolCall[] = [];
    const functionCalls = this.collectFunctionCalls(response);
    for (const call of functionCalls) {
      const toolCall = normalizeGoogleToolCall(call);
      if (toolCall) {
        toolCalls.push(toolCall);
      }
    }

    this.history.push({ role: "assistant", content: visible });
    return { text: visible, toolCalls };
  }

  private buildContents(userMessage: string) {
    const contents = this.history.map((turn) => ({
      role: turn.role === "assistant" ? "model" : "user",
      parts: [{ text: turn.content }],
    }));

    contents.push({
      role: "user",
      parts: [{ text: userMessage }],
    });

    return contents;
  }

  private buildConfig(options: AskOptions) {
    const config: Record<string, any> = {
      ...(this.vendorConfig?.google?.config ?? {}),
    };

    if (options.vendorConfig?.google?.config) {
      Object.assign(config, options.vendorConfig.google.config);
    }

    if (this.systemInstruction) {
      config.systemInstruction = this.systemInstruction;
    }
    if (typeof options.temperature === "number") {
      config.temperature = options.temperature;
    }
    if (typeof options.max_tokens === "number") {
      config.maxOutputTokens = options.max_tokens;
    }

    return config;
  }

  private collectFunctionCalls(response: any) {
    if (Array.isArray(response?.functionCalls) && response.functionCalls.length > 0) {
      return response.functionCalls;
    }
    const parts = response?.candidates?.[0]?.content?.parts ?? [];
    const calls: any[] = [];
    for (const part of parts) {
      if (part?.functionCall) {
        calls.push(part.functionCall);
      }
    }
    return calls;
  }

  private async handleStream(stream: AsyncGenerator<any>) {
    let visible = "";
    let printedThought = false;

    for await (const chunk of stream) {
      const candidate = chunk?.candidates?.[0];
      if (!candidate) continue;
      const parts = candidate.content?.parts ?? [];
      for (const part of parts) {
        const text = part?.text;
        if (!text) continue;
        if (part?.thought) {
          process.stdout.write(DIM + text + RESET);
          printedThought = true;
        } else {
          if (printedThought && !visible.endsWith("\n")) {
            process.stdout.write("\n");
            printedThought = false;
          }
          process.stdout.write(text);
          visible += text;
        }
      }
    }

    process.stdout.write("\n");
    return visible;
  }

  private printCandidate(candidate: any) {
    let visible = "";
    let printedThought = false;
    const parts = candidate?.content?.parts ?? [];
    for (const part of parts) {
      const text = part?.text;
      if (!text) continue;
      if (part?.thought) {
        process.stdout.write(DIM + text + RESET);
        printedThought = true;
      } else {
        if (printedThought) {
          process.stdout.write("\n");
          printedThought = false;
        }
        process.stdout.write(text);
        visible += text;
      }
    }
    process.stdout.write("\n");
    return visible;
  }
}
