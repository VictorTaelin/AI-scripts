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
import { GenAI, resolveModelSpec } from './GenAI';
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

const TOOL_PROMPT = `To complete the task, use the following tools:

<patch file="./path/to/file" from=START to=END>
replacement lines
</patch>

Replaces lines START through END (inclusive, 0-indexed) with the replacement content. The replacement can have any number of lines.

<write file="./path/to/file">
complete file contents
</write>

Creates a new file or completely overwrites an existing file.

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
  console.log(`model: ${resolved.vendor}:${resolved.model}:${resolved.thinking}${resolved.fast ? ':fast' : ''}`);

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

  // Call AI
  const ai = await GenAI(model);
  const replyRaw = await ai.ask(userMessage, { system: TOOL_PROMPT });
  const reply = typeof replyRaw === 'string'
    ? replyRaw
    : (replyRaw as any).messages?.map((m: any) => m.content).join('\n') ?? String(replyRaw);

  // Parse and execute <patch> commands
  const patchRegex = /<patch\s+file="([^"]+)"\s+from=(\d+)\s+to=(\d+)>([\s\S]*?)<\/patch>/g;
  let match;
  while ((match = patchRegex.exec(reply)) !== null) {
    const [, file, fromStr, toStr, rawContent] = match;
    const from = parseInt(fromStr, 10);
    const to = parseInt(toStr, 10);
    try {
      const fileContent = await fs.readFile(file, 'utf-8');
      const lines = fileContent.split('\n');
      const trimmed = trimTagContent(rawContent);
      const replacementLines = trimmed === '' ? [] : trimmed.split('\n');
      lines.splice(from, to - from + 1, ...replacementLines);
      await fs.writeFile(file, lines.join('\n'), 'utf-8');
      console.log(`Patched ${file} lines ${from}-${to}`);
    } catch (err) {
      console.error(`Error patching ${file}: ${(err as Error).message}`);
    }
  }

  // Parse and execute <write> commands
  const writeRegex = /<write\s+file="([^"]+)">([\s\S]*?)<\/write>/g;
  while ((match = writeRegex.exec(reply)) !== null) {
    const [, file, rawContent] = match;
    const content = trimTagContent(rawContent);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, 'utf-8');
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
