import OpenAI from "openai";
import { AskOptions, ChatInstance } from "../GenAI";

/**
 * OpenAI wrapper supporting GPT‑series and o‑series reasoning models.
 */

type Role = "user" | "assistant" | "system" | "developer";

const isOSeries = (m: string) => /^o[0-9]/.test(m);
const isGPT5 = (m: string) => m.startsWith('gpt-5');
const usesMaxCompletionTokens = (m: string) => isOSeries(m) || isGPT5(m);
const controlRole = (m: string): Role => (isOSeries(m) ? "developer" : "system");

export class OpenAIChat implements ChatInstance {
  private readonly client: OpenAI;
  private readonly model: string;
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
  }

  private ensureControlMessage(content?: string) {
    if (!content) return;
    const role = controlRole(this.model);
    if (this.messages[0] && (this.messages[0].role === "system" || this.messages[0].role === "developer")) {
      this.messages[0] = { role, content };
    } else {
      this.messages.unshift({ role, content });
    }
  }

  async ask(userMessage: string | null, options: AskOptions = {}): Promise<string | { messages: any[] }> {
    if (userMessage === null) return { messages: this.messages };

    const useOSeries = isOSeries(this.model);

    const {
      system,
      temperature = (useOSeries || isGPT5(this.model)) ? 1 : 0,
      stream: wantStream = true,
      max_tokens = 8_192*2,
      max_completion_tokens = 80_000,
      reasoning_effort = "high",
    } = options;

    this.ensureControlMessage(system);
    this.messages.push({ role: "user", content: userMessage });

    // Build base request body
    const body: Record<string, any> = {
      model: this.model,
      messages: this.messages as any,
      temperature,
      ...(usesMaxCompletionTokens(this.model) ? { max_completion_tokens, reasoning_effort } : { max_tokens }),
    };

    // OpenRouter flag for reasoning tokens — OpenAI rejects it
    if (this.vendor === "openrouter") {
      body.include_reasoning = true;
    }

    const doStream = !!wantStream;
    let visible = "";

    try {
      if (doStream) {
        const streamParams = body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
        const stream = await this.client.chat.completions.create({ ...streamParams, stream: true });

        let printingReasoning = false;
        for await (const chunk of stream) {
          const delta: any = chunk.choices[0]?.delta;
          const reasoningPart = delta?.reasoning_content ?? delta?.reasoning;

          let reasoningText: string | undefined;
          if (reasoningPart) {
            if (typeof reasoningPart === "string") {
              reasoningText = reasoningPart;
            } else {
              reasoningText =
                reasoningPart.output_text ||
                reasoningPart.text ||
                reasoningPart?.content?.[0]?.text ||
                reasoningPart?.[0]?.text;
            }
          }

          if (reasoningText) {
            process.stdout.write(`\x1b[2m${reasoningText}\x1b[0m`);
            printingReasoning = true;
            continue;
          }

          const content = delta?.content || delta?.message?.content;
          if (content) {
            if (printingReasoning) {
              printingReasoning = false;
              process.stdout.write("\n");
            }
            process.stdout.write(content);
            visible += content;
          }
        }
        process.stdout.write("\n");
      } else {
        const respParams = body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
        const resp: any = await this.client.chat.completions.create(respParams);
        const msg: any = resp.choices[0]?.message ?? {};
        const reasoningPart = msg.reasoning_content ?? msg.reasoning;
        let reasoningText: string | undefined;
        if (reasoningPart) {
          if (typeof reasoningPart === "string") {
            reasoningText = reasoningPart;
          } else {
            reasoningText =
              reasoningPart.output_text ||
              reasoningPart.text ||
              reasoningPart?.content?.[0]?.text ||
              reasoningPart?.[0]?.text;
          }
        }
        if (reasoningText) process.stdout.write(`\x1b[2m${reasoningText}\x1b[0m\n`);
        visible = msg.content ?? msg?.message?.content ?? "";
        process.stdout.write(visible + "\n");
      }
    } catch (err: any) {
      console.error("[OpenAIChat] API error:", err?.message || err);
      throw err;
    }

    this.messages.push({ role: "assistant", content: visible });
    return visible;
  }
}
