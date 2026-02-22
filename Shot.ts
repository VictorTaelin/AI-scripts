#!/usr/bin/env bun

// Shot.ts
// =======
// A one-shot AI code editing tool using search/replace patching.
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
//    line number for reference. For example:
//
//      0|hello this is
//      1|some example file
//
// 2. The numbered files are concatenated into a unified context block.
//
// 3. The AI is first asked to emit structured tool calls:
//    - str_replace(path, old_str, new_str)
//    - create_file(path, file_text)
//    When tool-calling is unavailable, Shot falls back to free-text XML commands.
//
// 4. Patches are matched against file content using a layered strategy:
//    exact match, then trailing-whitespace-tolerant, then line-prefix-stripped.
//
// 5. A <write> command creates or completely overwrites a file.
//
// 6. A log file is saved to ./.shot/ with the full prompt and response.

// Imports
// -------

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GenAI, resolveModelSpec, tokenCount } from './GenAI';
import type { AskResult, ToolCall, ToolDef } from './GenAI';
import minimatch from 'minimatch';

const execFileAsync = promisify(execFile);

// Helpers
// -------

// Formats a date as a compact timestamp string
function formatTimestamp(date: Date): string {
  var pad = (n: number) => n.toString().padStart(2, '0');
  var d   = date;
  return `${d.getFullYear()}y${pad(d.getMonth() + 1)}m${pad(d.getDate())}d${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}s`;
}

// Prefixes each line with a zero-padded line number
function numberLines(content: string): string {
  var lines = content.split('\n');
  var width = Math.max(1, (lines.length - 1).toString().length);
  return lines.map((line, i) =>
    `${i.toString().padStart(width, '0')}|${line}`
  ).join('\n');
}

// Parses the input file into model, file patterns, and prompt
function parseInputFile(content: string): { model: string; patterns: string[]; prompt: string } {
  var lines    = content.split('\n');
  var model    = lines[0].trim();
  var patterns = [] as string[];
  var i = 1;
  for (; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.startsWith('./')) {
      patterns.push(line);
    } else {
      break;
    }
  }
  while (i < lines.length && lines[i].trim() === '') {
    i++;
  }
  var prompt = lines.slice(i).join('\n').trim();
  return { model, patterns, prompt };
}

// Expands glob patterns against git-tracked files
async function resolvePatterns(patterns: string[]): Promise<string[]> {
  var allFiles: string[];
  try {
    var { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard']);
    allFiles = stdout.split('\n').filter(f => f.length > 0).map(f => `./${f}`);
  } catch {
    return patterns;
  }
  var result = [] as string[];
  var seen   = new Set<string>();
  for (var pattern of patterns) {
    if (pattern.includes('*')) {
      for (var file of allFiles) {
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

// Trims a single leading/trailing newline from tag content
function trimTagContent(raw: string): string {
  var s = raw;
  if (s.startsWith('\n')) s = s.slice(1);
  if (s.endsWith('\n'))  s = s.slice(0, -1);
  return s;
}

// Normalizes tool-emitted file paths to workspace-relative form
function normalizeToolPath(file: string): string {
  var file = file.trim();
  if (file.startsWith('/')) {
    file = `.${file}`;
  }
  if (file.startsWith('./') || file.startsWith('../')) {
    return file;
  }
  return `./${file}`;
}

// Types
// -----

type PatchCommand = {
  file:    string;
  old_str: string;
  new_str: string;
  ordinal: number;
};

type WriteCommand = {
  file:    string;
  content: string;
  ordinal: number;
};

type DeleteCommand = {
  file: string;
  ordinal: number;
};

// Parsing
// -------

// Extracts <patch> commands (search/replace) from the AI reply
function parsePatchCommands(reply: string): PatchCommand[] {
  var regex    = /<patch\s+file="([^"]+)">\s*<old>([\s\S]*?)<\/old>\s*<new>([\s\S]*?)<\/new>\s*<\/patch>/g;
  var commands = [] as PatchCommand[];
  var match: RegExpExecArray | null;
  while ((match = regex.exec(reply)) !== null) {
    var [, file, old_raw, new_raw] = match;
    commands.push({
      file,
      old_str: trimTagContent(old_raw),
      new_str: trimTagContent(new_raw),
      ordinal: commands.length,
    });
  }
  return commands;
}

// Extracts <write> commands from the AI reply
function parseWriteCommands(reply: string): WriteCommand[] {
  var regex    = /<write\s+file="([^"]+)">([\s\S]*?)<\/write>/g;
  var commands = [] as WriteCommand[];
  var match: RegExpExecArray | null;
  while ((match = regex.exec(reply)) !== null) {
    var [, file, rawContent] = match;
    commands.push({ file, content: trimTagContent(rawContent), ordinal: commands.length });
  }
  return commands;
}

// Extracts structured patch/write commands from tool calls
function parseToolCalls(toolCalls: ToolCall[]): {
  patches: PatchCommand[];
  writes: WriteCommand[];
  deletes: DeleteCommand[];
} {
  var patches = [] as PatchCommand[];
  var writes  = [] as WriteCommand[];
  var deletes = [] as DeleteCommand[];

  for (var call of toolCalls) {
    var input = call.input ?? {};
    switch (call.name) {
      case 'str_replace': {
        var path_val = typeof input.path === 'string' ? normalizeToolPath(input.path) : '';
        var old_val  = typeof input.old_str === 'string' ? input.old_str : '';
        var new_val  = typeof input.new_str === 'string' ? input.new_str : '';
        if (!path_val) {
          continue;
        }
        patches.push({
          file: path_val,
          old_str: old_val,
          new_str: new_val,
          ordinal: patches.length,
        });
        break;
      }
      case 'create_file': {
        var path_val = typeof input.path === 'string' ? normalizeToolPath(input.path) : '';
        var text_val = typeof input.file_text === 'string' ? input.file_text : '';
        if (!path_val) {
          continue;
        }
        writes.push({
          file: path_val,
          content: text_val,
          ordinal: writes.length,
        });
        break;
      }
      case 'delete_file': {
        var path_val = typeof input.path === 'string' ? normalizeToolPath(input.path) : '';
        if (!path_val) {
          continue;
        }
        deletes.push({
          file: path_val,
          ordinal: deletes.length,
        });
        break;
      }
      default: {
        console.error(`Warning: unknown tool call "${call.name}" ignored.`);
      }
    }
  }

  return { patches, writes, deletes };
}

// Groups commands by their file path
function groupByFile<T extends { file: string }>(commands: T[]): Map<string, T[]> {
  var grouped = new Map<string, T[]>();
  for (var command of commands) {
    var arr = grouped.get(command.file);
    if (arr === undefined) {
      grouped.set(command.file, [command]);
    } else {
      arr.push(command);
    }
  }
  return grouped;
}

// Matching
// --------

type MatchRange = { start: number; end: number };

// Finds a unique match via line-by-line comparison with trimmed trailing whitespace
function matchTrimmed(content: string, needle: string): MatchRange | "ambiguous" | null {
  var file_lines = content.split('\n');
  var old_lines  = needle.split('\n');
  var trim_old   = old_lines.map(l => l.trimEnd());
  var found      = -1;
  for (var i = 0; i <= file_lines.length - old_lines.length; i++) {
    var ok = true;
    for (var j = 0; j < old_lines.length; j++) {
      if (file_lines[i + j].trimEnd() !== trim_old[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      if (found !== -1) return "ambiguous";
      found = i;
    }
  }
  if (found === -1) return null;
  var before = found > 0 ? file_lines.slice(0, found).join('\n').length + 1 : 0;
  var len    = file_lines.slice(found, found + old_lines.length).join('\n').length;
  return { start: before, end: before + len };
}

// Tries exact match, then trimmed match, then line-prefix-stripped match
function findMatch(content: string, old_str: string): MatchRange | string {
  // Strategy 1: exact substring match
  var idx = content.indexOf(old_str);
  if (idx !== -1) {
    if (content.indexOf(old_str, idx + 1) !== -1) {
      return "matches multiple locations; include more context";
    }
    return { start: idx, end: idx + old_str.length };
  }

  // Strategy 2: line-by-line with trailing whitespace trimmed
  var res = matchTrimmed(content, old_str);
  if (res === "ambiguous") return "matches multiple locations; include more context";
  if (res !== null) return res;

  // Strategy 3: strip line-number prefixes (AI included them by mistake)
  var bare = old_str.replace(/^\d+\|/gm, '');
  if (bare !== old_str) {
    var idx = content.indexOf(bare);
    if (idx !== -1) {
      if (content.indexOf(bare, idx + 1) !== -1) {
        return "matches multiple locations; include more context";
      }
      return { start: idx, end: idx + bare.length };
    }
    var res = matchTrimmed(content, bare);
    if (res === "ambiguous") return "matches multiple locations; include more context";
    if (res !== null) return res;
  }

  return "not found in file";
}

// Prompt
// ------

const EDIT_TOOLS: ToolDef[] = [
  {
    name: 'str_replace',
    description: 'Replace one exact old_str occurrence in a file with new_str.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path to edit.' },
        old_str: { type: 'string', description: 'Exact text to find. Must match one location.' },
        new_str: { type: 'string', description: 'Replacement text. May be empty for deletions.' },
      },
      required: ['path', 'old_str', 'new_str'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_file',
    description: 'Create or overwrite a file with complete contents.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path to create or overwrite.' },
        file_text: { type: 'string', description: 'Complete contents to write.' },
      },
      required: ['path', 'file_text'],
      additionalProperties: false,
    },
  },
];

const TOOL_CALL_PROMPT = `Use tool calls for every edit:
- Use str_replace for in-file edits.
- Use create_file when creating/replacing a whole file.
- Include enough context in old_str so it matches exactly one location.
- Do not include numbered prefixes like "00|" in tool arguments.
- For code editing tasks, do not emit XML tags like <patch> or <write>; call tools instead.

If the user asks an open ended question, answer normally without tool calls.`;

const XML_TOOL_PROMPT = `To complete the task, use the following tools:

PATCH: Replaces an exact occurrence of text in a file with new text.

<patch file="./path/to/file">
<old>
exact text to find
</old>
<new>
replacement text
</new>
</patch>

Notes:
- The <old> block must match EXACTLY ONE location in the file.
- Include enough surrounding lines to ensure a unique match.
- Do NOT include line-number prefixes (like "00|") in <old> or <new>.
- To delete code, leave the <new> block empty.
- Multiple patches on the same file are applied in order.

WRITE: Creates a new file or completely overwrites an existing file.

<write file="./path/to/file">
complete file contents
</write>

When the user asks an open ended question, answer without invoking any tool. `;

// Main
// ----

async function main(): Promise<void> {
  var inputFile = process.argv[2];
  if (!inputFile) {
    console.log('Usage: shot <file>');
    process.exit(1);
  }

  var raw = await fs.readFile(inputFile, 'utf-8');
  var { model, patterns, prompt } = parseInputFile(raw);

  var resolved = resolveModelSpec(model);
  console.log('model_label:', `${resolved.vendor}:${resolved.model}:${resolved.thinking}${resolved.fast ? ':fast' : ''}`);

  // Resolve glob patterns respecting .gitignore
  var paths = await resolvePatterns(patterns);

  // Load and format context files
  var contextParts = [] as string[];
  for (var p of paths) {
    try {
      var content = await fs.readFile(p, 'utf-8');
      contextParts.push(`${p}\n${numberLines(content)}`);
    } catch (err) {
      console.error(`Warning: could not read ${p}: ${(err as Error).message}`);
    }
  }

  var context     = contextParts.join('\n\n');
  var userMessage = `${context}\n\n${prompt}`;
  var systemPrompt = TOOL_CALL_PROMPT;
  var fullPrompt   = `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${userMessage}`;
  console.log('token_count:', tokenCount(fullPrompt));

  // Call AI
  var ai        = await GenAI(model);
  var reply     = '';
  var toolCalls = [] as ToolCall[];
  var usedXmlFallback = false;

  try {
    var toolResult: AskResult = await ai.askTools(userMessage, {
      system: TOOL_CALL_PROMPT,
      tools: EDIT_TOOLS,
    });
    reply = toolResult.text;
    toolCalls = toolResult.toolCalls;
  } catch (err) {
    usedXmlFallback = true;
    console.error(`Warning: tool calling unavailable, falling back to XML (${(err as Error).message})`);
  }

  if (usedXmlFallback) {
    systemPrompt = XML_TOOL_PROMPT;
    fullPrompt   = `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${userMessage}`;
    var replyRaw = await ai.ask(userMessage, { system: XML_TOOL_PROMPT });
    reply = typeof replyRaw === 'string'
      ? replyRaw
      : (replyRaw as any).messages?.map((m: any) => m.content).join('\n') ?? String(replyRaw);
  }

  var parsedTools = parseToolCalls(toolCalls);
  var patchCommands = parsedTools.patches;
  var writeCommands = parsedTools.writes;
  var deleteCommands = parsedTools.deletes;

  if (!usedXmlFallback && patchCommands.length === 0 && writeCommands.length === 0) {
    var fallbackPatches = parsePatchCommands(reply);
    var fallbackWrites  = parseWriteCommands(reply);
    if (fallbackPatches.length > 0 || fallbackWrites.length > 0) {
      patchCommands = fallbackPatches;
      writeCommands = fallbackWrites;
    }
  }

  if (usedXmlFallback) {
    patchCommands = parsePatchCommands(reply);
    writeCommands = parseWriteCommands(reply);
  }

  var patchesByFile = groupByFile(patchCommands);
  var writesByFile  = groupByFile(writeCommands);
  var deletesByFile = groupByFile(deleteCommands);
  var conflicted    = new Set<string>();

  var filesWithCommands = new Set<string>([
    ...patchesByFile.keys(),
    ...writesByFile.keys(),
    ...deletesByFile.keys(),
  ]);
  for (var file of filesWithCommands) {
    var kinds = 0;
    if (patchesByFile.has(file)) kinds++;
    if (writesByFile.has(file))  kinds++;
    if (deletesByFile.has(file)) kinds++;
    if (kinds > 1) {
      conflicted.add(file);
      console.error(`Conflict for ${file}: multiple command types present; skipping file.`);
    }
  }

  // Apply search/replace patches
  for (var [file, patches] of patchesByFile) {
    if (conflicted.has(file)) continue;
    try {
      var content = await fs.readFile(file, 'utf-8');
      var errors  = [] as string[];
      for (var patch of patches) {
        if (patch.old_str === '') {
          errors.push(`patch #${patch.ordinal}: empty <old> block`);
          continue;
        }
        var match = findMatch(content, patch.old_str);
        if (typeof match === 'string') {
          errors.push(`patch #${patch.ordinal}: ${match}`);
          continue;
        }
        content = content.slice(0, match.start) + patch.new_str + content.slice(match.end);
      }
      for (var err of errors) {
        console.error(`Error patching ${file}: ${err}`);
      }
      var applied = patches.length - errors.length;
      if (applied > 0) {
        await fs.writeFile(file, content, 'utf-8');
        console.log(`Patched ${file} (${applied}/${patches.length} applied)`);
      } else if (errors.length > 0) {
        console.log(`No patches applied to ${file}`);
      }
    } catch (err) {
      console.error(`Error patching ${file}: ${(err as Error).message}`);
    }
  }

  // Apply write commands
  for (var [file, writes] of writesByFile) {
    if (conflicted.has(file)) continue;
    var selected = writes.reduce((best, cur) => cur.ordinal > best.ordinal ? cur : best);
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

  // Apply delete commands
  for (var [file, deletes] of deletesByFile) {
    if (conflicted.has(file)) continue;
    if (deletes.length > 1) {
      console.error(`Warning: multiple delete commands for ${file}; deleting once.`);
    }
    try {
      await fs.unlink(file);
      console.log(`Deleted ${file}`);
    } catch (err) {
      var code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        console.log(`Delete skipped for ${file}: file does not exist`);
      } else {
        console.error(`Error deleting ${file}: ${(err as Error).message}`);
      }
    }
  }

  // Save log
  var logDir  = './.shot';
  await fs.mkdir(logDir, { recursive: true });
  var logPath = path.join(logDir, `${formatTimestamp(new Date())}.txt`);
  var toolLog = toolCalls.length > 0
    ? `\n\n[TOOL_CALLS]\n${JSON.stringify(toolCalls, null, 2)}\n`
    : '';
  await fs.writeFile(logPath, `${fullPrompt}\n\n---\n\n${reply}${toolLog}`, 'utf-8');
  console.log(`Log: ${logPath}`);

  // Append cleaned response to the input file
  var clean = reply
    .replace(/<\w[^>]*>[\s\S]*?<\/\w[^>]*>/g, '(...)')
    .replace(/\n{2,}/g, '\n');
  await fs.appendFile(inputFile, `\nAgent:\n${clean}\n`);
}

main().catch(err => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
