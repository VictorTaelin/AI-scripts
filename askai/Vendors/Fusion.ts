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

// Buffers a single model's streamed thinking deltas and flushes them, one
// complete line at a time, as a dim `<label> ...`. Because panel models run in
// parallel, streaming their raw deltas directly would interleave into an
// unreadable soup of letters. Flushing only whole lines keeps each model's
// thoughts on their own line (still interleaved between models, like an IRC
// chat, but each line readable and correctly attributed).
class LineBuffer {
  private buf = "";
  constructor(private readonly label: string) {}

  push(chunk: string): void {
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
    // interleave mid-line. Thinking is dimmed; final answers are printed
    // separately, in normal color.
    process.stdout.write(`${DIM}<${this.label}> ${line}${RESET}\n`);
  }
}

function buildSynthPrompt(userMessage: string, members: FusionMember[], outputs: string[]): string {
  const parts: string[] = [];
  parts.push(
    `The request below was independently answered by ${members.length} expert agents working ` +
      `in isolation. Each agent has different strengths and weaknesses (described before its ` +
      `answer). Their answers are almost certainly imperfect: some parts will be correct, some ` +
      `will contain mistakes, some will hold unique insights the others missed, and some will ` +
      `over- or under-shoot the request.`,
  );
  parts.push("");
  parts.push(
    `Your job is to produce a SINGLE, FINAL answer that is genuinely BETTER than every ` +
      `individual answer. This is a synthesis task, NOT a selection task. Do NOT just pick the ` +
      `answer you like most and paste it back — that is a failure, even if one answer looks best.`,
  );
  parts.push("");
  parts.push(`Reason thoroughly BEFORE writing the final answer. In your thinking:`);
  parts.push(
    `- Read every answer carefully and weigh it against that agent's known tendencies.`,
  );
  parts.push(
    `- Find where they AGREE (likely correct), where they CONTRADICT (resolve each conflict — ` +
      `decide who is right and why), what each one got UNIQUELY right, and what they ALL missed.`,
  );
  parts.push(
    `- Verify the claims yourself. Trust no single answer, not even the strongest one; ` +
      `independently check facts/logic/code and fix every mistake you find.`,
  );
  parts.push(
    `- Then construct one coherent, complete, polished answer that merges the strongest correct ` +
      `pieces from across all of them and improves on all of them.`,
  );
  parts.push("");
  parts.push(
    `Then write ONLY the final answer — as your own, with no mention of the agents, the panel, ` +
      `or that multiple answers existed, and no exposition of your analysis. Follow any ` +
      `formatting rules from the system prompt exactly.`,
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
  parts.push(
    `Now reason through all ${members.length} answers as instructed above, then write the ` +
      `final, combined answer.`,
  );
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

    // --- Phase 1: fan out to the panel in parallel ------------------------
    // Only thinking is streamed live (dim IRC lines); each agent's full answer
    // is printed afterwards, in normal color, so it is easy to read.
    if (display) {
      const names = this.members.map((m) => m.label).join(", ");
      process.stdout.write(`\n${BOLD}\u25B6 Running panel (${names})...${RESET}\n`);
    }

    const outputs = await Promise.all(
      this.members.map(async (m) => {
        const lb = new LineBuffer(m.label);
        const sink = (chunk: string, kind: StreamKind) => {
          // Stream thinking only; the answer body is shown later, not live.
          if (display && kind === "reasoning") lb.push(chunk);
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

    // --- Phase 1b: show each agent's final answer, after all thinking ------
    if (display) {
      this.members.forEach((m, i) => {
        process.stdout.write(`\n${BOLD}\u2500\u2500 ${m.label} (${m.nick}) \u2500\u2500${RESET}\n`);
        process.stdout.write(`${outputs[i].trim()}\n`);
      });
    }

    // --- Phase 2: synthesize ----------------------------------------------
    if (display) {
      process.stdout.write(
        `\n${BOLD}\u25B6 Synthesizing final answer with ${this.synth.label}...${RESET}\n`,
      );
    }

    const synthPrompt = buildSynthPrompt(userMessage, this.members, outputs);

    // Route the synth through a sink too: its thinking is shown as dim
    // <label> lines (so it is clearly attributed and visible), while its
    // answer body streams in normal color as the final output.
    const synthLb = new LineBuffer(this.synth.label);
    let answerStarted = false;
    const synthSink = (chunk: string, kind: StreamKind) => {
      if (!display) return;
      if (kind === "reasoning") {
        synthLb.push(chunk);
        return;
      }
      if (!answerStarted) {
        synthLb.end();
        process.stdout.write("\n");
        answerStarted = true;
      }
      process.stdout.write(chunk);
    };

    const synthReply = await this.synth.chat.ask(synthPrompt, {
      ...options,
      stream: true,
      onStream: synthSink,
    });
    synthLb.end();
    if (display && answerStarted) process.stdout.write("\n");

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
