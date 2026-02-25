#!/usr/bin/env bun

// Long.ts
// =======
// Codex loop: goal → board → work → commit → push → signal.
//
// Each round, Codex:
// 1. Consults the `board` (AI advisor panel) for guidance.
// 2. Works on the goal.
// 3. Commits good changes (or stashes bad ones), pushes, and signals.
// 4. Responds with <GOAL:TO-BE-CONTINUED/> or <GOAL:FULLY-COMPLETED/>.

import * as fs      from 'fs/promises';
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
  delay_ms:   number;
  model:      string;
  sandbox:    string;
  dangerous:  boolean;
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

// Sleeps for ms milliseconds.
async function sleep(ms: number): Promise<void> {
  if (ms > 0) {
    await new Promise<void>(r => setTimeout(r, ms));
  }
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
function build_prompt(goal: string, history: string, round: number): string {
  return [
    `ROUND ${round}`,
    '',
    'GOAL:',
    goal,
    '',
    'RECENT COMMITS:',
    history,
    '',
    'WORKFLOW:',
    '1. Before doing ANY work, explore the codebase and gather ALL context',
    '   relevant to the goal. Then invoke the `board` skill, passing that',
    '   full context plus any questions you have. The board is a panel of',
    '   expert AI advisors — give them everything they need to produce the',
    '   most meaningful insights possible. Only start working AFTER you',
    '   have received and read the board response.',
    '2. Work on the goal for as long as you can.',
    '3. Once you are done working: if your changes are bad, `git stash`',
    '   then `git commit --allow-empty`. If good, `git add -A && git commit`.',
    '   Either way, the commit message must cover: what you did, what you',
    '   learned, key metrics and results, and open questions.',
    '4. `git push`.',
    '5. Your final response must be a single XML tag and absolutely nothing',
    '   else — no words, no commentary, no explanation before or after it:',
    '   `<GOAL:TO-BE-CONTINUED/>` or `<GOAL:FULLY-COMPLETED/>`',
  ].join('\n');
}

// Runs one codex exec round. Returns the last assistant message.
async function run_codex(root: string, prompt: string, opts: Opts): Promise<string> {
  var tmp = path.join(os.tmpdir(), `long-${process.pid}.txt`);
  try { await fs.unlink(tmp); } catch {}

  var args = [
    'exec', '-C', root,
    '-m', opts.model,
    '--output-last-message', tmp,
  ];
  if (opts.dangerous) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', opts.sandbox);
  }
  args.push('-');

  await new Promise<void>((resolve, reject) => {
    var child = spawn('codex', args, {
      cwd:   root,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
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
  return last;
}

// CLI
// ---

// Parses command-line arguments.
function parse_cli(argv: string[]): Opts {
  var cmd = new Command();
  cmd
    .name('long')
    .summary('codex loop: goal → board → work → commit → push')
    .argument('<goal>', 'Goal file path')
    .option('-n, --max-rounds <num>', 'Max rounds (0 = unlimited)', '0')
    .option('--delay-ms <num>', 'Delay between rounds (ms)', '0')
    .option('--model <name>', 'Codex model', DEFAULT_MODEL)
    .option('--sandbox <mode>', 'Sandbox mode', 'danger-full-access')
    .option('--dangerous', 'Bypass approvals and sandbox');

  cmd.parse(argv);

  var raw        = cmd.opts() as Record<string, unknown>;
  var max_rounds = Number(raw.maxRounds ?? 0);
  var delay_ms   = Number(raw.delayMs ?? 0);
  var goal_file  = path.resolve(process.cwd(), cmd.args[0]);

  return {
    goal_file,
    max_rounds,
    delay_ms,
    model:     String(raw.model ?? DEFAULT_MODEL),
    sandbox:   String(raw.sandbox ?? 'danger-full-access'),
    dangerous: Boolean(raw.dangerous),
  };
}

// Main
// ----

// Runs the long loop.
async function main(): Promise<void> {
  var opts = parse_cli(process.argv);

  if (!(await exists(opts.goal_file))) {
    fail(`Goal file not found: ${opts.goal_file}`);
  }

  var root = await repo_root(process.cwd());
  await ensure_codex();

  log(`repo:  ${root}`);
  log(`goal:  ${opts.goal_file}`);
  log(`model: ${opts.model}`);

  var round = 1;
  while (opts.max_rounds === 0 || round <= opts.max_rounds) {
    log(`========== ROUND ${round} ==========`);

    var goal    = (await fs.readFile(opts.goal_file, 'utf8')).trim();
    var history = await get_history(root);
    var prompt  = build_prompt(goal, history, round);
    var last    = await run_codex(root, prompt, opts);

    if (last.includes(COMPLETED_TAG)) {
      log('Goal fully completed.');
      break;
    }

    round += 1;
    await sleep(opts.delay_ms);
  }

  log('Done.');
}

main().catch(e => {
  console.error(`[long] Fatal: ${err_msg(e)}`);
  process.exit(1);
});
