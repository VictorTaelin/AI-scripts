#!/usr/bin/env bun

// Shot: a one-shot AI code editing tool.
//
// Usage:
//   shot my_file
//
// The input file must be formatted as follows:
//
//   model-name
//   ./path_0
//   ./path_1
//   ./path_2
//   ...
//
//   ... some prompt here ...
//
// - The first line is always the model name (e.g. "s", "g", "o+", etc.).
// - Then, a list of file paths, one per line, each starting with "./" (context).
//   Wildcards are supported: "./src/*.ts" or "./lib/**/*.js" will expand using
//   glob matching. Glob expansion respects .gitignore (files ignored by git are
//   excluded). Without git, wildcard patterns are used as literal paths.
// - Then, a blank line separating the paths from the prompt.
// - Then, an arbitrary textual prompt describing the task.
//
// How it works:
//
// 1. All context files are loaded and each line is prefixed with a zero-padded
//    line number. For example, a file with 5 lines becomes:
//
//      0|hello this is
//      1|some example file
//      2|function (x) {
//      3|  return x
//      4|}
//
//    Line numbers are always padded to the same width. A 73-line file uses two
//    digits: 00|, 01|, ..., 72|.
//
// 2. The numbered files are concatenated into a unified context block:
//
//      ./path/to/file0.txt
//      00|contents of
//      01|file 0 go here
//
//      ./path/to/file1.txt
//      00|contents of
//      01|file 1 go here
//
// 3. The user's prompt is appended after the context.
//
// 4. A system prompt is appended describing the available tools:
//
//    - <patch file="..." from=N to=M>: replaces a slice of a file (lines N to
//      M, inclusive, 0-indexed) with new content.
//    - <write file="...">: writes a new file or overwrites an existing file.
//
//    These are the only two tools available to the AI.
//
// 5. The AI response is parsed and all tool calls are executed.
//
// 6. A log file is saved to ./.shot/YYYYyMMmDDdHHhMMmSSs.txt containing the
//    complete prompt sent to the AI plus its complete answer (including tool
//    calls).

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GenAI, resolveModelSpec, tokenCount } from './GenAI';
import minimatch from 'minimatch';

const execFileAsync = promisify(execFile);

function formatTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}y${pad(date.getMonth() + 1)}m${pad(date.getDate())}d${pad(date.getHours())}h${pad(date.getMinutes())}m${pad(date.getSeconds())}s`;
}

function numberLines(content: string): string {
  const lines = content.split('\n');
  const width = Math.max(1, (lines.length - 1).toString().length);
  return lines.map((line, i) => `${i.toString().padStart(width, '0')}|${line}`).join('\n');
}

function parseInputFile(content: string): { model: string; patterns: string[]; prompt: string } {
  const lines = content.split('\n');
  const model = lines[0].trim();
  const patterns: string[] = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('./')) {
      patterns.push(line);
    } else {
      break;
    }
  }
  while (i < lines.length && lines[i].trim() === '') {
    i++;
  }
  const prompt = lines.slice(i).join('\n').trim();
  return { model, patterns, prompt };
}

async function resolvePatterns(patterns: string[]): Promise<string[]> {
  // Get all tracked + untracked (but not ignored) files via git
  let allFiles: string[];
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard']);
    allFiles = stdout.split('\n').filter(f => f.length > 0).map(f => `./${f}`);
  } catch {
    // Fallback: no git, just return patterns as-is (no glob expansion)
    return patterns;
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      for (const file of allFiles) {
        if (!seen.has(file) && minimatch(file, pattern, { matchBase: false })) {
          seen.add(file);
          result.push(file);
        }
      }
    } else {
      if (!seen.has(pattern)) {
        seen.add(pattern);
        result.push(pattern);
      }
    }
  }
  return result;
}

function trimTagContent(raw: string): string {
  let s = raw;
  if (s.startsWith('\n')) s = s.slice(1);
  if (s.endsWith('\n')) s = s.slice(0, -1);
  return s;
}

type PatchCommand = {
  file: string;
  from: number;
  to: number;
  replacementLines: string[];
  ordinal: number;
};

type WriteCommand = {
  file: string;
  content: string;
  ordinal: number;
};

function parsePatchCommands(reply: string): PatchCommand[] {
  const patchRegex = /<patch\s+file="([^"]+)"\s+from=(\d+)\s+to=(\d+)>([\s\S]*?)<\/patch>/g;
  const commands: PatchCommand[] = [];
  let match: RegExpExecArray | null;
  while ((match = patchRegex.exec(reply)) !== null) {
    const [, file, fromStr, toStr, rawContent] = match;
    const from = parseInt(fromStr, 10);
    const to = parseInt(toStr, 10);
    const trimmed = trimTagContent(rawContent);
    const replacementLines = trimmed === '' ? [] : trimmed.split('\n');
    commands.push({ file, from, to, replacementLines, ordinal: commands.length });
  }
  return commands;
}

function parseWriteCommands(reply: string): WriteCommand[] {
  const writeRegex = /<write\s+file="([^"]+)">([\s\S]*?)<\/write>/g;
  const commands: WriteCommand[] = [];
  let match: RegExpExecArray | null;
  while ((match = writeRegex.exec(reply)) !== null) {
    const [, file, rawContent] = match;
    commands.push({ file, content: trimTagContent(rawContent), ordinal: commands.length });
  }
  return commands;
}

function groupByFile<T extends { file: string }>(commands: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const command of commands) {
    const arr = grouped.get(command.file);
    if (arr === undefined) {
      grouped.set(command.file, [command]);
    } else {
      arr.push(command);
    }
  }
  return grouped;
}

function validatePatchCommands(lines: string[], patches: PatchCommand[]): string | null {
  for (const patch of patches) {
    if (patch.from < 0) {
      return `invalid patch range ${patch.from}-${patch.to}: "from" must be >= 0`;
    }
    if (patch.to < patch.from) {
      return `invalid patch range ${patch.from}-${patch.to}: "to" must be >= "from"`;
    }
    if (patch.to >= lines.length) {
      return `invalid patch range ${patch.from}-${patch.to}: file has ${lines.length} lines`;
    }
  }
  const sorted = patches.slice().sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    if (a.to !== b.to) return a.to - b.to;
    return a.ordinal - b.ordinal;
  });
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].from <= sorted[i - 1].to) {
      return `overlapping patch ranges ${sorted[i - 1].from}-${sorted[i - 1].to} and ${sorted[i].from}-${sorted[i].to}`;
    }
  }
  return null;
}

function applyPatchCommands(lines: string[], patches: PatchCommand[]): string[] {
  const out = lines.slice();
  // Apply from bottom to top so ranges refer to the original snapshot.
  const sorted = patches.slice().sort((a, b) => {
    if (a.from !== b.from) return b.from - a.from;
    if (a.to !== b.to) return b.to - a.to;
    return b.ordinal - a.ordinal;
  });
  for (const patch of sorted) {
    out.splice(patch.from, patch.to - patch.from + 1, ...patch.replacementLines);
  }
  return out;
}

const TOOL_PROMPT = `To complete the task, use the following tools:

PATCH: Replaces lines START through END (inclusive, 0-indexed) with the replacement content. The replacement can have any number of lines.

<patch file="./path/to/file" from=START to=END>
replacement lines
</patch>

Notes:
- Set 'from' to the FIRST line that changes, and 'to' to the LAST one.
- The script will REMOVE from..to (INCLUSIVE) and replace by your lines.
- Edits are stable on line ranges and, thus, order-invariant.

WRITE: creates a new file or completely overwrites an existing file.

<write file="./path/to/file">
complete file contents
</write>

When the user asks an open ended question, answer without invoking any tool. `;

async function main(): Promise<void> {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.log('Usage: shot <file>');
    process.exit(1);
  }

  const raw = await fs.readFile(inputFile, 'utf-8');
  const { model, patterns, prompt } = parseInputFile(raw);

  const resolved = resolveModelSpec(model);
  console.log('model_label:', `${resolved.vendor}:${resolved.model}:${resolved.thinking}${resolved.fast ? ':fast' : ''}`);

  // Resolve glob patterns respecting .gitignore
  const paths = await resolvePatterns(patterns);

  // Load and format context files
  const contextParts: string[] = [];
  for (const p of paths) {
    try {
      const content = await fs.readFile(p, 'utf-8');
      contextParts.push(`${p}\n${numberLines(content)}`);
    } catch (err) {
      console.error(`Warning: could not read ${p}: ${(err as Error).message}`);
    }
  }

  const context = contextParts.join('\n\n');
  const userMessage = `${context}\n\n${prompt}`;
  const fullPrompt = `[SYSTEM]\n${TOOL_PROMPT}\n\n[USER]\n${userMessage}`;
  console.log('token_count:', tokenCount(fullPrompt));

  // Call AI
  const ai = await GenAI(model);
  const replyRaw = await ai.ask(userMessage, { system: TOOL_PROMPT });
  const reply = typeof replyRaw === 'string'
    ? replyRaw
    : (replyRaw as any).messages?.map((m: any) => m.content).join('\n') ?? String(replyRaw);

  const patchCommands = parsePatchCommands(reply);
  const writeCommands = parseWriteCommands(reply);
  const patchesByFile = groupByFile(patchCommands);
  const writesByFile = groupByFile(writeCommands);
  const conflictedFiles = new Set<string>();

  for (const file of patchesByFile.keys()) {
    if (writesByFile.has(file)) {
      conflictedFiles.add(file);
      console.error(`Conflict for ${file}: both <patch> and <write> present; skipping file.`);
    }
  }

  // Parse and execute <patch> commands against per-file original snapshots.
  for (const [file, patches] of patchesByFile) {
    if (conflictedFiles.has(file)) {
      continue;
    }
    try {
      const fileContent = await fs.readFile(file, 'utf-8');
      const originalLines = fileContent.split('\n');
      const validationError = validatePatchCommands(originalLines, patches);
      if (validationError !== null) {
        console.error(`Error patching ${file}: ${validationError}`);
        continue;
      }
      const patchedLines = applyPatchCommands(originalLines, patches);
      await fs.writeFile(file, patchedLines.join('\n'), 'utf-8');
      const ranges = patches
        .slice()
        .sort((a, b) => a.from - b.from || a.to - b.to || a.ordinal - b.ordinal)
        .map(p => `${p.from}-${p.to}`)
        .join(', ');
      console.log(`Patched ${file} lines ${ranges}`);
    } catch (err) {
      console.error(`Error patching ${file}: ${(err as Error).message}`);
    }
  }

  // Parse and execute <write> commands.
  for (const [file, writes] of writesByFile) {
    if (conflictedFiles.has(file)) {
      continue;
    }
    const selected = writes.reduce((best, cur) => (cur.ordinal > best.ordinal ? cur : best));
    if (writes.length > 1) {
      console.error(`Warning: multiple <write> commands for ${file}; using last one.`);
    }
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, selected.content, 'utf-8');
      console.log(`Wrote ${file}`);
    } catch (err) {
      console.error(`Error writing ${file}: ${(err as Error).message}`);
    }
  }

  // Save log
  const logDir = './.shot';
  await fs.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `${formatTimestamp(new Date())}.txt`);
  await fs.writeFile(logPath, `${fullPrompt}\n\n---\n\n${reply}\n`, 'utf-8');
  console.log(`Log: ${logPath}`);
}

main().catch(err => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
