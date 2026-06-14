import type {
  ChatInstance,
  AskOptions,
  AskToolsOptions,
  AskResult,
  StreamKind,
} from "../AskAI";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// A panel member: an already-constructed chat plus the metadata shown to the
// synthesizer and used as the IRC-style stream prefix.
export interface FusionMember {
  chat: ChatInstance;
  label: string; // short name used as the <label> stream prefix, e.g. "GPT-5.5"
  nick: string; // nickname shown in the synthesizer prompt, e.g. "Fox"
  desc: string; // description of the agent's strengths/weaknesses
}

export interface FusionSynth {
  chat: ChatInstance;
  label: string;
}

// Buffers a single model's streamed deltas and flushes them, one complete line
// at a time, as `<label> ...`. Because panel models run in parallel, streaming
// their raw deltas directly would interleave into an unreadable soup of letters.
// Flushing only whole lines keeps each model's output on its own line.
class LineBuffer {
  private buf = "";
  private kind: StreamKind = "reasoning";
  constructor(private readonly label: string) {}

  push(chunk: string, kind: StreamKind): void {
    // A change of kind (thinking -> answer) ends the current partial line.
    if (kind !== this.kind && this.buf.length > 0) {
      this.flushLine(this.buf);
      this.buf = "";
    }
    this.kind = kind;
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      this.flushLine(line);
    }
  }

  end(): void {
    if (this.buf.length > 0) {
      this.flushLine(this.buf);
      this.buf = "";
    }
  }

  private flushLine(line: string): void {
    if (line.trim() === "") return; // skip blank lines to reduce noise
    // Whole-line writes are atomic enough on a TTY that parallel members never
    // interleave mid-line. Panel output is dimmed; the final answer (from the
    // synthesizer) is rendered normally so it stands out.
    process.stdout.write(`${DIM}<${this.label}> ${line}${RESET}\n`);
  }
}

function buildSynthPrompt(userMessage: string, members: FusionMember[], outputs: string[]): string {
  const parts: string[] = [];
  parts.push(
    `The request below was independently answered by ${members.length} expert agents, ` +
      `each with different strengths and weaknesses (described before their answers). ` +
      `Your job is to synthesize their answers into a single, final, perfected response: ` +
      `combine their strengths, take the best ideas, resolve contradictions, and fix mistakes. ` +
      `Weigh each answer in light of the agent's described tendencies. ` +
      `Do not mention the agents or that multiple answers existed — write the final answer ` +
      `directly, as your own, following any formatting rules from the system prompt.`,
  );
  parts.push("");
  parts.push("<original_request>");
  parts.push(userMessage);
  parts.push("</original_request>");
  parts.push("");
  members.forEach((m, i) => {
    parts.push(`# Agent ${m.nick}`);
    parts.push("");
    parts.push(m.desc);
    parts.push("");
    parts.push("Output:");
    parts.push("");
    parts.push(outputs[i] ?? "(no answer)");
    parts.push("");
  });
  parts.push("Now write the final, combined answer.");
  return parts.join("\n");
}

export class FusionChat implements ChatInstance {
  constructor(
    private readonly members: FusionMember[],
    private readonly synth: FusionSynth,
  ) {}

  async ask(
    userMessage: string | null,
    options: AskOptions = {},
  ): Promise<string | { messages: any[] }> {
    if (userMessage === null) {
      return { messages: [] };
    }

    const display = options.stream !== false;

    // --- Phase 1: fan out to the panel in parallel -------------------------
    if (display) {
      const names = this.members.map((m) => m.label).join(", ");
      process.stdout.write(`${BOLD}\u25B6 Running panel (${names})...${RESET}\n`);
    }

    const outputs = await Promise.all(
      this.members.map(async (m) => {
        const lb = new LineBuffer(m.label);
        const sink = (chunk: string, kind: StreamKind) => {
          if (display) lb.push(chunk, kind);
        };
        try {
          const reply = await m.chat.ask(userMessage, {
            ...options,
            stream: true,
            onStream: sink,
          });
          lb.end();
          return typeof reply === "string"
            ? reply
            : reply.messages.map((x: any) => x.content).join("\n");
        } catch (err) {
          lb.end();
          const msg = err instanceof Error ? err.message : String(err);
          if (display) {
            process.stdout.write(`${DIM}<${m.label}> [failed: ${msg}]${RESET}\n`);
          }
          return `(agent failed: ${msg})`;
        }
      }),
    );

    // --- Phase 2: synthesize -----------------------------------------------
    if (display) {
      process.stdout.write(
        `${BOLD}\u25B6 Synthesizing final answer with ${this.synth.label}...${RESET}\n`,
      );
    }

    const synthPrompt = buildSynthPrompt(userMessage, this.members, outputs);
    const synthReply = await this.synth.chat.ask(synthPrompt, {
      ...options,
      stream: display,
      onStream: undefined, // synth streams normally to stdout (dim + answer)
    });

    return typeof synthReply === "string"
      ? synthReply
      : synthReply.messages.map((x: any) => x.content).join("\n");
  }

  async askTools(userMessage: string, options: AskToolsOptions): Promise<AskResult> {
    // Fusion does not use tools; fall back to a plain synthesized answer.
    const reply = await this.ask(userMessage, options);
    return { text: typeof reply === "string" ? reply : "", toolCalls: [] };
  }
}
