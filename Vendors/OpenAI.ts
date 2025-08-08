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

function extractReasoningText(part: any): string | undefined {
  if (!part) return undefined;
  if (typeof part === "string") return part;
  if (Array.isArray(part)) {
    let out = "";
    for (const p of part) {
      const t = extractReasoningText(p);
      if (t) out += t;
    }
    return out || undefined;
  }
  if (typeof part === "object") {
    const direct = (part.output_text || part.text || part.thinking) as string | undefined;
    if (direct) return direct;
    return (
      extractReasoningText(part.reasoning_content) ||
      extractReasoningText(part.reasoning) ||
      extractReasoningText(part.content)
    );
  }
  return undefined;
}

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
    const isGpt5Model = isGPT5(this.model);

    const {
      system,
      temperature = (useOSeries || isGpt5Model) ? 1 : 0,
      stream: wantStream = true,
      max_tokens = 8_192 * 2,
      max_completion_tokens = 80_000,
      reasoning_effort = "high",
    } = options;

    this.ensureControlMessage(system);
    this.messages.push({ role: "user", content: userMessage });

    const useReasoning = usesMaxCompletionTokens(this.model);
    const doStream = !!wantStream;
    let visible = "";

    // Build request body depending on API flavor
    const body: Record<string, any> = { model: this.model, temperature };
    if (isGpt5Model) {
      body.input = this.messages.map((m) => ({ role: m.role, content: m.content || "" }));
      if (useReasoning) {
        body.max_output_tokens = max_completion_tokens;
        body.reasoning = { effort: reasoning_effort };
      } else {
        body.max_output_tokens = max_tokens;
      }
    } else {
      body.messages = this.messages as any;
      if (useReasoning) {
        if (this.vendor === "openrouter") {
          body.max_completion_tokens = max_completion_tokens;
          body.reasoning_effort = reasoning_effort;
          body.include_reasoning = true;
        } else {
          body.max_output_tokens = max_completion_tokens;
          body.reasoning = { effort: reasoning_effort };
        }
      } else {
        body.max_tokens = max_tokens;
      }
    }

    try {
      if (doStream) {
        if (isGpt5Model) {
          const stream: any = await this.client.responses.stream(body as any);
          let printingReasoning = false;
          for await (const event of stream as any) {
            if (typeof event.type === "string" && event.type.startsWith("response.reasoning")) {
              const text = extractReasoningText(event.delta || event.data || event);
              if (text) {
                process.stdout.write(`\x1b[2m${text}\x1b[0m`);
                printingReasoning = true;
              }
              continue;
            }
            if (event.type === "response.output_text.delta") {
              const text: string = event.delta || "";
              if (printingReasoning) {
                printingReasoning = false;
                process.stdout.write("\n");
              }
              process.stdout.write(text);
              visible += text;
            }
          }
          process.stdout.write("\n");
        } else {
          const streamParams = body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
          const extras =
            useReasoning && this.vendor !== "openrouter"
              ? { stream_options: { include_reasoning: true } }
              : {};
          const stream: any = await this.client.chat.completions.create({
            ...(streamParams as any),
            stream: true,
            ...(extras as any),
          });

          let printingReasoning = false;
          for await (const chunk of stream as any) {
            const delta: any = chunk.choices[0]?.delta;
            const reasoningText = extractReasoningText(
              delta?.reasoning ||
                delta?.reasoning_content ||
                (Array.isArray(delta?.content)
                  ? delta.content.find((c: any) => /reason/i.test(c.type))
                  : undefined)
            );

            if (reasoningText) {
              process.stdout.write(`\x1b[2m${reasoningText}\x1b[0m`);
              printingReasoning = true;
              continue;
            }

            let content: any = delta?.content || delta?.message?.content;
            if (Array.isArray(content)) {
              content = content
                .filter((p: any) => p.type === "text" || !p.type)
                .map((p: any) => p.text || p.content || "")
                .join("");
            }
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
        }
      } else {
        if (isGpt5Model) {
          const resp: any = await this.client.responses.create(body as any);
          const reasoningText = extractReasoningText(resp.reasoning || resp.output?.[0]?.reasoning_content);
          if (reasoningText) process.stdout.write(`\x1b[2m${reasoningText}\x1b[0m\n`);
          visible =
            resp.output_text ||
            ((resp.output || [])
              .map((o: any) =>
                (Array.isArray(o.content) ? o.content : [o])
                  .map((c: any) => c.text || c.content || "")
                  .join("")
              )
              .join("")) ||
            "";
          process.stdout.write(visible + "\n");
        } else {
          const respParams = body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
          const resp: any = await this.client.chat.completions.create(respParams);
          const msg: any = resp.choices[0]?.message ?? {};
          const reasoningText = extractReasoningText(
            msg.reasoning || msg.reasoning_content
          );
          if (reasoningText) process.stdout.write(`\x1b[2m${reasoningText}\x1b[0m\n`);
          visible = msg.content ?? msg?.message?.content ?? "";
          process.stdout.write(visible + "\n");
        }
      }
    } catch (err: any) {
      console.error("[OpenAIChat] API error:", err?.message || err);
      throw err;
    }

    this.messages.push({ role: "assistant", content: visible });
    return visible;
  }
}
