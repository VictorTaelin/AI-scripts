import OpenAI from "openai";
import type { AskOptions, ChatInstance } from "../GenAI";

/**
 * OpenAI (Responses API) vendor with streamed reasoning summaries.
 * - Streams reasoning summary tokens in dim gray (like Anthropic).
 * - Ensures clean newline boundaries between reasoning and visible text.
 * - Avoids stray "detailed" token by not reprinting summaries on completion.
 */

type Role = "user" | "assistant" | "system" | "developer";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const DBG_ENABLED = !!process.env.CHATSH_DEBUG;
const dbg = (label: string, data?: any) => {
  if (!DBG_ENABLED) return;
  const ts = new Date().toISOString();
  if (data !== undefined) {
    try {
      console.log(`[DBG ${ts}] ${label} ${typeof data === "string" ? data : JSON.stringify(data)}`);
    } catch {
      console.log(`[DBG ${ts}] ${label}`);
    }
  } else {
    console.log(`[DBG ${ts}] ${label}`);
  }
};

const isOSeries = (m: string) => /^o[0-9]/.test(m);
const isGPT5 = (m: string) => m.startsWith("gpt-5");
const isKimi = (m: string) => m.startsWith("kimi");
const usesMaxCompletionTokens = (m: string) => isOSeries(m) || isGPT5(m);
const controlRole = (m: string): Role => (isOSeries(m) ? "developer" : "system");
const usesResponsesAPI = (m: string) => isOSeries(m) || isGPT5(m);

function isStandaloneVerbosityToken(s: string): boolean {
  // Defensive: skip stray single tokens like "detailed" that may appear in some payloads.
  const t = s.trim().toLowerCase();
  return t === "detailed" || t === "concise" || t === "brief";
}

export class OpenAIChat implements ChatInstance {
  private readonly client: OpenAI;
  private readonly model: string;      // raw model label passed in (e.g., "gpt-5-thinking")
  private readonly vendor: string;
  private readonly messages: { role: Role; content?: string }[] = [];

  constructor(apiKey: string, baseURL: string, model: string, vendor: string) {
    const defaultHeaders =
      vendor === "openrouter"
        ? { "HTTP-Referer": "https://github.com/OpenRouterTeam/openrouter-examples" }
        : undefined;

    this.client = new OpenAI({ apiKey, baseURL, defaultHeaders });
    this.model = model;
    this.vendor = vendor;

    dbg("INIT", { vendor, rawModel: model, baseModel: this.baseModel() });
  }

  private baseModel(): string {
    // "thinking" alias uses the same base model id, different reasoning effort.
    if (this.model === "gpt-5-thinking") return "gpt-5";
    return this.model;
  }

  private isThinking(): boolean {
    return this.model === "gpt-5-thinking";
  }

  private ensureControlMessage(content?: string) {
    if (!content) return;
    const role = controlRole(this.model);
    if (
      this.messages[0] &&
      (this.messages[0].role === "system" || this.messages[0].role === "developer")
    ) {
      this.messages[0] = { role, content };
    } else {
      this.messages.unshift({ role, content });
    }
  }

  async ask(
    userMessage: string | null,
    options: AskOptions = {}
  ): Promise<string | { messages: any[] }> {
    if (userMessage === null) return { messages: this.messages };

    const baseModel = this.baseModel();
    const isKimiThinking = baseModel === 'kimi-k2-thinking';
    const isKimiModel = baseModel.startsWith('kimi');

    // Set defaults based on model type
    let defaultTemp = 0;
    let defaultMaxTokens = 8192 * 2;

    if (isKimiThinking) {
      defaultTemp = 1.0;
      defaultMaxTokens = 64000; // Large budget for reasoning + answer
    } else if (isKimiModel) {
      defaultTemp = 0.6;
      defaultMaxTokens = 32000; // Large context window
    } else if (isOSeries(this.model) || isGPT5(this.model)) {
      defaultTemp = 1;
    }

    const {
      system,
      temperature = defaultTemp,
      stream: wantStream = true,
      max_tokens = defaultMaxTokens,
      max_completion_tokens = 80_000,
      // Ensure gpt-5-pro uses high reasoning effort by default
      reasoning_effort = (this.isThinking() || this.baseModel() === "gpt-5-pro") ? "high" : "low",
    } = options;

    this.ensureControlMessage(system);
    this.messages.push({ role: "user", content: userMessage });

    // Split out "instructions" (system/developer) and conversation turns for Responses API "input".
    const instructions =
      this.messages.length > 0 &&
      (this.messages[0].role === "system" || this.messages[0].role === "developer")
        ? this.messages[0].content
        : undefined;

    const history = (instructions ? this.messages.slice(1) : this.messages).map((m) => ({
      type: "message",
      role: m.role === "developer" ? "system" : (m.role as "user" | "assistant" | "system"),
      content: [
        {
          type: "input_text", // Inputs are always "input_*" types
          text: m.content ?? "",
        },
      ],
    }));

    const params: any = {
      model: baseModel,
      temperature,
      // For Responses API, the token limit is "max_output_tokens"
      max_output_tokens: usesMaxCompletionTokens(baseModel) ? max_completion_tokens : max_tokens,
      input: history,
      // Reasoning controls
      reasoning: {
        effort: ["low", "medium", "high"].includes(String(reasoning_effort))
          ? reasoning_effort
          : ((this.baseModel() === "gpt-5-pro" || this.isThinking()) ? "high" : "low"),
        summary: "auto", // request a human-readable summary stream
      },
    };
    if (instructions) params.instructions = instructions;

    dbg("ASK_START", {
      temperature,
      wantStream,
      max_tokens,
      max_completion_tokens,
      reasoning_effort,
      messages_len: this.messages.length,
    });
    dbg("REQUEST_PARAMS", {
      model: baseModel,
      temp: temperature,
      max_output_tokens: params.max_output_tokens,
      reasoning: params.reasoning,
      input_preview: history.map((h: any) => ({ role: h.role, types: h.content.map((c: any) => c.type) })),
    });

    let visible = "";

    // Small state to ensure clean boundaries.
    let lastChar: string = "\n";
    let lastType: "reasoning" | "text" | null = null;
    let printedAnyReasoning = false;
    const assistantItemIds = new Set<string>();

    const ensureBoundary = (next: "reasoning" | "text") => {
      if (lastType && lastType !== next && lastChar !== "\n") {
        process.stdout.write("\n");
        lastChar = "\n";
      }
    };

    const writeChunk = (s: string, kind: "reasoning" | "text") => {
      if (!s) return;
      if (kind === "reasoning") {
        printedAnyReasoning = true;
        process.stdout.write(DIM + s + RESET);
      } else {
        // Ensure a clean break when switching from reasoning → text.
        ensureBoundary("text");
        // Skip stray single tokens like "detailed".
        if (isStandaloneVerbosityToken(s)) return;
        process.stdout.write(s);
        visible += s;
      }

      const end = s[s.length - 1];
      if (end) lastChar = end;
      // IMPORTANT: remember what we just wrote (fixes stuck-on-same-line issue)
      lastType = kind;
    };

    try {
      // Use Chat Completions API for Kimi, DeepSeek, OpenRouter
      if (!usesResponsesAPI(baseModel)) {
        const chatParams: any = {
          model: baseModel,
          temperature,
          max_tokens,
          stream: wantStream,
          messages: this.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        };

        if (wantStream) {
          const stream = await this.client.chat.completions.create(chatParams);
          let printedReasoning = false;
          for await (const chunk of stream as any) {
            const delta = chunk.choices?.[0]?.delta;

            // Handle reasoning content (from kimi-k2-thinking)
            if (delta?.reasoning_content) {
              process.stdout.write(DIM + delta.reasoning_content + RESET);
              visible += delta.reasoning_content;
              printedReasoning = true;
            }

            // Handle regular content
            if (delta?.content) {
              // Add newline between reasoning and content if needed
              if (printedReasoning && !visible.endsWith('\n')) {
                process.stdout.write("\n");
                visible += "\n";
                printedReasoning = false;
              }
              process.stdout.write(delta.content);
              visible += delta.content;
            }
          }
          process.stdout.write("\n");
        } else {
          const response = await this.client.chat.completions.create(chatParams);
          const message: any = response.choices?.[0]?.message;

          // Handle reasoning content in non-streaming response
          if (message?.reasoning_content) {
            process.stdout.write(DIM + message.reasoning_content + RESET + "\n");
            visible += message.reasoning_content + "\n";
          }

          visible += message?.content || "";
          process.stdout.write((message?.content || "") + "\n");
        }

        this.messages.push({ role: "assistant", content: visible });
        return visible;
      }

      // Use Responses API for GPT-5, o-series
      if (wantStream) {
        dbg("STREAM_OPEN");
        // Use streaming Responses API
        const stream = await (this.client as any).responses.stream(params);

        // --- Stream event handlers ---
        stream.on("event", (ev: any) => {
          // Low-level visibility: useful for diagnosing payload shape changes.
          if (!DBG_ENABLED) return;
          const t = ev?.type || "unknown";
          if (t === "response.created" || t === "response.in_progress") {
            dbg(`EVT_${t}`, { payload: JSON.stringify(ev).slice(0, 400) + "…" });
          }
        });

        // Reasoning summary stream (dim)
        stream.on("response.reasoning_summary_part.added", (evt: any) => {
          dbg("EVT_response.reasoning_summary_part.added", { item_id: evt?.item_id, payload: JSON.stringify(evt).slice(0, 400) + "…" });
        });
        stream.on("response.reasoning_summary_text.delta", (evt: any) => {
          const s = evt?.delta ?? "";
          if (DBG_ENABLED) dbg("EVT_response.reasoning_summary_text.delta", { item_id: evt?.item_id, payload: JSON.stringify(evt).slice(0, 300) + "…" });
          writeChunk(s, "reasoning");
          if (DBG_ENABLED) dbg("WRITE_REASONING", { from: "reasoning_summary_text.delta", len: s.length, endsWithNL: s.endsWith("\n") });
        });
        stream.on("response.reasoning_summary_part.done", (evt: any) => {
          dbg("EVT_response.reasoning_summary_part.done", { item_id: evt?.item_id, payload: JSON.stringify(evt).slice(0, 400) + "…" });
          // Ensure trailing newline after a completed reasoning part
          if (lastChar !== "\n") {
            process.stdout.write("\n");
            lastChar = "\n";
          }
        });

        // Assistant visible message identification
        stream.on("response.output_item.added", (evt: any) => {
          dbg("EVT_response.output_item.added", { payload: JSON.stringify(evt).slice(0, 400) + "…" });
          const item = evt?.item;
          if (item?.type === "message" && item?.role === "assistant" && item?.id) {
            assistantItemIds.add(item.id);
            dbg("ASSISTANT_ITEM_ADDED", { id: item.id });
            // SAFETY: if we printed reasoning already, force a line break
            if (printedAnyReasoning && lastChar !== "\n") {
              process.stdout.write("\n");
              lastChar = "\n";
            }
          }
        });

        // Visible text stream
        stream.on("response.content_part.added", (evt: any) => {
          dbg("EVT_response.content_part.added", { item_id: evt?.item_id, payload: JSON.stringify(evt).slice(0, 400) + "…" });
        });
        stream.on("response.output_text.delta", (evt: any) => {
          const s = evt?.delta ?? "";
          if (DBG_ENABLED) dbg("EVT_response.output_text.delta", { item_id: evt?.item_id, payload: JSON.stringify(evt).slice(0, 300) + "…" });
          writeChunk(s, "text");
          if (DBG_ENABLED) dbg("WRITE_TEXT", { from: "output_text.delta", len: s.length, endsWithNL: s.endsWith("\n") });
        });
        stream.on("response.output_text.done", (_evt: any) => {
          dbg("EVT_response.output_text.done", { item_id: _evt?.item_id, payload: JSON.stringify(_evt).slice(0, 300) + "…" });
          dbg("TEXT_DONE");
        });
        stream.on("response.content_part.done", (evt: any) => {
          dbg("EVT_response.content_part.done", { item_id: evt?.item_id, payload: JSON.stringify(evt).slice(0, 400) + "…" });
        });

        // Finalization
        stream.on("response.output_item.done", (evt: any) => {
          dbg("EVT_response.output_item.done", { payload: JSON.stringify(evt).slice(0, 400) + "…" });
        });
        stream.on("response.completed", (evt: any) => {
          dbg("EVT_response.completed", { payload: JSON.stringify(evt).slice(0, 400) + "…" });
          // DO NOT print any additional "summary" here — prevents stray "detailed"
          if (lastChar !== "\n") {
            process.stdout.write("\n");
            lastChar = "\n";
          }
          dbg("STREAM_COMPLETE");
        });
        stream.on("error", (err: any) => {
          console.error("[OpenAIChat stream error]:", err?.message || err);
        });

        await stream.done();
        dbg("STREAM_CLOSED");
      } else {
        // Non-streaming: fetch once and print reasoning summary then text.
        const resp: any = await (this.client as any).responses.create(params);
        let reasoningBuf = "";

        for (const item of resp?.output ?? []) {
          if (item?.type === "reasoning") {
            // Concatenate summary_text parts, if any.
            for (const p of item?.summary ?? []) {
              if (p?.type === "summary_text" && p?.text) {
                reasoningBuf += p.text;
              }
            }
          } else if (item?.type === "message" && Array.isArray(item?.content)) {
            for (const part of item.content) {
              if (part?.type === "output_text" && part?.text) {
                visible += part.text;
              }
            }
          }
        }

        if (reasoningBuf) {
          process.stdout.write(DIM + reasoningBuf + RESET + "\n");
        }
        if (visible) {
          process.stdout.write(visible + "\n");
        }
      }
    } catch (err: any) {
      console.error("[OpenAIChat] API error:", err?.message || err);
      throw err;
    }

    // Track assistant output for conversation continuity
    this.messages.push({ role: "assistant", content: visible });
    dbg("ASK_DONE", { visible_len: visible.length });

    return visible;
  }
}
