import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  type GenerationConfig,
  type SafetySetting,
} from "@google/generative-ai";
import type { AskOptions, ChatInstance } from "../GenAI";

/** Internal representation of a chat turn */
type Role = "user" | "assistant";
interface Turn {
  role: Role;
  content: string;
}

/**
 * Gemini implementation of the HoleFill ChatInstance.
 * Fixes two long-standing issues:
 *
 * 1. **Malformed completions** – we now pass the system prompt via
 *    `systemInstruction`, drop the in-prompt “System: …\nUser: …” hack and
 *    always wait for the final aggregated response, so the returned text
 *    contains the full `<COMPLETION> … </COMPLETION>` block.
 * 2. **Hidden thinking trace** – streaming output is parsed for
 *    `thinking_delta` chunks (the same event names Anthropic uses).  These
 *    deltas are echoed to stdout in grey, exactly like the Sonnet handler.
 */
export class GeminiChat implements ChatInstance {
  private readonly client: GoogleGenerativeAI;
  private readonly modelName: string;

  private chat: any = null;               // lazy-initialised ChatSession
  private history: Turn[] = [];           // local running history

  constructor(apiKey: string, modelName: string) {
    this.client    = new GoogleGenerativeAI(apiKey);
    this.modelName = modelName;
  }

  /* --------------------------------------------------------------------- */

  async ask(
    userMessage: string | null,
    opts: AskOptions = {},
  ): Promise<string | { messages: any[] }> {
    if (userMessage === null) {
      return { messages: this.history };
    }

    const {
      system,
      temperature = 0,
      max_tokens  = 100_000,
      stream      = true,
    } = opts;

    /* ---------- create the chat session (once) ------------------------- */
    if (!this.chat) {
      const generationConfig: GenerationConfig = {
        temperature,
        maxOutputTokens: max_tokens,
      };

      const safetySettings: SafetySetting[] = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT,         threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,        threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,  threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,  threshold: HarmBlockThreshold.BLOCK_NONE },
      ];

      const model = this.client.getGenerativeModel({
        model: this.modelName,
        systemInstruction: system
          ? { role: "model", parts: [{ text: system }] }
          : undefined,
        generationConfig,
        safetySettings,
      });

      /* convert local history → SDK format */
      const sdkHistory = this.history.map(turn => ({
        role  : turn.role === "assistant" ? "model" : "user",
        parts : [{ text: turn.content }],
      }));

      this.chat = model.startChat({ history: sdkHistory });
    }

    /* ---------- send user prompt -------------------------------------- */
    this.history.push({ role: "user", content: userMessage });

    let answer = "";
    let printedGrey = false;   // to add a newline between reasoning & answer

    if (stream) {
      const resp = await this.chat.sendMessageStream(userMessage);

      for await (const chunk of resp.stream) {
        /* Anthropic-style reasoning tokens come through as thinking_delta   */
        if (chunk.type === "content_block_delta") {
          if (chunk.delta?.type === "thinking_delta") {
            process.stdout.write(`\x1b[2m${chunk.delta.thinking}\x1b[0m`);
            printedGrey = true;
            answer += chunk.delta.thinking;          // keep for completeness
            continue;
          }
          if (chunk.delta?.type === "text_delta") {
            if (printedGrey) {
              process.stdout.write("\n");            // line break after thoughts
              printedGrey = false;
            }
            process.stdout.write(chunk.delta.text);
            answer += chunk.delta.text;
            continue;
          }
        }

        /* Fallback for non-typed chunks (old SDKs simply expose .text()) */
        const txt = typeof (chunk as any).text === "function"
          ? (chunk as any).text()
          : (chunk as any).text ?? "";
        if (txt) {
          process.stdout.write(txt);
          answer += txt;
        }
      }
      process.stdout.write("\n");

      /* guarantee we didn’t miss tail content */
      try {
        const full = (await resp.response).text();
        if (full && !answer.endsWith(full)) answer += full;
      } catch { /* ignore */ }
    } else {
      /* non-stream fallback */
      const resp = await this.chat.sendMessage(userMessage);
      answer     = (await resp.response).text();
    }

    this.history.push({ role: "assistant", content: answer });
    return answer;
  }
}
