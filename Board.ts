#!/usr/bin/env bun

// Board.ts
// ========
// Sends a file to a panel of AI advisors and prints their responses.
// Tagged live-streaming shows each advisor's progress in real time.

import * as fs      from 'fs/promises';
import * as process from 'process';
import { AsyncLocalStorage } from 'async_hooks';
import { Command }           from 'commander';
import { GenAI }             from './GenAI';

// Constants
// ---------

var DEFAULT_MODELS = [
  'google:gemini-3.1-pro-preview:max',
  'anthropic:claude-opus-4-6:max',
  'openai:gpt-5.2:max',
];

var SYSTEM = [
  'You are an expert advisor.',
  'Read the context and provide concise, actionable insight.',
  'Be brief and dense — maximize insight per token.',
].join(' ');

var TAG_LINE_WIDTH = 120;

// Types
// -----

type Rep = {
  model: string;
  text:  string;
  ok:    boolean;
};

type AnsiMode  = 'text' | 'esc' | 'csi' | 'osc' | 'st';
type AnsiState = { mode: AnsiMode; esc_pending: boolean };

var parallel_ctx = new AsyncLocalStorage<number>();

// Utilities
// ---------

// Converts unknown errors to readable text.
function error_message(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Throws a fatal error.
function fail(message: string): never {
  throw new Error(message);
}

// Streaming
// ---------

// Builds a short stream tag for a model.
function model_tag(model: string): string {
  var name = (model.split(':')[1] || model).toLowerCase();
  if (name.includes('codex')) {
    return 'cdx5';
  }
  if (name.includes('gpt-5')) {
    return 'gpt5';
  }
  if (name.includes('gemini')) {
    return 'gemi';
  }
  if (name.includes('opus')) {
    return 'opus';
  }
  return name.replace(/[^a-z0-9]/g, '').slice(0, 5).padStart(4);
}

// Creates an ANSI parser state.
function make_ansi_state(): AnsiState {
  return {
    mode: 'text',
    esc_pending: false,
  };
}

// Strips ANSI escape sequences while preserving parser state.
function strip_ansi_chunk(state: AnsiState, chunk: string): string {
  var out = '';
  for (var i = 0; i < chunk.length; ++i) {
    var chr = chunk[i];
    var code = chunk.charCodeAt(i);
    switch (state.mode) {
      case 'text': {
        if (chr === '\x1b') {
          state.mode = 'esc';
          break;
        }
        if (code === 0x9b) {
          state.mode = 'csi';
          break;
        }
        out += chr;
        break;
      }
      case 'esc': {
        if (chr === '[') {
          state.mode = 'csi';
          break;
        }
        if (chr === ']') {
          state.mode = 'osc';
          state.esc_pending = false;
          break;
        }
        if (chr === 'P' || chr === '^' || chr === '_') {
          state.mode = 'st';
          state.esc_pending = false;
          break;
        }
        state.mode = 'text';
        break;
      }
      case 'csi': {
        if (code >= 0x40 && code <= 0x7e) {
          state.mode = 'text';
        }
        break;
      }
      case 'osc': {
        if (chr === '\x07') {
          state.mode = 'text';
          state.esc_pending = false;
          break;
        }
        if (state.esc_pending) {
          if (chr === '\\') {
            state.mode = 'text';
            state.esc_pending = false;
            break;
          }
          state.esc_pending = chr === '\x1b';
          break;
        }
        if (chr === '\x1b') {
          state.esc_pending = true;
        }
        break;
      }
      case 'st': {
        if (state.esc_pending) {
          if (chr === '\\') {
            state.mode = 'text';
            state.esc_pending = false;
            break;
          }
          state.esc_pending = chr === '\x1b';
          break;
        }
        if (chr === '\x1b') {
          state.esc_pending = true;
        }
        break;
      }
    }
  }
  return out;
}

// Sanitizes streamed chunk for tagged output.
function sanitize_chunk(state: AnsiState, raw: string): string {
  var txt = strip_ansi_chunk(state, raw);
  var txt = txt.replace(/[\r\n]+/g, ' ');
  var txt = txt.replace(/\t/g, ' ');
  var txt = txt.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return txt;
}

// Normalizes one tagged line.
function normalize_line(text: string): string {
  var text = text.replace(/ {2,}/g, ' ');
  return text.trim();
}

// Computes wrap width for tagged output lines.
function tag_wrap_width(tag: string): number {
  var prefix = `[${tag}] `;
  var cols = process.stderr.columns ?? process.stdout.columns ?? 0;
  if (cols <= 0) {
    return TAG_LINE_WIDTH;
  }
  var width = cols - prefix.length - 1;
  var width = Math.min(width, TAG_LINE_WIDTH);
  var width = Math.max(width, 24);
  return width;
}

// Picks wrap split point near width.
function tag_wrap_point(text: string, width: number): number {
  if (text.length <= width) {
    return text.length;
  }
  var point = text.lastIndexOf(' ', width);
  var min_point = Math.floor(width * 0.5);
  if (point >= min_point) {
    return point;
  }
  return width;
}

// Runs tasks in parallel while streaming tagged non-interleaved output.
async function run_parallel_tagged<T>(tasks: (() => Promise<T>)[], tags: string[]): Promise<T[]> {
  var ansi_states = tasks.map(() => make_ansi_state());
  var bufs = tasks.map(() => '');
  var got_text = tasks.map(() => false);

  var orig_out = process.stdout.write.bind(process.stdout);
  var orig_err = process.stderr.write.bind(process.stderr);

  function emit(tag: string, line: string): void {
    orig_err(Buffer.from(`[${tag}] ${line}\n`));
  }

  function append(idx: number, chunk: string): void {
    if (!chunk) {
      return;
    }
    if (/\S/.test(chunk)) {
      got_text[idx] = true;
    }
    if (bufs[idx].length === 0) {
      var chunk = chunk.replace(/^ +/g, '');
    }
    bufs[idx] += chunk;
  }

  function drain(idx: number, flush: boolean): void {
    var tag = tags[idx];
    var width = tag_wrap_width(tag);

    while (true) {
      var buf = bufs[idx];
      if (!buf) {
        break;
      }

      var do_wrap = buf.length > width;
      if (!do_wrap && !flush) {
        break;
      }

      var point = do_wrap ? tag_wrap_point(buf, width) : buf.length;
      var line = buf.slice(0, point);
      var rest = buf.slice(point).replace(/^ +/g, '');
      bufs[idx] = rest;

      var line = normalize_line(line);
      if (line) {
        emit(tag, line);
      }

      if (!do_wrap) {
        break;
      }
    }
  }

  function intercept(orig: typeof process.stdout.write): typeof process.stdout.write {
    return function (chunk: any, ...args: any[]): boolean {
      var idx = parallel_ctx.getStore();
      if (idx !== undefined) {
        var raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        var clean = sanitize_chunk(ansi_states[idx], raw);
        append(idx, clean);
        drain(idx, false);
        return true;
      }
      return (orig as any)(chunk, ...args);
    } as any;
  }

  process.stdout.write = intercept(orig_out);
  process.stderr.write = intercept(orig_err);

  try {
    var reps = await Promise.all(tasks.map((fn, i) => parallel_ctx.run(i, fn)));
  } finally {
    process.stdout.write = orig_out;
    process.stderr.write = orig_err;
  }

  for (var i = 0; i < bufs.length; ++i) {
    drain(i, true);
    if (!got_text[i]) {
      emit(tags[i], '(no streamed output)');
    }
  }

  return reps;
}

// Advisors
// --------

// Calls one advisor model.
async function ask_one(model: string, prompt: string): Promise<Rep> {
  try {
    var ai = await GenAI(model);
    var raw = await ai.ask(prompt, {
      system: SYSTEM,
      stream: true,
    });

    if (typeof raw !== 'string') {
      fail(`Non-text response from ${model}`);
    }

    var text = raw.trim();
    if (!text) {
      fail(`Empty response from ${model}`);
    }

    return { model, text, ok: true };
  } catch (error) {
    return { model, text: `Advisor failed: ${error_message(error)}`, ok: false };
  }
}

// CLI
// ---

// Parses command-line arguments.
function parse_cli(argv: string[]): { input: string; models: string[] } {
  var cmd = new Command();
  cmd
    .name('board')
    .summary('send a file or prompt to a panel of AI advisors')
    .argument('<file-or-prompt>', 'File path or prompt string (detected by spaces)')
    .option('--models <csv>', 'Comma-separated advisor models', DEFAULT_MODELS.join(','));

  if (argv.length <= 2) {
    cmd.outputHelp();
    process.exit(0);
  }

  cmd.parse(argv);

  var raw    = cmd.opts() as Record<string, unknown>;
  var models = String(raw.models ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (models.length === 0) {
    fail('Model list is empty.');
  }

  return { input: cmd.args[0], models };
}

// Main
// ----

// Runs the board command.
async function main(): Promise<void> {
  var cli     = parse_cli(process.argv);
  var is_prompt = cli.input.includes(' ');
  var content   = is_prompt
    ? cli.input.trim()
    : (await fs.readFile(cli.input, 'utf8')).trim();
  if (!content) {
    fail('Input is empty.');
  }

  var tasks = cli.models.map(model => () => ask_one(model, content));
  var tags  = cli.models.map(model_tag);
  var reps  = await run_parallel_tagged(tasks, tags);

  var blocks = reps.map((rep, i) => {
    var status = rep.ok ? 'ok' : 'failed';
    return [
      `=== ADVISOR ${i + 1}: ${rep.model} (${status}) ===`,
      rep.text.trim(),
      `=== END ADVISOR ${i + 1} ===`,
    ].join('\n');
  });

  process.stdout.write(blocks.join('\n\n') + '\n');

  if (reps.filter(x => x.ok).length === 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`[board] Fatal: ${error_message(error)}`);
  process.exit(1);
});
