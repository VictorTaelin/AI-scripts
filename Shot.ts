#!/usr/bin/env bun

// Shot.ts
// =======
// A one-shot AI code editing tool.
//
// Input format:
//   model-spec
//   ./context/path0
//   ./context/path1
//   ...
//
//   user prompt text...
//
// Behavior:
// - Collects context files and sends them to the model.
// - Prefers structured tool calling (`str_replace`, `create_file`).
// - Falls back to XML patch/write format when tool calling is unavailable.
// - Applies edits to disk and records a log in `./.shot/`.

// Imports
// -------

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import minimatch from 'minimatch';
import { GenAI } from './GenAI';
import type { AskResult, ToolCall, ToolDef } from './GenAI';

const exec_file_async = promisify(execFile);

// Types
// -----

type InputFile = {
  model: string;
  patterns: string[];
  prompt: string;
};

type PatchCommand = {
  file: string;
  old_str: string;
  new_str: string;
  ordinal: number;
};

type WriteCommand = {
  file: string;
  content: string;
  ordinal: number;
};

type DeleteCommand = {
  file: string;
  ordinal: number;
};

type MatchRange = {
  start: number;
  end: number;
};

type ParsedCommands = {
  patches: PatchCommand[];
  writes: WriteCommand[];
  deletes: DeleteCommand[];
};

// Constants
// ---------

const MAX_TOKENS = 8192;

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
- Do not call any read/view tool. The prompt already contains all context files.
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
- To delete code, leave the <new> block empty.
- Multiple patches on the same file are applied in order.

WRITE: Creates a new file or completely overwrites an existing file.

<write file="./path/to/file">
complete file contents
</write>

When the user asks an open ended question, answer without invoking any tool.`;

// Time
// ----

// Formats a timestamp used for log file names
function format_timestamp(date: Date): string {
  var pad = (n: number) => n.toString().padStart(2, '0');
  var d = date;
  return `${d.getFullYear()}y${pad(d.getMonth() + 1)}m${pad(d.getDate())}d${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}s`;
}

// Input
// -----

// Parses the shot input file
function parse_input_file(content: string): InputFile {
  var lines = content.split('\n');
  var model = lines[0]?.trim() ?? '';
  var patterns = [] as string[];

  var i = 1;
  for (; i < lines.length; ++i) {
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

// Paths
// -----

// Adds a recursive variant for single-star patterns, e.g. ./src/*.ts -> ./src/**/*.ts
function pattern_variants(pattern: string): string[] {
  var variants = [pattern];

  if (!pattern.includes('*')) {
    return variants;
  }
  if (pattern.includes('**')) {
    return variants;
  }

  var last_slash = pattern.lastIndexOf('/');
  if (last_slash === -1) {
    return variants;
  }

  var head = pattern.slice(0, last_slash);
  var tail = pattern.slice(last_slash + 1);
  if (!tail.includes('*')) {
    return variants;
  }

  var recursive = `${head}/**/${tail}`;
  if (recursive !== pattern) {
    variants.push(recursive);
  }

  return variants;
}

// Resolves file patterns using git-tracked/visible files; falls back to literal patterns without git
async function resolve_patterns(patterns: string[]): Promise<string[]> {
  var all_files = [] as string[];

  try {
    var { stdout } = await exec_file_async('git', ['ls-files', '--cached', '--others', '--exclude-standard']);
    all_files = stdout
      .split('\n')
      .filter(file => file.length > 0)
      .map(file => `./${file}`);
  } catch {
    return patterns;
  }

  var result = [] as string[];
  var seen = new Set<string>();

  for (var pattern of patterns) {
    if (!pattern.includes('*')) {
      if (!seen.has(pattern)) {
        seen.add(pattern);
        result.push(pattern);
      }
      continue;
    }

    var variants = pattern_variants(pattern);
    for (var file of all_files) {
      if (seen.has(file)) {
        continue;
      }
      for (var variant of variants) {
        if (minimatch(file, variant, { matchBase: false })) {
          seen.add(file);
          result.push(file);
          break;
        }
      }
    }
  }

  return result;
}

// Converts tool-provided paths to workspace-relative style
function normalize_tool_path(file: string): string {
  var file = file.trim();

  if (file.startsWith('/')) {
    var file = `.${file}`;
  }

  if (file.startsWith('./') || file.startsWith('../')) {
    return file;
  }

  return `./${file}`;
}

// Context
// -------

// Loads context files and serializes them into a model-readable block
async function build_context(paths: string[]): Promise<string> {
  var parts = [] as string[];

  for (var file of paths) {
    try {
      var content = await fs.readFile(file, 'utf-8');
      parts.push(`${file}\n${content}`);
    } catch {
      continue;
    }
  }

  return parts.join('\n\n');
}

// Prompt
// ------

// Builds the user message from context and task prompt
function build_user_message(context: string, prompt: string): string {
  if (context.length === 0) {
    return prompt;
  }
  if (prompt.length === 0) {
    return context;
  }
  return `${context}\n\n${prompt}`;
}

// Errors
// ------

// Detects transient API/network errors worth retrying once
function is_transient_error(err: unknown): boolean {
  var msg = (err as { message?: string })?.message ?? String(err);
  var low = msg.toLowerCase();

  if (low.includes('connection error')) return true;
  if (low.includes('timeout')) return true;
  if (low.includes('timed out')) return true;
  if (low.includes('econn')) return true;
  if (low.includes('socket')) return true;
  if (low.includes('429')) return true;
  if (low.includes('502')) return true;
  if (low.includes('503')) return true;
  if (low.includes('504')) return true;

  return false;
}

// Parsing
// -------

// Trims one leading and one trailing newline from tag content
function trim_tag_content(raw: string): string {
  var s = raw;
  if (s.startsWith('\n')) {
    var s = s.slice(1);
  }
  if (s.endsWith('\n')) {
    var s = s.slice(0, -1);
  }
  return s;
}

// Parses XML patch commands from fallback text
function parse_patch_commands(reply: string): PatchCommand[] {
  var regex = /<patch\s+file="([^"]+)">\s*<old>([\s\S]*?)<\/old>\s*<new>([\s\S]*?)<\/new>\s*<\/patch>/g;
  var commands = [] as PatchCommand[];
  var match: RegExpExecArray | null;

  while ((match = regex.exec(reply)) !== null) {
    var [, file, old_raw, new_raw] = match;
    commands.push({
      file,
      old_str: trim_tag_content(old_raw),
      new_str: trim_tag_content(new_raw),
      ordinal: commands.length,
    });
  }

  return commands;
}

// Parses XML write commands from fallback text
function parse_write_commands(reply: string): WriteCommand[] {
  var regex = /<write\s+file="([^"]+)">([\s\S]*?)<\/write>/g;
  var commands = [] as WriteCommand[];
  var match: RegExpExecArray | null;

  while ((match = regex.exec(reply)) !== null) {
    var [, file, raw_content] = match;
    commands.push({
      file,
      content: trim_tag_content(raw_content),
      ordinal: commands.length,
    });
  }

  return commands;
}

// Converts abstract tool calls into patch/write/delete command lists
function parse_tool_calls(tool_calls: ToolCall[]): ParsedCommands {
  var patches = [] as PatchCommand[];
  var writes = [] as WriteCommand[];
  var deletes = [] as DeleteCommand[];

  for (var call of tool_calls) {
    var input = call.input ?? {};

    switch (call.name) {
      case 'str_replace': {
        var path_val = typeof input.path === 'string' ? normalize_tool_path(input.path) : '';
        var has_old = typeof input.old_str === 'string';
        var has_new = typeof input.new_str === 'string';

        if (!path_val || !has_old || !has_new) {
          continue;
        }

        patches.push({
          file: path_val,
          old_str: input.old_str,
          new_str: input.new_str,
          ordinal: patches.length,
        });
        break;
      }
      case 'create_file': {
        var path_val = typeof input.path === 'string' ? normalize_tool_path(input.path) : '';
        var has_text = typeof input.file_text === 'string';

        if (!path_val || !has_text) {
          continue;
        }

        writes.push({
          file: path_val,
          content: input.file_text,
          ordinal: writes.length,
        });
        break;
      }
      case 'delete_file': {
        var path_val = typeof input.path === 'string' ? normalize_tool_path(input.path) : '';
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
        continue;
      }
    }
  }

  return { patches, writes, deletes };
}

// Matching
// --------

// Finds a unique block match line-by-line, ignoring trailing whitespace differences
function match_trimmed(content: string, needle: string): MatchRange | 'ambiguous' | null {
  var file_lines = content.split('\n');
  var old_lines = needle.split('\n');
  var trim_old = old_lines.map(line => line.trimEnd());
  var found = -1;

  for (var i = 0; i <= file_lines.length - old_lines.length; ++i) {
    var ok = true;
    for (var j = 0; j < old_lines.length; ++j) {
      if (file_lines[i + j].trimEnd() !== trim_old[j]) {
        ok = false;
        break;
      }
    }

    if (!ok) {
      continue;
    }

    if (found !== -1) {
      return 'ambiguous';
    }

    found = i;
  }

  if (found === -1) {
    return null;
  }

  var before = found > 0
    ? file_lines.slice(0, found).join('\n').length + 1
    : 0;
  var len = file_lines.slice(found, found + old_lines.length).join('\n').length;
  return { start: before, end: before + len };
}

// Finds exactly one replace target in a file
function find_match(content: string, old_str: string): MatchRange | string {
  var idx = content.indexOf(old_str);
  if (idx !== -1) {
    if (content.indexOf(old_str, idx + 1) !== -1) {
      return 'matches multiple locations; include more context';
    }
    return { start: idx, end: idx + old_str.length };
  }

  var trimmed = match_trimmed(content, old_str);
  if (trimmed === 'ambiguous') {
    return 'matches multiple locations; include more context';
  }
  if (trimmed !== null) {
    return trimmed;
  }

  return 'not found in file';
}

// Apply
// -----

// Groups commands by file path
function group_by_file<T extends { file: string }>(commands: T[]): Map<string, T[]> {
  var grouped = new Map<string, T[]>();

  for (var cmd of commands) {
    var list = grouped.get(cmd.file);
    if (list === undefined) {
      grouped.set(cmd.file, [cmd]);
    } else {
      list.push(cmd);
    }
  }

  return grouped;
}

// Applies patch commands
async function apply_patches(commands: PatchCommand[], conflicted: Set<string>): Promise<void> {
  var patches_by_file = group_by_file(commands);

  for (var [file, patches] of patches_by_file) {
    if (conflicted.has(file)) {
      continue;
    }

    try {
      var content = await fs.readFile(file, 'utf-8');
      var errors = [] as string[];

      for (var patch of patches) {
        if (patch.old_str === '') {
          errors.push(`patch #${patch.ordinal}: empty <old> block`);
          continue;
        }

        var match = find_match(content, patch.old_str);
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
      }
    } catch (err) {
      console.error(`Error patching ${file}: ${(err as Error).message}`);
    }
  }
}

// Applies write commands (last write for each file wins)
async function apply_writes(commands: WriteCommand[], conflicted: Set<string>): Promise<void> {
  var writes_by_file = group_by_file(commands);

  for (var [file, writes] of writes_by_file) {
    if (conflicted.has(file)) {
      continue;
    }

    var selected = writes.reduce((best, cur) => cur.ordinal > best.ordinal ? cur : best);

    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, selected.content, 'utf-8');
    } catch (err) {
      console.error(`Error writing ${file}: ${(err as Error).message}`);
    }
  }
}

// Applies delete commands
async function apply_deletes(commands: DeleteCommand[], conflicted: Set<string>): Promise<void> {
  var deletes_by_file = group_by_file(commands);

  for (var [file] of deletes_by_file) {
    if (conflicted.has(file)) {
      continue;
    }

    try {
      await fs.unlink(file);
    } catch (err) {
      var code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        continue;
      }
      console.error(`Error deleting ${file}: ${(err as Error).message}`);
    }
  }
}

// Determines files that have mixed command kinds and must be skipped
function find_conflicts(parsed: ParsedCommands): Set<string> {
  var conflicts = new Set<string>();

  var patches_by_file = group_by_file(parsed.patches);
  var writes_by_file = group_by_file(parsed.writes);
  var deletes_by_file = group_by_file(parsed.deletes);

  var files = new Set<string>([
    ...patches_by_file.keys(),
    ...writes_by_file.keys(),
    ...deletes_by_file.keys(),
  ]);

  for (var file of files) {
    var kinds = 0;
    if (patches_by_file.has(file)) {
      kinds++;
    }
    if (writes_by_file.has(file)) {
      kinds++;
    }
    if (deletes_by_file.has(file)) {
      kinds++;
    }

    if (kinds > 1) {
      conflicts.add(file);
      console.error(`Conflict for ${file}: multiple command types present; skipping file.`);
    }
  }

  return conflicts;
}

// AI
// --

// Requests structured tool calls, with one retry for transient failures
async function request_tools(model: string, user_message: string): Promise<{ result: AskResult; error: Error | null }> {
  var last_error: Error | null = null;

  for (var attempt = 0; attempt < 2; ++attempt) {
    try {
      var ai = await GenAI(model);
      var result = await ai.askTools(user_message, {
        system: TOOL_CALL_PROMPT,
        tools: EDIT_TOOLS,
        stream: true,
        max_tokens: MAX_TOKENS,
      });
      return { result, error: null };
    } catch (err) {
      var cur = err as Error;
      var retry = attempt === 0 && is_transient_error(err);
      last_error = cur;
      if (!retry) {
        break;
      }
    }
  }

  return {
    result: { text: '', toolCalls: [] },
    error: last_error,
  };
}

// Requests free-text XML as fallback
async function request_xml(model: string, user_message: string, tool_error: Error | null): Promise<string> {
  try {
    var ai = await GenAI(model);
    var reply_raw = await ai.ask(user_message, {
      system: XML_TOOL_PROMPT,
      stream: true,
      max_tokens: MAX_TOKENS,
    });

    if (typeof reply_raw === 'string') {
      return reply_raw;
    }

    var messages = (reply_raw as any).messages;
    if (Array.isArray(messages)) {
      return messages.map((msg: any) => msg.content).join('\n');
    }

    return String(reply_raw);
  } catch (err) {
    if (tool_error) {
      throw new Error(`Tool call failed: ${tool_error.message}. XML fallback failed: ${(err as Error).message}`);
    }
    throw err;
  }
}

// Log
// ---

// Persists a run log to ./.shot
async function save_log(system: string, user_message: string, reply: string, tool_calls: ToolCall[]): Promise<void> {
  var log_dir = './.shot';
  await fs.mkdir(log_dir, { recursive: true });

  var log_path = path.join(log_dir, `${format_timestamp(new Date())}.txt`);
  var full_prompt = `[SYSTEM]\n${system}\n\n[USER]\n${user_message}`;
  var tool_block = tool_calls.length > 0
    ? `\n\n[TOOL_CALLS]\n${JSON.stringify(tool_calls, null, 2)}\n`
    : '';

  await fs.writeFile(log_path, `${full_prompt}\n\n---\n\n${reply}${tool_block}`, 'utf-8');
}

// Main
// ----

// Runs shot end-to-end
async function main(): Promise<void> {
  var input_file = process.argv[2];
  if (!input_file) {
    console.log('Usage: shot <file>');
    process.exit(1);
  }

  var raw = await fs.readFile(input_file, 'utf-8');
  var parsed = parse_input_file(raw);

  var paths = await resolve_patterns(parsed.patterns);
  var context = await build_context(paths);
  var user_message = build_user_message(context, parsed.prompt);

  var tool_req = await request_tools(parsed.model, user_message);
  var tool_result = tool_req.result;
  var tool_error = tool_req.error;

  var used_xml_fallback = tool_error !== null;
  var reply = tool_result.text;
  var tool_calls = tool_result.toolCalls;
  var system = TOOL_CALL_PROMPT;

  if (used_xml_fallback) {
    reply = await request_xml(parsed.model, user_message, tool_error);
    tool_calls = [];
    system = XML_TOOL_PROMPT;
  }

  var cmds = parse_tool_calls(tool_calls);

  if (!used_xml_fallback && cmds.patches.length === 0 && cmds.writes.length === 0) {
    var xml_patches = parse_patch_commands(reply);
    var xml_writes = parse_write_commands(reply);
    if (xml_patches.length > 0 || xml_writes.length > 0) {
      cmds.patches = xml_patches;
      cmds.writes = xml_writes;
    }
  }

  if (used_xml_fallback) {
    cmds.patches = parse_patch_commands(reply);
    cmds.writes = parse_write_commands(reply);
    cmds.deletes = [];
  }

  var conflicts = find_conflicts(cmds);

  await apply_patches(cmds.patches, conflicts);
  await apply_writes(cmds.writes, conflicts);
  await apply_deletes(cmds.deletes, conflicts);

  await save_log(system, user_message, reply, tool_calls);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
