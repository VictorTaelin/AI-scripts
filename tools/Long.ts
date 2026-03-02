#!/usr/bin/env bun

// Long.ts
// =======
// Codex loop: work → board review → repeat.
//
// Each round:
// 1. Codex works on the goal.
// 2. Board reviews the session (optional).
// 3. Next round includes the board's review.

import * as fs      from 'fs/promises';
import * as sfs     from 'fs';
import * as os      from 'os';
import * as path    from 'path';
import * as process from 'process';
import { spawn, execFile } from 'child_process';
import { promisify }       from 'util';
import { Command }         from 'commander';

var exec = promisify(execFile);

// Constants
// ---------

var MAX_BUFFER      = 64 * 1024 * 1024;
var HISTORY_TAIL    = 6_000;
var DEFAULT_MODEL   = 'gpt-5.3-codex';
var DEFAULT_GOAL    = '.long/GOAL';
var HALT_TAG        = '<HALT/>';
var LEGACY_HALT_TAG = '<GOAL:FULLY-COMPLETED/>';

// Types
// -----

type Opts = {
  goal_file:  string;
  max_rounds: number;
  model:      string;
  no_board:   boolean;
};

// Prompts
// -------

// Sent to the codex agent each round as the full input prompt.
var CODEX_PROMPT = (round: number, history: string, memory: string, review: string, answers: string, goal: string) => `\
ROUND ${round}

HISTORY (oldest first):
${history}

MEMORY (your persistent notes):
${memory || '(empty)'}

BOARD REVIEW (from previous round):
${review || '(empty)'}

ANSWERS (from human expert):
${answers || '(pending)'}

WORKFLOW (mandatory):
1. Work toward the goal.
2. Commit and push.
   If good → \`git add -A && git commit\`.
   If bad  → \`git stash && git commit --allow-empty\`.
3. Update \`.long/MEMORY\` and \`.long/QUESTIONS\`.
4. Write your final answer.

COMMIT MESSAGES:
Describe what you changed and why, the concrete results, and what to do next.
Every session must include a commit, even when nothing changed. MUST be around
256 tokens (mandatory).

ABOUT .long/MEMORY:
Persistent notes for your future self. Edit and include everything that could
help you reach the goal, including, for example, insights, failed approaches,
lessons learned, domain facts, paths to avoid, and so on. Keep it under the
token limit. This is NOT an append-only log. This is a notebook that you can
edit, delete, alter in any way. Use as an information vault. MAX: 2048 tokens.

ABOUT .long/QUESTIONS:
Questions to be answered by the human expert. Each question MUST include FULL
context, to help the human understand what you're taking about. Focus on your
communication skills. Remember the human can't read your mind. Contextualize
your question. Rule of thumb: should be good enough for Stack Overflow. This
file is VERY important: it is the only way for you to acquire insights from the
domain, or to break out of hard walls. Use it wisely. The expert's answers will
appear in the ANSWERS section above. Do not ask low-value questions. Prefer
questions that improve your core understanding of the domain. Answers may take
long to arrive. Don't wait; keep working. Remove questions that are answered or
stale. Keep it under the token limit. MAX: 1024 tokens.

ABOUT .long/GOAL:
Written out below. Do NOT edit it.

Use 'ttok' to measure the token count of commits and files (MANDATORY).

End your response with \`<CONTINUE/>\` or \`<HALT/>\` (if the goal is complete).

GOAL:
${goal}`;

// Sent to the board reviewer after each codex session.
var BOARD_PROMPT = (
  goal: string,
  history: string,
  memory: string,
  questions: string,
  session: string,
) => `\
A coding agent just completed a work session.

GOAL:
${goal || '(empty)'}

HISTORY:
${history || '(empty)'}

MEMORY:
${memory || '(empty)'}

--- FULL SESSION OUTPUT ---

${session}

--- END SESSION OUTPUT ---

# YOUR GOAL: PROVIDE INSIGHT TO THE CODING AGENT

Based on the session output, provide concise, actionable insights that
will help the agent make progress in the next iteration.
Focus on: mistakes to avoid, blind spots, better strategies, and key
technical corrections. If the agent is stuck in a local minima, get
it out by proposing fundamental changes. Reason from first principles
to deeply understand the domain, and then pass your most important
insights to the agent. Be brief and dense. Maximize insight per token.`;

// Utilities
// ---------

// Prints a prefixed log line.
function log(msg: string): void {
  console.log(`[long] ${msg}`);
}

// Throws a fatal error.
function fail(msg: string): never {
  throw new Error(msg);
}

// Converts unknown error to string.
function err_msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Returns true if path exists.
async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (e) {
    if ((e as any).code === 'ENOENT') {
      return false;
    }
    throw e;
  }
}

// Reads file or returns fallback if missing.
async function read_or(p: string, fb = ''): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (e) {
    if ((e as any).code === 'ENOENT') {
      return fb;
    }
    throw e;
  }
}

// Saves the latest prompt for a prompt category under ~/.ai.
async function save_prompt(nam: string, txt: string): Promise<void> {
  var dir  = path.join(os.homedir(), '.ai');
  var file = path.join(dir, `long-${nam}.txt`);
  if (nam === 'codex_prompt') {
    file = path.join(dir, 'long-codex-prompt.txt');
  } else if (nam === 'board_prompt') {
    file = path.join(dir, 'long-board-prompt.txt');
  }
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, txt, 'utf8');
  } catch (e) {
    log(`Prompt save failed (${nam}): ${err_msg(e)}`);
  }
}

// Compacts whitespace to one-line form.
function compact_line(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Clips history lines to the last `max` characters.
function clip_hist(lines: string[], max: number): string {
  var head = '- ...';
  var keep: string[] = [];
  var size = head.length;

  for (var i = lines.length - 1; i >= 0; --i) {
    var line = lines[i];
    var add  = 1 + line.length;

    if (keep.length > 0 && size + add > max) {
      break;
    }

    if (size + add > max) {
      var room = Math.max(0, max - size - 4);
      var cut  = line.slice(0, room);
      line     = `${cut}...`;
      add      = 1 + line.length;
    }

    keep.unshift(line);
    size += add;
  }

  return [head, ...keep].join('\n');
}

// Git
// ---

// Runs a git command and returns trimmed stdout.
async function git(args: string[], cwd: string): Promise<string> {
  var out = await exec('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return out.stdout.trimEnd();
}

// Resolves the git repo root, falling back to cwd.
async function repo_root(cwd: string): Promise<string> {
  try {
    var root = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
    return root || cwd;
  } catch {
    return cwd;
  }
}

// Gets recent commit history in chronological compact-line format.
async function get_history(root: string): Promise<string> {
  try {
    var raw   = await git(['log', '--reverse', '--format=%h%x1f%B%x1e'], root);
    var recs  = raw.split('\x1e');
    var lines = recs
      .map(rec => rec.trim())
      .filter(rec => rec.length > 0)
      .map(rec => {
        var sep = rec.indexOf('\x1f');
        if (sep < 0) {
          return '';
        }
        var hash = rec.slice(0, sep).trim();
        var body = compact_line(rec.slice(sep + 1));
        if (!hash || !body) {
          return '';
        }
        return `- ${hash} ${body}`;
      })
      .filter(line => line.length > 0);

    return clip_hist(lines, HISTORY_TAIL);
  } catch {
    return '- ...';
  }
}

// Codex
// -----

// Validates that codex exec supports required flags.
async function ensure_codex(): Promise<void> {
  try {
    var out  = await exec('codex', ['exec', '--help'], { maxBuffer: MAX_BUFFER });
    var help = out.stdout;
    if (!help.includes('read from stdin') || !help.includes('--output-last-message')) {
      fail('codex exec missing required flags.');
    }
  } catch (e) {
    fail(`codex exec not available: ${err_msg(e)}`);
  }
}

// Builds the prompt for one round.
function build_prompt(goal: string, history: string, review: string, memory: string, answers: string, round: number): string {
  return CODEX_PROMPT(round, history, memory, review, answers, goal);
}

// Runs one codex exec round. Returns { last, captured }.
async function run_codex(
  root: string,
  prompt: string,
  opts: Opts,
  on_clear: () => void,
): Promise<{ last: string; captured: string }> {
  var tmp = path.join(os.tmpdir(), `long-${process.pid}.txt`);
  try { await fs.unlink(tmp); } catch {}

  var args = [
    'exec', '-C', root,
    '-m', opts.model,
    '-c', 'model_reasoning_effort="xhigh"',
    '--output-last-message', tmp,
    '--dangerously-bypass-approvals-and-sandbox',
    '-',
  ];

  var captured = '';
  try {
    await new Promise<void>((resolve, reject) => {
      var child = spawn('codex', args, {
        cwd:   root,
        stdio: ['pipe', 'pipe', 'pipe'],
        env:   { ...process.env, FORCE_COLOR: '1' },
      });
      function mirror_and_capture(out: NodeJS.WriteStream, chunk: Buffer): void {
        out.write(chunk);
        var text = chunk.toString('utf8');
        captured += text;
      }
      child.stdout.on('data', (chunk: Buffer) => {
        mirror_and_capture(process.stdout, chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        mirror_and_capture(process.stderr, chunk);
      });
      setTimeout(() => {
        captured = '';
        console.clear();
        on_clear();
      }, 600);
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`codex exited ${code}`));
        }
      });
      child.stdin.end(prompt);
    });

    var last = (await read_or(tmp)).trim();
    return { last, captured };
  } finally {
    try { await fs.unlink(tmp); } catch {}
  }
}

// Board
// -----

// Calls the board to review a codex session. Returns the review text.
async function run_board(
  goal: string,
  history: string,
  memory: string,
  questions: string,
  captured: string,
): Promise<string> {
  var tmp     = path.join(os.tmpdir(), `long-board-${process.pid}.txt`);
  var content = BOARD_PROMPT(goal, history, memory, questions, captured);

  await save_prompt('board_prompt', content);
  await fs.writeFile(tmp, content, 'utf8');

  try {
    var out = await new Promise<string>((resolve, reject) => {
      var child  = spawn('board', [tmp], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      var stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`board exited ${code}`));
        }
      });
    });
    return out.trim();
  } catch (e) {
    log(`Board failed: ${err_msg(e)}`);
    return '';
  } finally {
    try { await fs.unlink(tmp); } catch {}
  }
}

// CLI
// ---

// Parses command-line arguments.
function parse_cli(argv: string[]): Opts {
  var cmd = new Command();
  cmd
    .name('long')
    .summary('codex loop: goal → work → board review → repeat')
    .argument('[goal]', 'Goal file path', DEFAULT_GOAL)
    .option('-n, --max-rounds <num>', 'Max rounds (0 = unlimited)', '0')
    .option('--model <name>', 'Codex model', DEFAULT_MODEL)
    .option('--no-board', 'Disable board review between rounds');

  cmd.parse(argv);

  var raw            = cmd.opts() as Record<string, unknown>;
  var max_rounds_raw = Number(raw.maxRounds ?? 0);
  var goal_file      = String(cmd.args[0] ?? DEFAULT_GOAL);
  var no_board       = raw.board === false;

  if (!Number.isFinite(max_rounds_raw) || max_rounds_raw < 0 || !Number.isInteger(max_rounds_raw)) {
    fail('Invalid --max-rounds. Expected a non-negative integer.');
  }

  return {
    goal_file,
    max_rounds: max_rounds_raw,
    model:    String(raw.model ?? DEFAULT_MODEL),
    no_board,
  };
}

// Ensures .long/ dir and all required files exist, creating empties if missing.
async function ensure_files(root: string, goal_file: string): Promise<void> {
  var dir = path.join(root, '.long');
  await fs.mkdir(dir, { recursive: true });
  var files = [goal_file, path.join(dir, 'MEMORY'), path.join(dir, 'QUESTIONS'), path.join(dir, 'ANSWERS')];
  for (var file of files) {
    if (!(await exists(file))) {
      await fs.writeFile(file, '', 'utf8');
    }
  }
}

// Resolves the goal file path from repo root.
function resolve_goal(goal_file: string, root: string): string {
  if (path.isAbsolute(goal_file)) {
    return goal_file;
  }
  return path.join(root, goal_file);
}

// Logging
// -------

// Formats a date as YYYYyMMmDDd.HHhMMmSSs.
function fmt_time(d: Date): string {
  var Y  = d.getFullYear();
  var Mo = String(d.getMonth() + 1).padStart(2, '0');
  var D  = String(d.getDate()).padStart(2, '0');
  var H  = String(d.getHours()).padStart(2, '0');
  var Mi = String(d.getMinutes()).padStart(2, '0');
  var S  = String(d.getSeconds()).padStart(2, '0');
  return `${Y}y${Mo}m${D}d.${H}h${Mi}m${S}s`;
}

// Tees all stdout/stderr to a log file. Returns the log path.
function start_log(): string {
  var dir  = path.join(os.homedir(), '.ai', 'long_history');
  var file = path.join(dir, `${fmt_time(new Date())}.txt`);
  sfs.mkdirSync(dir, { recursive: true });
  var fd = sfs.openSync(file, 'a');

  var orig_out = process.stdout.write.bind(process.stdout);
  var orig_err = process.stderr.write.bind(process.stderr);

  process.stdout.write = function (chunk: any, ...args: any[]): boolean {
    var buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    sfs.writeSync(fd, buf);
    return (orig_out as any)(chunk, ...args);
  } as any;

  process.stderr.write = function (chunk: any, ...args: any[]): boolean {
    var buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    sfs.writeSync(fd, buf);
    return (orig_err as any)(chunk, ...args);
  } as any;

  return file;
}

// Main
// ----

// Runs the long loop.
async function main(): Promise<void> {
  var opts = parse_cli(process.argv);
  var log_file = start_log();
  log(`log: ${log_file}`);
  var root      = await repo_root(process.cwd());
  var goal_file = resolve_goal(opts.goal_file, root);
  var ans_file  = path.join(root, '.long', 'ANSWERS');
  var review    = '';

  await ensure_files(root, goal_file);
  await ensure_codex();

  var round = 1;
  while (opts.max_rounds === 0 || round <= opts.max_rounds) {
    var goal    = (await fs.readFile(goal_file, 'utf8')).trim();
    var memory  = (await read_or(path.join(root, '.long', 'MEMORY'))).trim();
    var quests  = (await read_or(path.join(root, '.long', 'QUESTIONS'))).trim();
    var answers = (await read_or(ans_file)).trim();
    var history = await get_history(root);
    if (answers) {
      await fs.writeFile(ans_file, '', 'utf8');
      log('Injecting answers from .long/ANSWERS');
    }
    var prompt  = build_prompt(goal, history, review, memory, answers, round);
    await save_prompt('codex_prompt', prompt);
    var header  = () => {
      log(`repo:  ${root}`);
      log(`goal:  ${goal_file}`);
      log(`model: ${opts.model}`);
      log(`========== ROUND ${round} ==========`);
    };
    header();
    var result = await run_codex(root, prompt, opts, header);

    if (result.last.includes(HALT_TAG) || result.last.includes(LEGACY_HALT_TAG)) {
      log('Goal fully completed.');
      break;
    }

    // Board review between rounds
    var has_next_round = opts.max_rounds === 0 || round < opts.max_rounds;
    if (!opts.no_board && has_next_round) {
      log('Running board review...');
      review = await run_board(goal, history, memory, quests, result.captured);
      if (review) {
        log('Board review received.');
      }
    }

    round += 1;
  }

  log('Done.');
}

main().catch(e => {
  console.error(`[long] Fatal: ${err_msg(e)}`);
  process.exit(1);
});
