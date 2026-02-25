#!/usr/bin/env bun

// Board.ts
// ========
// Minimal 3-model advisor board with tagged live streaming.
//
// Documentation
// -------------
// - Ask one question.
// - Optionally attach focused context.
// - Stream each advisor in chat-like tagged lines.
// - Print final raw advisor outputs.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as process from 'process';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AsyncLocalStorage } from 'async_hooks';
import { Command } from 'commander';
import { GenAI } from './GenAI';

const exec_file_async = promisify(execFile);

type Opts = {
  req: string;
  goal: string;
  files: string[];
  use_diff: boolean;
  use_stdin: boolean;
  models: string[];
  max_chars: number;
};

type Cli = {
  mode: 'run' | 'install_skill' | 'uninstall_skill';
  opts: Opts | null;
};

type Rep = {
  model: string;
  text: string;
  ok: boolean;
};

type AnsiMode = 'text' | 'esc' | 'csi' | 'osc' | 'st';

type AnsiState = {
  mode: AnsiMode;
  esc_pending: boolean;
};

const DEFAULT_MODELS = [
  'google:gemini-3.1-pro-preview:max',
  'anthropic:claude-opus-4-6:max',
  'openai:gpt-5.2:max',
];

const SYSTEM = [
  'You are an expert advisor.',
  'Read the context and provide insights.',
].join(' ');

const DEFAULT_GOAL = 'GOAL.txt';
const DEFAULT_MAX_CHARS = 64_000;
const FILE_MAX_CHARS = 12_000;
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
const TAG_LINE_WIDTH = 120;
var BOARD_SKILL_NAME = 'board';

var parallel_ctx = new AsyncLocalStorage<number>();

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

// Splits CSV entries.
function split_csv(text: string): string[] {
  return text.split(',').map(x => x.trim()).filter(Boolean);
}

// Keeps only a text tail within max chars.
function tail_clip(text: string, max_chars: number): string {
  if (text.length <= max_chars) {
    return text;
  }
  var cut = text.length - max_chars;
  var tail = text.slice(cut);
  return [`...[${cut} chars omitted]...`, tail].join('\n');
}

// Reads UTF-8 text or empty if missing.
async function read_text_or_empty(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

// Runs a command and returns stdout or empty on failure.
async function cmd_text_or_empty(bin: string, args: string[], cwd: string): Promise<string> {
  try {
    var out = await exec_file_async(bin, args, {
      cwd,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    return out.stdout.trim();
  } catch (_error) {
    return '';
  }
}

// Reads piped stdin when enabled.
async function read_stdin_if_enabled(enabled: boolean): Promise<string> {
  if (!enabled || process.stdin.isTTY) {
    return '';
  }

  var chunks: Buffer[] = [];
  for await (var chunk of process.stdin) {
    var buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

// Builds all context blocks.
async function build_context(opts: Opts, cwd: string): Promise<string> {
  var parts: string[] = [];

  var goal_txt = (await read_text_or_empty(path.resolve(cwd, opts.goal))).trim();
  if (goal_txt) {
    parts.push([`=== GOAL: ${opts.goal} ===`, goal_txt, '=== END GOAL ==='].join('\n'));
  }

  for (var file of opts.files) {
    var rel = file.trim().replace(/^\.\//, '');
    if (!rel) {
      continue;
    }

    var txt = await read_text_or_empty(path.resolve(cwd, rel));
    var txt = txt.trim() ? tail_clip(txt, FILE_MAX_CHARS) : '<missing or empty>';
    parts.push([`=== FILE: ./${rel} ===`, txt, '=== END FILE ==='].join('\n'));
  }

  if (opts.use_diff) {
    var unstaged = await cmd_text_or_empty('git', ['diff', '--', '.'], cwd);
    var staged = await cmd_text_or_empty('git', ['diff', '--cached', '--', '.'], cwd);
    if (unstaged || staged) {
      parts.push([
        '=== GIT DIFF ===',
        '--- UNSTAGED ---',
        unstaged || '(empty)',
        '',
        '--- STAGED ---',
        staged || '(empty)',
        '=== END GIT DIFF ===',
      ].join('\n'));
    }
  }

  var stdin_txt = await read_stdin_if_enabled(opts.use_stdin);
  if (stdin_txt) {
    parts.push(['=== STDIN ===', stdin_txt, '=== END STDIN ==='].join('\n'));
  }

  var ctx = parts.join('\n\n').trim();
  var ctx = tail_clip(ctx, opts.max_chars);
  return ctx;
}

// Parses and validates CLI options.
function parse_cli(argv: string[]): Cli {
  var cmd = new Command();
  cmd
    .name('board')
    .summary('advisor board + global board skill installer')
    .description('Calls advisor models and can install/uninstall the global Codex board skill.')
    .usage('[options] [request]')
    .argument('[request]', 'Advisor request text')
    .option('--request <text>', 'Advisor request text (same as positional)')
    .option('--goal <path>', 'Optional goal file', DEFAULT_GOAL)
    .option('--files <csv>', 'Comma-separated file list', '')
    .option('--diff', 'Include staged + unstaged git diff')
    .option('--stdin', 'Include piped stdin text')
    .option('--models <csv>', 'Comma-separated advisor models', DEFAULT_MODELS.join(','))
    .option('--max-context-chars <num>', 'Max context chars', String(DEFAULT_MAX_CHARS))
    .option('--install-skill', 'Install global Codex skill at $CODEX_HOME/skills/board')
    .option('--uninstall-skill', 'Remove global Codex skill at $CODEX_HOME/skills/board')
    .addHelpText('after', [
      '',
      'Examples:',
      '  board "what next?" --goal GOAL.txt --diff',
      '  board "review this" --files "src/a.ts,src/b.ts"',
      '  cat notes.txt | board "critique" --stdin',
      '  board --install-skill',
      '  board --uninstall-skill',
    ].join('\n'))
  ;

  cmd.parse(argv);

  var raw = cmd.opts() as Record<string, unknown>;
  var install_skill = Boolean(raw.installSkill);
  var uninstall_skill = Boolean(raw.uninstallSkill);

  if (install_skill && uninstall_skill) {
    fail('Use only one: --install-skill or --uninstall-skill.');
  }
  if (install_skill) {
    return { mode: 'install_skill', opts: null };
  }
  if (uninstall_skill) {
    return { mode: 'uninstall_skill', opts: null };
  }

  if (argv.length <= 2) {
    cmd.outputHelp();
    process.exit(0);
  }

  var req_arg = String(cmd.args[0] ?? '').trim();
  var req_opt = String(raw.request ?? '').trim();
  var req = req_opt || req_arg;
  if (!req) {
    cmd.outputHelp();
    process.exit(1);
  }

  var models = split_csv(String(raw.models ?? DEFAULT_MODELS.join(',')));
  if (models.length === 0) {
    fail('Advisor model list is empty.');
  }

  var max_chars = Number(raw.maxContextChars ?? DEFAULT_MAX_CHARS);
  if (!Number.isInteger(max_chars) || max_chars <= 0) {
    fail(`Invalid --max-context-chars: ${raw.maxContextChars}`);
  }

  var opts = {
    req,
    goal: String(raw.goal ?? DEFAULT_GOAL),
    files: split_csv(String(raw.files ?? '')),
    use_diff: Boolean(raw.diff),
    use_stdin: Boolean(raw.stdin),
    models,
    max_chars,
  };

  return { mode: 'run', opts };
}

// Resolves CODEX_HOME path.
function codex_home(): string {
  var home = String(process.env.CODEX_HOME ?? '').trim();
  if (home) {
    return home;
  }

  var user_home = String(process.env.HOME ?? process.env.USERPROFILE ?? '').trim();
  if (!user_home) {
    fail('Unable to resolve home directory for CODEX_HOME.');
  }

  return path.join(user_home, '.codex');
}

// Returns the global board skill directory.
function board_skill_dir(): string {
  return path.join(codex_home(), 'skills', BOARD_SKILL_NAME);
}

// Returns the global board skill markdown path.
function board_skill_file(): string {
  return path.join(board_skill_dir(), 'SKILL.md');
}

// Builds SKILL.md content for the global board skill.
function board_skill_md(): string {
  return [
    '---',
    'name: board',
    'description: Consult a 3-model advisor board via `board` for guidance before starting work.',
    '---',
    '',
    '# board',
    '',
    'Consult the board before starting work to get diverse expert insights.',
    '',
    '## Command',
    '',
    '- `board --request "your question"`',
    '',
    '## Context options',
    '',
    '- `--goal GOAL.txt`',
    '- `--files "src/a.ts,src/b.ts"`',
    '- `--diff`',
    '- `--stdin` (for crafted snippets piped from shell)',
    '',
    '## Workflow',
    '',
    '1. Gather all relevant codebase context for your goal.',
    '2. Pass it to the board along with your questions.',
    '3. Read all advisor outputs and extract the best approach.',
    '4. Apply, verify, and continue.',
  ].join('\n');
}

// Installs the global board skill.
async function install_skill(): Promise<void> {
  var dir = board_skill_dir();
  var file = board_skill_file();

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, board_skill_md(), 'utf8');

  console.log(`[board] Installed global skill at ${file}`);
  console.log('[board] Restart Codex to pick up new skills.');
}

// Uninstalls the global board skill.
async function uninstall_skill(): Promise<void> {
  var dir = board_skill_dir();
  await fs.rm(dir, { recursive: true, force: true });
  console.log(`[board] Removed global skill at ${dir}`);
}

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

// Runs the board command.
async function main(): Promise<void> {
  var cli = parse_cli(process.argv);
  switch (cli.mode) {
    case 'install_skill': {
      await install_skill();
      return;
    }
    case 'uninstall_skill': {
      await uninstall_skill();
      return;
    }
    default: {
      break;
    }
  }

  var opts = cli.opts;
  if (!opts) {
    fail('Internal error: missing run options.');
  }
  var cwd = process.cwd();

  var ctx = await build_context(opts, cwd);
  var ctx = ctx.trim() || '(no extra context provided)';

  var prompt = [
    'REQUEST:',
    opts.req,
    '',
    'CONTEXT:',
    ctx,
    '',
    'Answer the request, providing insights, guidance and help.',
  ].join('\n');

  var tasks = opts.models.map(model => () => ask_one(model, prompt));
  var tags = opts.models.map(model_tag);
  var reps = await run_parallel_tagged(tasks, tags);

  var blocks = reps.map((rep, i) => {
    var status = rep.ok ? 'ok' : 'failed';
    return [
      `=== ADVISOR ${i + 1}: ${rep.model} (${status}) ===`,
      rep.text.trim(),
      `=== END ADVISOR ${i + 1} ===`,
    ].join('\n');
  });

  process.stdout.write(blocks.join('\n\n') + '\n');

  var ok_count = reps.filter(x => x.ok).length;
  if (ok_count === 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`[board] Fatal: ${error_message(error)}`);
  process.exit(1);
});
