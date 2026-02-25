#!/usr/bin/env bun

// Long.ts
// =======
// Long-running task orchestrator for multi-model planning + Codex execution.
//
// Documentation
// -------------
//
// What this file is:
// - A production CLI entrypoint named `long`.
// - A persistent optimization loop for hard tasks that may require many rounds.
// - A coordinator that combines:
//   - repository snapshot loading
//   - context retrieval
//   - board-of-advisors planning
//   - one-shot Codex execution
//   - append-only memory accumulation
//
// Core objective:
// - Given `long GOAL.txt`, repeatedly push the repository toward task completion.
// - Keep context sizes under control with token-range targets.
// - Keep per-round memory bounded to small fixed reports.
//
// High-level round pipeline:
// 1) Task + repo load
//    - Reads task from `<task_file>`.
//    - Builds full repo snapshot from git-visible files:
//      `git ls-files --cached --others --exclude-standard`.
//    - Excludes `.long/`, `.REPORT.txt`, and `GOAL.txt` from the snapshot.
//
// 2) Retrieval (optional bypass when repo is already small)
//    - If full repo context is <= 64k tokens, retrieval is skipped.
//    - Otherwise sends a line-numbered codebase dump to the retrieval model.
//    - The model responds with <range file="..." from="..." to="..."/> elements.
//    - Ranges are padded ±1, clamped, merged, and assembled with "..." gaps.
//    - Enforces range 32k-64k (ideal 48k) with iterative grow/shrink rounds.
//    - This is much faster than having the AI rewrite code verbatim.
//
// 3) Insight board
//    - Sends task + retrieved context + `.long/MEMORY.md` to advisor models.
//    - Advisors return guidance only (no patches).
//    - Merges advisor outputs into one document.
//    - If merged advice > 16k tokens, summarizes to 12k-20k (ideal 16k).
//    - Uses the same generic rebalancer logic used by retrieval.
//
// 4) Coding run (Codex CLI one-shot)
//    - Invokes `codex exec` non-interactively with stdin prompt (`-`).
//    - Sends:
//      - insights (or memory-only mode when board is disabled)
//      - user task
//      - explicit goals, including `.REPORT.txt` requirements
//      - instruction to commit and push when done
//    - Captures final assistant message via `--output-last-message`.
//
// 5) Report ingestion + memory update
//    - Reads `.REPORT.txt` and deletes it.
//    - Falls back to Codex last message if `.REPORT.txt` is absent/empty.
//    - Compresses report if needed, enforcing max token limit (default 256).
//    - Flattens report into a single line and appends to `.long/MEMORY.md`.
//    - Memory is append-only by design.
//
// 6) Loop
//    - Repeats from the latest repository state.
//    - Stops only when `--max-rounds` is reached (or never, when 0).
//
// Observability:
// - Every AI prompt is logged to terminal with token count.
// - Full prompt text is written to ~/.ai/long/<timestamp>.<call_name>.txt.
//
// Important repository side effects:
// - Ensures `.long/` exists and `.long/MEMORY.md` exists.
// - Ensures `.long/` is listed in `.gitignore`.
// - Creates transient `.long/.codex-last-message.txt` for capture.
// - Removes `.REPORT.txt` after ingestion.
//
// Modes:
// - Board enabled (default):
//   retrieval + advisors + codex.
// - Board disabled (`--no-board`):
//   skips retrieval/advisors, injects MEMORY directly into codex goal prompt.
//
// Reliability model:
// - AI calls include retry logic.
// - Context/report windows use bounded rebalance rounds.
// - Hard token trim is used as a final guard for report token cap.
// - Startup verifies `codex exec` supports required non-interactive flags.
//
// Non-goals of this file:
// - It does not implement semantic diff review.
// - It does not guarantee codex will always commit/push successfully.
// - It does not auto-resolve git conflicts or remote auth/network failures.
//
// CLI examples:
// - `long GOAL.txt`
// - `long GOAL.txt --max-rounds 3`
// - `long GOAL.txt --no-board`
// - `long GOAL.txt --codex-model gpt-codex-5.3-high`
//
// Operational assumptions:
// - Must run inside a git repository.
// - API keys for advisor/retrieval models must be configured for GenAI.ts.
// - `codex` CLI must be installed and available in `PATH`.
// - Pushing requires git remote/auth to already be configured.

// Imports
// -------

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as process from 'process';
import { AsyncLocalStorage } from 'async_hooks';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { Command } from 'commander';
import { GenAI, tokenCount } from './GenAI';

const exec_file_async = promisify(execFile);

// Types
// -----

type ResizeMode = 'grow' | 'shrink';

type RebalanceState = {
  mode: ResizeMode;
  cur_text: string;
  cur_tokens: number;
  min_tokens: number;
  max_tokens: number;
  tgt_tokens: number;
};

type RebalanceConfig = {
  model: string;
  system: string;
  call_name: string;
  min_tokens: number;
  max_tokens: number;
  tgt_tokens: number;
  max_rounds: number;
  text: string;
  on_shrink: (state: RebalanceState) => string;
  on_grow?: (state: RebalanceState) => string;
};

type RebalanceResult = {
  text: string;
  tokens: number;
  rounds: number;
};

type LineRange = { file: string; from: number; to: number };
type RepoFiles = Map<string, string[]>;

type RoundOptions = {
  max_rounds: number;
  board: boolean;
  retrieval_model: string;
  summary_model: string;
  advisor_models: string[];
  codex_model: string;
  codex_sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  codex_dangerous: boolean;
  codex_ephemeral: boolean;
  codex_json: boolean;
  report_limit: number;
  delay_ms: number;
  task_file: string;
};

type AdvisorReply = {
  model: string;
  text: string;
  ok: boolean;
};

// Constants
// ---------

const RETRIEVE_MIN_TOKENS = 32_000;
const RETRIEVE_MAX_TOKENS = 64_000;
const RETRIEVE_TGT_TOKENS = 48_000;

const INSIGHT_TRIGGER_TOKENS = 16_000;
const INSIGHT_MIN_TOKENS     = 12_000;
const INSIGHT_MAX_TOKENS     = 20_000;
const INSIGHT_TGT_TOKENS     = 16_000;

const REPORT_TGT_TOKENS = 192;
const MAX_REBALANCE_ROUNDS = 6;
const AI_RETRIES = 2;
const EXEC_MAX_BUFFER = 128 * 1024 * 1024;
const AI_LOG_DIR      = path.join(os.homedir(), '.ai', 'long');

const LONG_DIR        = '.long';
const MEMORY_PATH     = '.long/MEMORY.md';
const REPORT_PATH     = '.REPORT.txt';
const GOAL_FILE       = 'GOAL.txt';
const CODEX_LAST_PATH = '.long/.codex-last-message.txt';

const DEFAULT_RETRIEVAL_MODEL = 'anthropic:claude-opus-4-6:max';
const DEFAULT_SUMMARY_MODEL   = 'anthropic:claude-opus-4-6:max';
const DEFAULT_ADVISOR_MODELS  = [
  'google:gemini-3.1-pro-preview:max',
  'anthropic:claude-opus-4-6:max',
  'openai:gpt-5.2:max',
  'openai:gpt-5.3-codex:max',
];
const DEFAULT_CODEX_MODEL             = 'gpt-5.3-codex';
const DEFAULT_CODEX_REASONING_EFFORT = 'xhigh';

const RETRIEVAL_SYSTEM = [
  'You extract relevant source code from repositories.',
  'Output only code files in the specified format.',
  'Never include task descriptions, solutions, plans, or commentary in your output.',
].join(' ');

const ADVISOR_SYSTEM = [
  'You are an expert software advisor.',
  'Provide guidance only; do not output patches or file contents.',
].join(' ');

const SUMMARY_SYSTEM = [
  'You are a compression and synthesis assistant.',
  'Preserve concrete details while meeting the requested token window.',
].join(' ');

// Logging
// -------

// Prints a prefixed status message
function log_step(message: string): void {
  console.log(`[long] ${message}`);
}

// Errors
// ------

// Converts unknown errors to readable strings
function error_message(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Throws a formatted fatal error
function fail(message: string): never {
  throw new Error(message);
}

// Time
// ----

// Sleeps for a short period
async function sleep_ms(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>(resolve => setTimeout(resolve, ms));
}

// AI Call Logging
// ---------------

// Generates a timestamp string like 2026y02m25d.14h30m05s
function log_timestamp(): string {
  var d   = new Date();
  var Y   = String(d.getFullYear());
  var M   = String(d.getMonth() + 1).padStart(2, '0');
  var D   = String(d.getDate()).padStart(2, '0');
  var h   = String(d.getHours()).padStart(2, '0');
  var min = String(d.getMinutes()).padStart(2, '0');
  var s   = String(d.getSeconds()).padStart(2, '0');
  return `${Y}y${M}m${D}d.${h}h${min}m${s}s`;
}

// Logs an AI call's prompt to terminal and file (fire-and-forget)
function log_ai_call(
  call_name: string,
  prompt: string,
  tokens: number,
): void {
  log_step(`AI call "${call_name}": ${tokens} prompt tokens`);
  var ts   = log_timestamp();
  var file = path.join(AI_LOG_DIR, `${ts}.${call_name}.txt`);
  fs.mkdir(AI_LOG_DIR, { recursive: true })
    .then(() => fs.writeFile(file, prompt, 'utf8'))
    .catch(() => {});
}

// Tokens
// ------

// Computes a best-effort reduction/enrichment factor to the target
function target_factor(cur_tokens: number, tgt_tokens: number): number {
  if (cur_tokens <= 0 || tgt_tokens <= 0) {
    return 1;
  }
  if (cur_tokens > tgt_tokens) {
    return cur_tokens / tgt_tokens;
  }
  return tgt_tokens / cur_tokens;
}

// Builds a short token directive sentence
function token_directive(cur_tokens: number, tgt_tokens: number): string {
  var delta = Math.abs(cur_tokens - tgt_tokens);
  var factor = target_factor(cur_tokens, tgt_tokens).toFixed(2);
  if (cur_tokens > tgt_tokens) {
    return `Reduce by ${delta} tokens to reach ${tgt_tokens} (about ${factor}x reduction).`;
  }
  if (cur_tokens < tgt_tokens) {
    return `Increase by ${delta} tokens to reach ${tgt_tokens} (about ${factor}x enrichment).`;
  }
  return `Already at target (${tgt_tokens} tokens).`;
}

// Removes a single outer markdown code-fence when present
function strip_outer_fence(text: string): string {
  var text = text.trim();
  if (!text.startsWith('```')) {
    return text;
  }

  var lines = text.split('\n');
  if (lines.length < 2) {
    return text;
  }
  if (lines[lines.length - 1].trim() !== '```') {
    return text;
  }
  return lines.slice(1, -1).join('\n').trim();
}

// Hard-trims by words to ensure token cap compliance
function hard_trim_tokens(text: string, max_tokens: number): string {
  var words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return '';
  }

  var lo = 0;
  var hi = words.length;
  while (lo < hi) {
    var mid = Math.ceil((lo + hi) / 2);
    var cand = words.slice(0, mid).join(' ');
    if (tokenCount(cand) <= max_tokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return words.slice(0, lo).join(' ').trim();
}

// Paths
// -----

// Tests whether a path exists
async function path_exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

// Reads UTF-8 text or returns empty string on ENOENT
async function read_text_or_empty(p: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

// Deletes a file if it exists
async function delete_if_exists(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

// Git
// ---

// Runs git and returns stdout
async function run_git(args: string[], cwd: string): Promise<string> {
  var { stdout } = await exec_file_async('git', args, {
    cwd,
    maxBuffer: EXEC_MAX_BUFFER,
  });
  return stdout.trimEnd();
}

// Discovers repository root from the current working directory
async function get_repo_root(cwd: string): Promise<string> {
  try {
    var root = await run_git(['rev-parse', '--show-toplevel'], cwd);
    if (!root.trim()) {
      fail('Unable to resolve git root.');
    }
    return root.trim();
  } catch (error) {
    fail(`Not inside a git repository: ${error_message(error)}`);
  }
}

// Ensures .long/ is ignored
async function ensure_long_gitignored(root: string): Promise<void> {
  var gitignore_path = path.join(root, '.gitignore');
  var old_text = await read_text_or_empty(gitignore_path);
  var lines = old_text.split(/\r?\n/);
  var has_long = lines.some(line => {
    var line = line.trim();
    return line === '.long/' || line === '.long';
  });

  if (has_long) {
    return;
  }

  var next_text = old_text;
  if (next_text.length > 0 && !next_text.endsWith('\n')) {
    next_text += '\n';
  }
  next_text += '.long/\n';
  await fs.writeFile(gitignore_path, next_text, 'utf8');
  log_step('Added ".long/" to .gitignore.');
}

// Repo Snapshot
// -------------

// Detects likely binary files
function is_likely_binary(buf: Buffer): boolean {
  var sample = buf.subarray(0, Math.min(buf.length, 8192));
  for (var i = 0; i < sample.length; ++i) {
    if (sample[i] === 0) {
      return true;
    }
  }
  return false;
}

// Serializes one file into snapshot format
function serialize_file(file: string, content: string): string {
  return [
    `=== FILE: ./${file} ===`,
    content,
    '=== END FILE ===',
  ].join('\n');
}

// Lists all non-ignored repository files
async function list_repo_files(root: string): Promise<string[]> {
  var out = await run_git(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    root,
  );
  var files = out.split('\0').filter(Boolean);
  var files = files.filter(file => !file.startsWith(`${LONG_DIR}/`));
  var files = files.filter(file => file !== REPORT_PATH);
  var files = files.filter(file => file !== GOAL_FILE);
  return files;
}

// Loads all repository files as line arrays
async function load_repo_files(root: string): Promise<RepoFiles> {
  var names = await list_repo_files(root);
  var files: RepoFiles = new Map();
  for (var name of names) {
    var abs = path.join(root, name);
    var buf = await fs.readFile(abs);
    if (is_likely_binary(buf)) {
      files.set(name, [`<binary file omitted: ${buf.length} bytes>`]);
    } else {
      files.set(name, buf.toString('utf8').split('\n'));
    }
  }
  return files;
}

// Renders a full snapshot from loaded files
function snapshot_from_files(files: RepoFiles): string {
  var chunks: string[] = [];
  for (var [name, lines] of files) {
    chunks.push(serialize_file(name, lines.join('\n')));
  }
  return chunks.join('\n\n');
}

// Renders files with line numbers for retrieval AI
function numbered_from_files(files: RepoFiles): string {
  var chunks: string[] = [];
  for (var [name, lines] of files) {
    var w = String(lines.length - 1).length;
    var numbered = lines.map((ln, i) => {
      return `${String(i).padStart(w, '0')}|${ln}`;
    });
    chunks.push(
      `=== FILE: ./${name} ===\n${numbered.join('\n')}\n=== END FILE ===`,
    );
  }
  return chunks.join('\n\n');
}

// Memory
// ------

// Creates .long directory and MEMORY.md if missing
async function ensure_memory_store(root: string): Promise<void> {
  var long_dir = path.join(root, LONG_DIR);
  var memory_path = path.join(root, MEMORY_PATH);
  await fs.mkdir(long_dir, { recursive: true });
  if (!(await path_exists(memory_path))) {
    await fs.writeFile(memory_path, '', 'utf8');
  }
}

// Reads current memory text
async function read_memory(root: string): Promise<string> {
  var memory_path = path.join(root, MEMORY_PATH);
  return await read_text_or_empty(memory_path);
}

// Appends one memory line, preserving append-only semantics
async function append_memory_line(root: string, line: string): Promise<void> {
  var line = line.trim();
  if (!line) {
    return;
  }

  var memory_path = path.join(root, MEMORY_PATH);
  var old_text = await read_text_or_empty(memory_path);
  var old_text = old_text.replace(/\s+$/g, '');
  var next_text = old_text.length > 0
    ? `${old_text}\n${line}\n`
    : `${line}\n`;
  await fs.writeFile(memory_path, next_text, 'utf8');
}

// AI Calls
// --------

// Storage for tracking which parallel task owns a given write
var parallel_ctx = new AsyncLocalStorage<number>();

const TAG_LINE_WIDTH = 120;

// Derives a 4-char tag from a model spec like "vendor:model:thinking"
function model_tag(model: string): string {
  var name = model.split(':')[1] || model;
  if (name.includes('codex'))  return 'codx';
  if (name.includes('gemini')) return 'gemi';
  if (name.includes('opus'))   return 'opus';
  if (name.includes('sonnet')) return 'sonn';
  if (name.includes('haiku'))  return 'haik';
  if (name.includes('grok'))   return 'grok';
  if (name.includes('gpt'))    return ' gpt';
  return name.replace(/[^a-z0-9]/gi, '').slice(0, 4).padStart(4);
}

// Runs tasks in parallel with real-time tagged output.
// Each task's stdout/stderr is intercepted, accumulated per-task,
// and flushed as "[tag] ..." lines at newlines or ~120 chars.
async function run_parallel_tagged<T>(
  tasks: (() => Promise<T>)[],
  tags: string[],
): Promise<T[]> {
  var line_bufs: string[] = tasks.map(() => '');

  var orig_out = process.stdout.write.bind(process.stdout);
  var orig_err = process.stderr.write.bind(process.stderr);

  // Emits one tagged line
  function emit(tag: string, line: string): void {
    orig_err(Buffer.from(`[${tag}] ${line}\n`));
  }

  // Drains complete lines and width overflows from a task's buffer
  function drain(idx: number): void {
    var tag = tags[idx];
    while (true) {
      var nl = line_bufs[idx].indexOf('\n');
      if (nl !== -1 && nl <= TAG_LINE_WIDTH) {
        emit(tag, line_bufs[idx].slice(0, nl));
        line_bufs[idx] = line_bufs[idx].slice(nl + 1);
      } else if (line_bufs[idx].length >= TAG_LINE_WIDTH) {
        emit(tag, line_bufs[idx].slice(0, TAG_LINE_WIDTH));
        line_bufs[idx] = line_bufs[idx].slice(TAG_LINE_WIDTH);
      } else {
        break;
      }
    }
  }

  // Intercepts writes: if inside a tracked task, accumulate and drain
  function intercept(orig: typeof process.stdout.write): typeof process.stdout.write {
    return function (chunk: any, ...args: any[]): boolean {
      var idx = parallel_ctx.getStore();
      if (idx !== undefined) {
        line_bufs[idx] += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        drain(idx);
        return true;
      }
      return (orig as any)(chunk, ...args);
    } as any;
  }

  process.stdout.write = intercept(orig_out);
  process.stderr.write = intercept(orig_err);
  try {
    var results = await Promise.all(
      tasks.map((fn, i) => parallel_ctx.run(i, fn)),
    );
  } finally {
    process.stdout.write = orig_out;
    process.stderr.write = orig_err;
  }

  // Flush any remaining partial lines
  for (var i = 0; i < line_bufs.length; i++) {
    var rest = line_bufs[i].trim();
    if (rest) {
      emit(tags[i], rest);
    }
  }

  return results;
}

// Calls one model and returns plain text with retries
async function ask_text(
  model: string,
  prompt: string,
  system: string,
  call_name: string,
  retries: number = AI_RETRIES,
): Promise<string> {
  var prompt_tokens = tokenCount(prompt);
  log_ai_call(call_name, prompt, prompt_tokens);
  var last_error: unknown = null;

  for (var attempt = 0; attempt <= retries; ++attempt) {
    try {
      var ai = await GenAI(model);
      var reply_raw = await ai.ask(prompt, { system });
      if (typeof reply_raw !== 'string') {
        fail(`Model "${model}" returned non-text response.`);
      }

      var reply = strip_outer_fence(reply_raw).trim();
      if (!reply) {
        fail(`Model "${model}" returned empty response.`);
      }
      return reply;
    } catch (error) {
      last_error = error;
      if (attempt >= retries) {
        break;
      }
      await sleep_ms(1_000 * (attempt + 1));
    }
  }

  fail(`Model call failed (${model}): ${error_message(last_error)}`);
}

// Rebalances text into a token range using a model loop
async function rebalance_text(cfg: RebalanceConfig): Promise<RebalanceResult> {
  var text = cfg.text.trim();
  var tokens = tokenCount(text);
  var rounds = 0;

  while (rounds < cfg.max_rounds) {
    if (tokens >= cfg.min_tokens && tokens <= cfg.max_tokens) {
      break;
    }

    var mode: ResizeMode = tokens > cfg.max_tokens ? 'shrink' : 'grow';
    if (mode === 'grow' && !cfg.on_grow) {
      break;
    }

    var state: RebalanceState = {
      mode,
      cur_text: text,
      cur_tokens: tokens,
      min_tokens: cfg.min_tokens,
      max_tokens: cfg.max_tokens,
      tgt_tokens: cfg.tgt_tokens,
    };

    var prompt = mode === 'shrink'
      ? cfg.on_shrink(state)
      : cfg.on_grow!(state);

    var adj_name = `${cfg.call_name}_${mode}`;
    var next = await ask_text(cfg.model, prompt, cfg.system, adj_name);
    var next = next.trim();
    if (!next || next === text) {
      break;
    }

    text = next;
    tokens = tokenCount(text);
    rounds += 1;
  }

  return { text, tokens, rounds };
}

// Retrieval
// ---------

// Parses <range file="..." from="..." to="..."/> elements from AI response
function parse_ranges(response: string): LineRange[] {
  var ranges: LineRange[] = [];
  var re = /<range\s+file="([^"]+)"\s+from="(\d+)"\s+to="(\d+)"\s*\/>/g;
  var m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    ranges.push({ file: m[1], from: Number(m[2]), to: Number(m[3]) });
  }
  return ranges;
}

// Formats ranges as XML for prompt inclusion
function format_ranges_xml(ranges: LineRange[]): string {
  return ranges
    .map(r => `<range file="${r.file}" from="${r.from}" to="${r.to}"/>`)
    .join('\n');
}

// Pads ±1, clamps to file bounds, merges overlapping ranges per file
function pad_and_merge(
  ranges: LineRange[],
  files: RepoFiles,
): Map<string, [number, number][]> {
  var by_file = new Map<string, [number, number][]>();
  for (var r of ranges) {
    var name = r.file.replace(/^\.\//, '');
    var lines = files.get(name);
    if (!lines) {
      continue;
    }
    var max_ln = lines.length - 1;
    var from   = Math.max(0, r.from - 1);
    var to     = Math.min(max_ln, r.to + 1);
    if (!by_file.has(name)) {
      by_file.set(name, []);
    }
    by_file.get(name)!.push([from, to]);
  }
  for (var [name, segs] of by_file) {
    segs.sort((a, b) => a[0] - b[0]);
    var merged: [number, number][] = [segs[0]];
    for (var i = 1; i < segs.length; i++) {
      var last = merged[merged.length - 1];
      if (segs[i][0] <= last[1] + 1) {
        last[1] = Math.max(last[1], segs[i][1]);
      } else {
        merged.push(segs[i]);
      }
    }
    by_file.set(name, merged);
  }
  return by_file;
}

// Assembles context text from merged ranges, using "..." for gaps
function assemble_ranges(
  merged: Map<string, [number, number][]>,
  files: RepoFiles,
): string {
  var chunks: string[] = [];
  for (var [name, segs] of merged) {
    var lines = files.get(name);
    if (!lines) {
      continue;
    }
    var parts: string[] = [];
    var last_end = -1;
    for (var [from, to] of segs) {
      if (from > last_end + 1) {
        parts.push('...');
      }
      parts.push(lines.slice(from, to + 1).join('\n'));
      last_end = to;
    }
    if (last_end < lines.length - 1) {
      parts.push('...');
    }
    chunks.push(serialize_file(name, parts.join('\n')));
  }
  return chunks.join('\n\n');
}

// Builds the initial retrieval prompt
function retrieval_prompt_initial(
  task: string,
  numbered: string,
  repo_tokens: number,
): string {
  return [
    'TASK (read-only reference — do NOT include this in your output):',
    task,
    '',
    'TOKEN BUDGET:',
    `Full codebase: ${repo_tokens} tokens.`,
    `Target output: ${RETRIEVE_MIN_TOKENS}–${RETRIEVE_MAX_TOKENS} tokens (ideal ${RETRIEVE_TGT_TOKENS}).`,
    token_directive(repo_tokens, RETRIEVE_TGT_TOKENS),
    '',
    'INSTRUCTIONS:',
    'Select line ranges from the codebase that are relevant to solving the TASK.',
    'Prioritize by relevance: directly related code first, then helpful context.',
    'Include enough surrounding context to fully understand each selected region.',
    '',
    'RESPONSE FORMAT (strictly — nothing else):',
    '<range file="./relative/path" from="LINE" to="LINE"/>',
    '',
    'Each range selects lines FROM to TO (inclusive, 0-indexed).',
    'You may output multiple ranges per file.',
    'Do NOT output code, commentary, or explanations — only <range/> elements.',
    '',
    'CODEBASE (with line numbers):',
    numbered,
  ].join('\n');
}

// Builds retrieval prompt for undersized selection
function retrieval_prompt_grow(
  task: string,
  numbered: string,
  cur_ranges: LineRange[],
  cur_tokens: number,
): string {
  var need = RETRIEVE_TGT_TOKENS - cur_tokens;
  return [
    'Your previous selection is too small.',
    'Include more line ranges. Prioritize by relevance to the task.',
    '',
    `Current selection: ${cur_tokens} tokens.`,
    `Target: ${RETRIEVE_MIN_TOKENS}–${RETRIEVE_MAX_TOKENS} tokens (ideal ${RETRIEVE_TGT_TOKENS}).`,
    `Add roughly ${need} tokens worth of lines.`,
    token_directive(cur_tokens, RETRIEVE_TGT_TOKENS),
    '',
    'TASK (reference only):',
    task,
    '',
    'YOUR PREVIOUS SELECTION:',
    format_ranges_xml(cur_ranges),
    '',
    'Return a complete new set of <range/> elements (previous + new).',
    '',
    'CODEBASE (with line numbers):',
    numbered,
  ].join('\n');
}

// Builds retrieval prompt for oversized selection
function retrieval_prompt_shrink(
  task: string,
  context: string,
  cur_ranges: LineRange[],
  cur_tokens: number,
): string {
  var drop = cur_tokens - RETRIEVE_TGT_TOKENS;
  return [
    'Your previous selection is too large.',
    'Remove or narrow ranges, dropping the least relevant content.',
    '',
    `Current selection: ${cur_tokens} tokens.`,
    `Target: ${RETRIEVE_MIN_TOKENS}–${RETRIEVE_MAX_TOKENS} tokens (ideal ${RETRIEVE_TGT_TOKENS}).`,
    `Remove roughly ${drop} tokens worth of lines.`,
    token_directive(cur_tokens, RETRIEVE_TGT_TOKENS),
    '',
    'TASK (reference only):',
    task,
    '',
    'YOUR PREVIOUS SELECTION:',
    format_ranges_xml(cur_ranges),
    '',
    'SELECTED CONTENT:',
    context,
    '',
    'Return a complete reduced set of <range/> elements.',
  ].join('\n');
}

// Runs range-based retrieval with adjustment loop
async function retrieve_context(
  task: string,
  repo_files: RepoFiles,
  repo_snap: string,
  repo_tokens: number,
  retrieval_model: string,
): Promise<{ text: string; tokens: number }> {
  if (repo_tokens <= RETRIEVE_MAX_TOKENS) {
    log_step(`Retrieval skipped (full repo is ${repo_tokens} tokens, <= ${RETRIEVE_MAX_TOKENS}).`);
    return { text: repo_snap, tokens: repo_tokens };
  }

  log_step(`Running retrieval model (${retrieval_model}) on ${repo_tokens} tokens.`);
  var numbered = numbered_from_files(repo_files);

  // Initial retrieval
  var prompt = retrieval_prompt_initial(task, numbered, repo_tokens);
  var response = await ask_text(retrieval_model, prompt, RETRIEVAL_SYSTEM, 'retrieve');
  var ranges = parse_ranges(response);

  if (ranges.length === 0) {
    log_step('Retrieval returned no ranges; using full snapshot.');
    return { text: repo_snap, tokens: repo_tokens };
  }

  var merged  = pad_and_merge(ranges, repo_files);
  var context = assemble_ranges(merged, repo_files);
  var tokens  = tokenCount(context);
  log_step(`Initial retrieval: ${tokens} tokens from ${ranges.length} ranges.`);

  // Adjustment loop
  var round = 0;
  while (round < MAX_REBALANCE_ROUNDS) {
    if (tokens >= RETRIEVE_MIN_TOKENS && tokens <= RETRIEVE_MAX_TOKENS) {
      break;
    }
    if (tokens < RETRIEVE_MIN_TOKENS) {
      var adj = retrieval_prompt_grow(task, numbered, ranges, tokens);
      var adj_resp = await ask_text(retrieval_model, adj, RETRIEVAL_SYSTEM, 'retrieve_adj_grow');
    } else {
      var adj = retrieval_prompt_shrink(task, context, ranges, tokens);
      var adj_resp = await ask_text(retrieval_model, adj, RETRIEVAL_SYSTEM, 'retrieve_adj_shrink');
    }
    var new_ranges = parse_ranges(adj_resp);
    if (new_ranges.length === 0) {
      break;
    }
    ranges  = new_ranges;
    merged  = pad_and_merge(ranges, repo_files);
    context = assemble_ranges(merged, repo_files);
    tokens  = tokenCount(context);
    round  += 1;
    log_step(`Retrieval adjustment ${round}: ${tokens} tokens from ${ranges.length} ranges.`);
  }

  log_step(`Retrieved context size: ${tokens} tokens.`);
  return { text: context, tokens };
}

// Advisors
// --------

// Builds one advisor prompt
function advisor_prompt(
  task: string,
  context_text: string,
  memory_text: string,
): string {
  var memory_text = memory_text.trim() || '(empty)';
  return [
    'CONTEXT:',
    context_text,
    '',
    'MEMORY (coding agent self-reports from prior rounds — may contain errors):',
    memory_text,
    '',
    'TASK:',
    task,
    '',
    'You are one of several expert advisors guiding a coding agent that will edit this repository.',
    '',
    'Your role:',
    '- Provide detailed, actionable implementation guidance. No code patches or file contents.',
    '- Name specific files, functions, and line ranges to modify.',
    '- Identify likely pitfalls, misunderstandings, and edge cases.',
    '- If MEMORY entries seem misguided, say so explicitly and correct them.',
    '- Lay out a clear step-by-step action plan the coding agent can follow.',
    '- Maximize actionable insight density.',
  ].join('\n');
}

// Calls one advisor model safely
async function ask_advisor(
  model: string,
  task: string,
  context_text: string,
  memory_text: string,
  call_name: string,
): Promise<AdvisorReply> {
  try {
    var prompt = advisor_prompt(task, context_text, memory_text);
    var text = await ask_text(model, prompt, ADVISOR_SYSTEM, call_name);
    return { model, text, ok: true };
  } catch (error) {
    var text = `Advisor failed: ${error_message(error)}`;
    return { model, text, ok: false };
  }
}

// Builds synthesis prompt for combined advisor output
function insight_summarize_prompt(
  task: string,
  combined_text: string,
  combined_tokens: number,
): string {
  return [
    'Summarize and merge this board-of-advisors document for a coding agent.',
    'Keep concrete implementation guidance, file references, risk notes, and open questions.',
    'Do not add new facts.',
    '',
    `Current combined advice tokens: ${combined_tokens}.`,
    `Target range: ${INSIGHT_MIN_TOKENS}-${INSIGHT_MAX_TOKENS}.`,
    `Ideal target: ${INSIGHT_TGT_TOKENS}.`,
    token_directive(combined_tokens, INSIGHT_TGT_TOKENS),
    '',
    'Output only the synthesized advice.',
    '',
    'TASK:',
    task,
    '',
    'COMBINED ADVICE:',
    combined_text,
  ].join('\n');
}

// Builds grow/shrink prompts for insight balancing
function insight_resize_prompt(
  task: string,
  source_text: string,
  state: RebalanceState,
): string {
  var mode_phrase = state.mode === 'shrink'
    ? 'The advice is too long; reduce while preserving key details.'
    : 'The advice is too short; enrich from source while staying focused.';
  return [
    mode_phrase,
    '',
    `Current advice tokens: ${state.cur_tokens}.`,
    `Target range: ${state.min_tokens}-${state.max_tokens}.`,
    `Ideal target: ${state.tgt_tokens}.`,
    token_directive(state.cur_tokens, state.tgt_tokens),
    '',
    'Output only the revised advice.',
    '',
    'TASK:',
    task,
    '',
    'CURRENT ADVICE:',
    state.cur_text,
    '',
    'SOURCE ADVICE:',
    source_text,
  ].join('\n');
}

// Runs board of advisors and optional synthesis
async function run_board_of_advisors(
  task: string,
  context_text: string,
  memory_text: string,
  advisor_models: string[],
  summary_model: string,
): Promise<string> {
  log_step(`Running advisor board with ${advisor_models.length} models.`);
  var tasks = advisor_models.map((model, i) =>
    () => ask_advisor(model, task, context_text, memory_text, `advisor_${i}`),
  );
  var tags    = advisor_models.map(m => model_tag(m));
  var replies = await run_parallel_tagged(tasks, tags);

  var ok_count = replies.filter(reply => reply.ok).length;
  if (ok_count === 0) {
    fail('All advisor models failed.');
  }

  var combined = replies.map((reply, i) => {
    var status = reply.ok ? 'ok' : 'failed';
    return [
      `## Advisor ${i + 1}: ${reply.model} (${status})`,
      reply.text.trim(),
    ].join('\n');
  }).join('\n\n');

  var combined_tokens = tokenCount(combined);
  log_step(`Combined advisor doc size: ${combined_tokens} tokens.`);
  if (combined_tokens <= INSIGHT_TRIGGER_TOKENS) {
    return combined;
  }

  log_step(`Summarizing advisor doc with ${summary_model}.`);
  var first_prompt = insight_summarize_prompt(task, combined, combined_tokens);
  var first_summary = await ask_text(summary_model, first_prompt, SUMMARY_SYSTEM, 'insight_synth');

  var balanced = await rebalance_text({
    model: summary_model,
    system: SUMMARY_SYSTEM,
    call_name: 'insight_adj',
    min_tokens: INSIGHT_MIN_TOKENS,
    max_tokens: INSIGHT_MAX_TOKENS,
    tgt_tokens: INSIGHT_TGT_TOKENS,
    max_rounds: MAX_REBALANCE_ROUNDS,
    text: first_summary,
    on_shrink: state => insight_resize_prompt(task, combined, { ...state, mode: 'shrink' }),
    on_grow: state => insight_resize_prompt(task, combined, { ...state, mode: 'grow' }),
  });

  log_step(`Final advisor synthesis size: ${balanced.tokens} tokens.`);
  return balanced.text;
}

// Codex
// -----

// Ensures local codex CLI supports required non-interactive flags
async function ensure_codex_exec_support(): Promise<void> {
  var help = '';
  try {
    var { stdout } = await exec_file_async('codex', ['exec', '--help'], {
      maxBuffer: EXEC_MAX_BUFFER,
    });
    help = stdout;
  } catch (error) {
    fail(`Unable to run "codex exec --help": ${error_message(error)}`);
  }

  var need_output = help.includes('--output-last-message');
  var need_config = help.includes('--config');
  var need_stdin = help.includes('read from stdin');
  if (!need_output || !need_config || !need_stdin) {
    fail('Installed codex CLI does not expose required non-interactive features.');
  }
}

// Builds the coding prompt sent to codex exec
function codex_goal_prompt(
  task: string,
  insights: string,
  memory_text: string,
  board_enabled: boolean,
): string {
  var blocks = [] as string[];

  if (board_enabled) {
    blocks.push('INSIGHTS (from board of experts):');
    blocks.push(insights.trim() || '(none)');
  } else {
    blocks.push('MEMORY (self-reports from prior rounds; may contain mistakes):');
    blocks.push(memory_text.trim() || '(empty)');
  }

  blocks.push('TASK (user goal):');
  blocks.push(task);

  blocks.push([
    'INSTRUCTIONS:',
    '1. The insights above were produced by a board of expert advisors to guide your work.',
    '2. Your goal: complete the TASK in the current repository. Use the insights.',
    '3. When finished, write a file named ".REPORT.txt" containing a concise report.',
    '   The report must be at most 256 tokens (~3 short paragraphs). It must cover:',
    '   - What you changed and why.',
    '   - Key findings or results.',
    '   - What you plan to do next.',
    '   - Any questions for the expert board in the next round.',
    '   Use a tokenizer to verify the report stays under 256 tokens.',
    '4. After writing ".REPORT.txt", commit all changes and push to the remote.',
  ].join('\n'));

  return blocks.join('\n\n');
}

// Runs codex exec in one-shot mode, streaming output to terminal
async function run_codex_exec(
  root: string,
  prompt: string,
  opts: RoundOptions,
): Promise<string> {
  var out_path = path.join(root, CODEX_LAST_PATH);
  await fs.mkdir(path.dirname(out_path), { recursive: true });
  await delete_if_exists(out_path);

  var effort_cfg = `model_reasoning_effort="${DEFAULT_CODEX_REASONING_EFFORT}"`;
  var args = [
    'exec',
    '-C', root,
    '-m', opts.codex_model,
    '-c', effort_cfg,
    '-o', out_path,
  ];

  if (opts.codex_json) {
    args.push('--json');
  }
  if (opts.codex_ephemeral) {
    args.push('--ephemeral');
  }

  if (opts.codex_dangerous) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', opts.codex_sandbox);
  }

  args.push('-');
  log_step([
    `Running codex exec with model "${opts.codex_model}".`,
    `Reasoning effort: ${DEFAULT_CODEX_REASONING_EFFORT}.`,
  ].join(' '));

  await new Promise<void>((resolve, reject) => {
    var child = spawn('codex', args, {
      cwd: root,
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else if (signal) {
        reject(new Error(`codex terminated by signal ${signal}`));
      } else {
        reject(new Error(`codex exited with code ${code}`));
      }
    });

    child.stdin.end(prompt);
  });

  return await read_text_or_empty(out_path);
}

// Reports
// -------

// Builds initial report compression prompt
function report_compress_prompt(
  report_text: string,
  report_tokens: number,
  report_limit: number,
): string {
  return [
    'Compress this coding report while preserving factual content.',
    'The output must be concise and suitable for append-only memory.',
    '',
    `Current report tokens: ${report_tokens}.`,
    `Hard token limit: ${report_limit}.`,
    `Ideal target: ${REPORT_TGT_TOKENS}.`,
    token_directive(report_tokens, REPORT_TGT_TOKENS),
    '',
    'Output only the compressed report text.',
    '',
    'REPORT:',
    report_text,
  ].join('\n');
}

// Builds rebalance prompt for report post-processing
function report_resize_prompt(state: RebalanceState, source_text: string): string {
  var mode = state.mode === 'shrink'
    ? 'The report is still too long; reduce it.'
    : 'The report is too short; enrich from source if needed.';
  return [
    mode,
    '',
    `Current report tokens: ${state.cur_tokens}.`,
    `Allowed range: ${state.min_tokens}-${state.max_tokens}.`,
    `Ideal target: ${state.tgt_tokens}.`,
    token_directive(state.cur_tokens, state.tgt_tokens),
    '',
    'Output only the revised report.',
    '',
    'CURRENT REPORT:',
    state.cur_text,
    '',
    'SOURCE REPORT:',
    source_text,
  ].join('\n');
}

// Normalizes, caps, and returns one-line report
async function normalize_report(
  raw_report: string,
  summary_model: string,
  report_limit: number,
): Promise<string> {
  var report = raw_report.trim();
  if (!report) {
    report = 'No report was generated by the coding agent this round.';
  }

  var report_tokens = tokenCount(report);
  if (report_tokens > report_limit) {
    var first_prompt = report_compress_prompt(report, report_tokens, report_limit);
    report = await ask_text(summary_model, first_prompt, SUMMARY_SYSTEM, 'report_comp');

    var balanced = await rebalance_text({
      model: summary_model,
      system: SUMMARY_SYSTEM,
      call_name: 'report_adj',
      min_tokens: 1,
      max_tokens: report_limit,
      tgt_tokens: REPORT_TGT_TOKENS,
      max_rounds: MAX_REBALANCE_ROUNDS,
      text: report,
      on_shrink: state => report_resize_prompt({ ...state, mode: 'shrink' }, raw_report),
      on_grow: state => report_resize_prompt({ ...state, mode: 'grow' }, raw_report),
    });
    report = balanced.text;
  }

  report = report.replace(/\s+/g, ' ').trim();
  if (tokenCount(report) > report_limit) {
    report = hard_trim_tokens(report, report_limit);
  }

  return report.trim();
}

// Reads .REPORT.txt, deletes it, and appends normalized content to MEMORY.md
async function ingest_round_report(
  root: string,
  codex_last_message: string,
  summary_model: string,
  report_limit: number,
): Promise<string> {
  var report_path = path.join(root, REPORT_PATH);
  var report = await read_text_or_empty(report_path);
  await delete_if_exists(report_path);

  if (!report.trim()) {
    report = codex_last_message.trim();
  }

  var report = await normalize_report(report, summary_model, report_limit);
  await append_memory_line(root, report);
  return report;
}

// Round Flow
// ----------

// Executes one full optimization round
async function run_round(round: number, root: string, opts: RoundOptions): Promise<void> {
  log_step(`========== ROUND ${round} ==========`);  

  var task_text = (await fs.readFile(opts.task_file, 'utf8')).trim();
  if (!task_text) {
    fail(`Task file is empty: ${opts.task_file}`);
  }

  await ensure_long_gitignored(root);
  await ensure_memory_store(root);
  var memory_text = await read_memory(root);

  var insights = '';
  if (opts.board) {
    log_step('Loading full repository snapshot.');
    var repo_files  = await load_repo_files(root);
    var repo_snap   = snapshot_from_files(repo_files);
    var repo_tokens = tokenCount(repo_snap);
    log_step(`Repository snapshot size: ${repo_tokens} tokens.`);

    var retrieved = await retrieve_context(task_text, repo_files, repo_snap, repo_tokens, opts.retrieval_model);
    insights = await run_board_of_advisors(
      task_text,
      retrieved.text,
      memory_text,
      opts.advisor_models,
      opts.summary_model,
    );
  } else {
    log_step('Board disabled; skipping retrieval and advisor stages.');
  }

  var goal_prompt = codex_goal_prompt(task_text, insights, memory_text, opts.board);
  var codex_last = await run_codex_exec(root, goal_prompt, opts);
  var report = await ingest_round_report(
    root,
    codex_last,
    opts.summary_model,
    opts.report_limit,
  );
  var report_tokens = tokenCount(report);
  log_step(`Appended report (${report_tokens} tokens) to ${MEMORY_PATH}.`);
}

// CLI
// ---

// Parses and validates CLI options
function parse_cli(argv: string[]): RoundOptions {
  var program = new Command();
  program
    .name('long')
    .description('Long-running orchestrator loop for complex repository tasks.')
    .argument('<task_file>', 'Goal file (plain text, conventionally GOAL.txt)')
    .option('-n, --max-rounds <num>', 'Max rounds, 0 = infinite loop', '0')
    .option('--no-board', 'Disable advisor board and inject MEMORY into Codex prompt')
    .option('--retrieval-model <spec>', 'Model for retrieval stage', DEFAULT_RETRIEVAL_MODEL)
    .option('--summary-model <spec>', 'Model for synthesis/compression', DEFAULT_SUMMARY_MODEL)
    .option(
      '--advisor-models <list>',
      'Comma-separated advisor models',
      DEFAULT_ADVISOR_MODELS.join(','),
    )
    .option('--codex-model <name>', 'Model for codex exec', DEFAULT_CODEX_MODEL)
    .option(
      '--codex-sandbox <mode>',
      'Sandbox mode for codex exec when not dangerous',
      'danger-full-access',
    )
    .option('--codex-dangerous', 'Use --dangerously-bypass-approvals-and-sandbox')
    .option('--codex-ephemeral', 'Run codex exec with --ephemeral')
    .option('--codex-json', 'Run codex exec with --json output')
    .option('--report-limit <num>', 'Max tokens for memory report line', '256')
    .option('--delay-ms <num>', 'Delay between rounds in milliseconds', '0')
    .addHelpText('after', [
      '',
      'Examples:',
      '  long GOAL.txt',
      '  long GOAL.txt --max-rounds 3',
      '  long GOAL.txt --no-board --codex-model gpt-5.3-codex',
    ].join('\n'))
  ;

  if (argv.length <= 2) {
    program.outputHelp();
    process.exit(0);
  }

  program.parse(argv);

  var args = program.args;
  var task_arg = String(args[0] ?? '').trim();
  if (!task_arg) {
    fail('Missing task file path.');
  }

  var raw = program.opts() as Record<string, unknown>;
  var max_rounds = Number(raw.maxRounds ?? 0);
  var report_limit = Number(raw.reportLimit ?? 256);
  var delay_ms = Number(raw.delayMs ?? 0);
  if (!Number.isInteger(max_rounds) || max_rounds < 0) {
    fail(`Invalid --max-rounds value: ${raw.maxRounds}`);
  }
  if (!Number.isInteger(report_limit) || report_limit <= 0) {
    fail(`Invalid --report-limit value: ${raw.reportLimit}`);
  }
  if (!Number.isInteger(delay_ms) || delay_ms < 0) {
    fail(`Invalid --delay-ms value: ${raw.delayMs}`);
  }

  var sandbox = String(raw.codexSandbox ?? 'danger-full-access');
  if (
    sandbox !== 'read-only'
    && sandbox !== 'workspace-write'
    && sandbox !== 'danger-full-access'
  ) {
    fail(`Invalid --codex-sandbox mode: ${sandbox}`);
  }

  var advisor_list = String(raw.advisorModels ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if ((raw.board as boolean) !== false && advisor_list.length === 0) {
    fail('Advisor board is enabled but --advisor-models is empty.');
  }

  var task_file = path.resolve(process.cwd(), task_arg);
  return {
    max_rounds,
    board: (raw.board as boolean) !== false,
    retrieval_model: String(raw.retrievalModel ?? DEFAULT_RETRIEVAL_MODEL),
    summary_model: String(raw.summaryModel ?? DEFAULT_SUMMARY_MODEL),
    advisor_models: advisor_list,
    codex_model: String(raw.codexModel ?? DEFAULT_CODEX_MODEL),
    codex_sandbox: sandbox,
    codex_dangerous: Boolean(raw.codexDangerous),
    codex_ephemeral: Boolean(raw.codexEphemeral),
    codex_json: Boolean(raw.codexJson),
    report_limit,
    delay_ms,
    task_file,
  };
}

// Main
// ----

// Runs the orchestrator loop
async function main(): Promise<void> {
  var opts = parse_cli(process.argv);
  if (!(await path_exists(opts.task_file))) {
    fail(`Task file not found: ${opts.task_file}`);
  }

  var root = await get_repo_root(process.cwd());
  await ensure_codex_exec_support();
  await ensure_long_gitignored(root);
  await ensure_memory_store(root);

  log_step(`Repository root: ${root}`);
  log_step(`Task file: ${opts.task_file}`);
  log_step(`Board enabled: ${opts.board ? 'yes' : 'no'}`);
  log_step(`Max rounds: ${opts.max_rounds === 0 ? 'infinite' : opts.max_rounds}`);

  var round = 1;
  while (opts.max_rounds === 0 || round <= opts.max_rounds) {
    await run_round(round, root, opts);
    round += 1;
    if (opts.delay_ms > 0 && (opts.max_rounds === 0 || round <= opts.max_rounds)) {
      log_step(`Sleeping for ${opts.delay_ms} ms before next round.`);
      await sleep_ms(opts.delay_ms);
    }
  }

  log_step('Loop finished.');
}

main().catch(error => {
  console.error(`[long] Fatal: ${error_message(error)}`);
  process.exit(1);
});
