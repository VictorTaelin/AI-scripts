import OpenAI from "openai";
import type {
  AskOptions,
  AskResult,
  AskToolsOptions,
  ChatInstance,
  ToolCall,
  ToolDef,
  Vendor,
  VendorConfig,
} from "../GenAI";

type Role = "user" | "assistant";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

type ParsedDiffHunk = {
  oldText: string;
  newText: string;
};

function canUseNativeApplyPatch(tools: ToolDef[]): boolean {
  if (tools.length === 0) {
    return false;
  }
  const names = new Set(tools.map(tool => tool.name));
  if (!names.has("str_replace")) {
    return false;
  }
  if (!names.has("create_file")) {
    return false;
  }
  return names.size === 2;
}

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

function parseV4AHunks(diff: string): ParsedDiffHunk[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const hunks: ParsedDiffHunk[] = [];
  let oldLines: string[] = [];
  let newLines: string[] = [];
  let active = false;

  const flush = () => {
    if (!active) {
      return;
    }
    const oldText = oldLines.join("\n");
    const newText = newLines.join("\n");
    hunks.push({ oldText, newText });
    oldLines = [];
    newLines = [];
    active = false;
  };

  for (const line of lines) {
    if (line.startsWith("@@")) {
      flush();
      active = true;
      continue;
    }
    if (
      line.startsWith("*** Begin Patch") ||
      line.startsWith("*** End Patch") ||
      line.startsWith("*** Update File:") ||
      line.startsWith("*** Add File:") ||
      line.startsWith("*** Delete File:") ||
      line.startsWith("*** End of File")
    ) {
      continue;
    }
    if (line === "\\ No newline at end of file") {
      continue;
    }

    const prefix = line[0];
    if (prefix === " ") {
      active = true;
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
      continue;
    }
    if (prefix === "-") {
      active = true;
      oldLines.push(line.slice(1));
      continue;
    }
    if (prefix === "+") {
      active = true;
      newLines.push(line.slice(1));
      continue;
    }

    active = true;
    oldLines.push(line);
    newLines.push(line);
  }

  flush();
  return hunks.filter(hunk => hunk.oldText !== hunk.newText);
}

function extractCreatedFileText(diff: string): string {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const fileLines: string[] = [];
  for (const line of lines) {
    if (
      line.startsWith("*** Begin Patch") ||
      line.startsWith("*** End Patch") ||
      line.startsWith("*** Add File:") ||
      line.startsWith("*** End of File")
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      fileLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      fileLines.push(line.slice(1));
      continue;
    }
  }
  return fileLines.join("\n");
}

function normalizeApplyPatchCall(item: any): ToolCall[] {
  const operation = item?.operation;
  if (!operation || typeof operation !== "object") {
    return [];
  }
  const callId = typeof item?.id === "string" ? item.id : undefined;
  const type = typeof operation.type === "string" ? operation.type : "";
  const path = typeof operation.path === "string" ? operation.path : "";
  const diff = typeof operation.diff === "string" ? operation.diff : "";

  switch (type) {
    case "create_file": {
      if (!path) {
        return [];
      }
      const fileText = extractCreatedFileText(diff);
      return [{
        id: callId,
        name: "create_file",
        input: {
          path,
          file_text: fileText,
        },
      }];
    }
    case "update_file": {
      if (!path) {
        return [];
      }
      const hunks = parseV4AHunks(diff);
      const calls: ToolCall[] = [];
      for (let idx = 0; idx < hunks.length; idx++) {
        const hunk = hunks[idx];
        calls.push({
          id: callId ? `${callId}:${idx}` : undefined,
          name: "str_replace",
          input: {
            path,
            old_str: hunk.oldText,
            new_str: hunk.newText,
          },
        });
      }
      return calls;
    }
    case "delete_file": {
      if (!path) {
        return [];
      }
      return [{
        id: callId,
        name: "delete_file",
        input: { path },
      }];
    }
    default: {
      return [];
    }
  }
}

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

  private updateInstructions(options: AskOptions): void {
    if (typeof options.system === "string") {
      this.instructions = options.system;
    }
  }

  private mergeOpenAIConfig(options: AskOptions): VendorConfig["openai"] {
    return {
      ...this.vendorConfig?.openai,
      ...options.vendorConfig?.openai,
    };
  }

  private buildResponsesHistory() {
    return this.messages.map((message) => ({
      type: "message",
      role: message.role,
      content: [
        {
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: message.content,
        },
      ],
    }));
  }

  private buildResponsesParams(
    options: AskOptions,
    mergedOpenAIConfig: VendorConfig["openai"],
  ): Record<string, any> {
    const params: Record<string, any> = {
      model: this.model,
      input: this.buildResponsesHistory(),
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

    return params;
  }

  async ask(
    userMessage: string | null,
    options: AskOptions = {},
  ): Promise<string | { messages: any[] }> {
    if (userMessage === null) {
      return { messages: this.messages };
    }

    const wantStream = options.stream !== false;
    this.updateInstructions(options);

    this.messages.push({ role: "user", content: userMessage });

    const mergedOpenAIConfig = this.mergeOpenAIConfig(options);

    if (this.vendor === "openai") {
      return this.askViaResponsesAPI({ options, wantStream, mergedOpenAIConfig });
    }

    return this.askViaChatCompletions({ options, wantStream, mergedOpenAIConfig });
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

    this.updateInstructions(options);
    this.messages.push({ role: "user", content: userMessage });

    const mergedOpenAIConfig = this.mergeOpenAIConfig(options);

    if (this.vendor === "openai") {
      return this.askToolsViaResponsesAPI({ options, mergedOpenAIConfig, tools });
    }
    return this.askToolsViaChatCompletions({ options, mergedOpenAIConfig, tools });
  }

  private async askToolsViaResponsesAPI({
    options,
    mergedOpenAIConfig,
    tools,
  }: {
    options: AskToolsOptions;
    mergedOpenAIConfig: VendorConfig["openai"];
    tools: ToolDef[];
  }): Promise<AskResult> {
    const params = this.buildResponsesParams(options, mergedOpenAIConfig);
    const useNativeApplyPatch = canUseNativeApplyPatch(tools);

    if (useNativeApplyPatch) {
      params.tools = [{ type: "apply_patch" }];
    } else {
      params.tools = tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      }));
    }

    const response: any = await (this.client as any).responses.create(params);
    let visible = "";
    const toolCalls: ToolCall[] = [];

    for (const item of response?.output ?? []) {
      if (item?.type === "reasoning" && Array.isArray(item.summary)) {
        for (const block of item.summary) {
          if (block?.type === "summary_text") {
            process.stdout.write(DIM + block.text + RESET);
          }
        }
        process.stdout.write("\n");
        continue;
      }

      if (item?.type === "message" && Array.isArray(item?.content)) {
        let wroteLine = false;
        for (const part of item.content) {
          if (part?.type === "output_text" && part?.text) {
            process.stdout.write(part.text);
            visible += part.text;
            wroteLine = true;
          }
        }
        if (wroteLine) {
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
        continue;
      }

      if (item?.type === "apply_patch_call") {
        const normalized = normalizeApplyPatchCall(item);
        for (const call of normalized) {
          toolCalls.push(call);
        }
      }
    }

    this.messages.push({ role: "assistant", content: visible });
    return { text: visible, toolCalls };
  }

  private async askToolsViaChatCompletions({
    options,
    mergedOpenAIConfig,
    tools,
  }: {
    options: AskToolsOptions;
    mergedOpenAIConfig: VendorConfig["openai"];
    tools: ToolDef[];
  }): Promise<AskResult> {
    const chatMessages = [
      ...(this.instructions ? [{ role: "system", content: this.instructions }] : []),
      ...this.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const params: Record<string, any> = {
      model: this.model,
      messages: chatMessages,
      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      })),
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

    const resp: any = await (this.client.chat.completions.create as any)(params);
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
      if (!name) {
        continue;
      }
      toolCalls.push({
        id: typeof call?.id === "string" ? call.id : undefined,
        name,
        input: parseToolArgs(fn.arguments),
      });
    }

    this.messages.push({ role: "assistant", content });
    return { text: content, toolCalls };
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
    const params = this.buildResponsesParams(options, mergedOpenAIConfig);

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
