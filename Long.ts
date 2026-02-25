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

var MAX_BUFFER    = 64 * 1024 * 1024;
var HISTORY_TAIL  = 16_000;
var DEFAULT_MODEL = 'gpt-5.3-codex';
var COMPLETED_TAG = '<GOAL:FULLY-COMPLETED/>';

// Types
// -----

type Opts = {
  goal_file:  string;
  max_rounds: number;
  model:      string;
  no_board:   boolean;
};

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

// Clips text to its last `max` characters.
function clip_tail(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  var cut = text.length - max;
  return `...[${cut} chars omitted]...\n${text.slice(cut)}`;
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

// Gets recent commit history, clipped to HISTORY_TAIL chars.
async function get_history(root: string): Promise<string> {
  try {
    var text = await git(['log', '--format=commit %h (%ai)%n%n%B'], root);
    return clip_tail(text, HISTORY_TAIL);
  } catch {
    return '(no commits yet)';
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
function build_prompt(goal: string, history: string, review: string, round: number): string {
  var parts = [
    `ROUND ${round}`,
    '',
    'HISTORY:',
    history,
  ];

  if (review) {
    parts.push('', 'BOARD REVIEW (from previous round):', review);
  }

  parts.push(
    '',
    'WORKFLOW:',
    '1. Work on the goal for as long as you can.',
    '2. Once you are done working: if your changes are bad, `git stash`',
    '   then `git commit --allow-empty`. If good, `git add -A && git commit`.',
    '   Either way, the commit message must cover: what you did, what you',
    '   learned, key metrics and results, and open questions. This is your',
    '   persistent memory — the HISTORY above is built from these commits.',
    '3. `git push`.',
    '4. Your final response must be a single XML tag and absolutely nothing',
    '   else — no words, no commentary, no explanation before or after it:',
    '   `<GOAL:TO-BE-CONTINUED/>` or `<GOAL:FULLY-COMPLETED/>`',
    '',
    'GOAL:',
    goal,
  );

  return parts.join('\n');
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
    '--output-last-message', tmp,
    '--dangerously-bypass-approvals-and-sandbox',
    '-',
  ];

  var captured = '';
  await new Promise<void>((resolve, reject) => {
    var child = spawn('codex', args, {
      cwd:   root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env:   { ...process.env, FORCE_COLOR: '1' },
    });
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      captured += chunk.toString('utf8');
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    setTimeout(() => { console.clear(); on_clear(); }, 500);
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
  try { await fs.unlink(tmp); } catch {}
  return { last, captured };
}

// Board
// -----

// Calls the board to review a codex session. Returns the review text.
async function run_board(captured: string, goal: string): Promise<string> {
  var tmp = path.join(os.tmpdir(), `long-board-${process.pid}.txt`);
  var content = [
    'A coding agent just completed a work session on the following goal:',
    '',
    goal,
    '',
    '--- FULL SESSION OUTPUT ---',
    '',
    captured,
    '',
    '--- END SESSION OUTPUT ---',
    '',
    'Based on the session output and the goal, provide concise, actionable',
    'insight that will help the agent make progress in the next iteration.',
    'Focus on: mistakes to avoid, blind spots, better strategies, and key',
    'technical corrections. Be brief and dense — maximize insight per token.',
  ].join('\n');

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
    .argument('<goal>', 'Goal file path')
    .option('-n, --max-rounds <num>', 'Max rounds (0 = unlimited)', '0')
    .option('--model <name>', 'Codex model', DEFAULT_MODEL)
    .option('--no-board', 'Disable board review between rounds');

  if (argv.length <= 2) {
    cmd.outputHelp();
    process.exit(0);
  }

  cmd.parse(argv);

  var raw        = cmd.opts() as Record<string, unknown>;
  var max_rounds = Number(raw.maxRounds ?? 0);
  var goal_file  = path.resolve(process.cwd(), cmd.args[0]);

  return {
    goal_file,
    max_rounds,
    model:    String(raw.model ?? DEFAULT_MODEL),
    no_board: Boolean(raw.noBoard),
  };
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

  if (!(await exists(opts.goal_file))) {
    fail(`Goal file not found: ${opts.goal_file}`);
  }

  var root   = await repo_root(process.cwd());
  var review = '';

  await ensure_codex();

  var round = 1;
  while (opts.max_rounds === 0 || round <= opts.max_rounds) {
    var goal    = (await fs.readFile(opts.goal_file, 'utf8')).trim();
    var history = await get_history(root);
    var prompt  = build_prompt(goal, history, review, round);
    var header  = () => {
      log(`repo:  ${root}`);
      log(`goal:  ${opts.goal_file}`);
      log(`model: ${opts.model}`);
      log(`========== ROUND ${round} ==========`);
    };
    header();
    var result = await run_codex(root, prompt, opts, header);

    if (result.last.includes(COMPLETED_TAG)) {
      log('Goal fully completed.');
      break;
    }

    // Board review between rounds
    if (!opts.no_board) {
      log('Running board review...');
      review = await run_board(result.captured, goal);
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
