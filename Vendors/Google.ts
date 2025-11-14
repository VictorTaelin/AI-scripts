import { GoogleGenAI } from "@google/genai";
import type { AskOptions, ChatInstance, VendorConfig } from "../GenAI";

type Role = "user" | "assistant";
interface Turn {
  role: Role;
  content: string;
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

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
