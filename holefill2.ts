#!/usr/bin/env bun

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as process from 'process';
import { GenAI, resolveModelSpec, ResolvedModelSpec, ThinkingLevel, tokenCount } from './GenAI';

type ContextMap = Map<string, string>;

interface WriteCommand {
  type: 'write';
  file: string;
  content: string;
}

interface PatchOperation {
  search: string;
  replace: string;
}

interface PatchCommand {
  type: 'patch';
  file: string;
  operations: PatchOperation[];
}

type EditCommand = WriteCommand | PatchCommand;

const MARKERS = ['//!', '--!', '##!'];

const COMPACTING_PROMPT_TEMPLATE = `You're a context compactor.

Consider the following files:

{{FILES}}

And consider the following TASK:

{{TASK}}

Your goal is to omit EVERY file that is IRRELEVANT to the TASK.

A file is considered IRRELEVANT when reading its contents is neither needed, nor
helpful, to complete the TASK. Note that, even if a file is not directly related
to the task, it can still be useful, if it provides helpful context, or simply
helps the user better understand this project's style, organization and nuances.
As such, exclude only files that are unequivocably unrelated to the TASK.

To omit a file, you must use the following command:

<omit file=path_fo_file/>

Your response can include any number of <omit/> commands.`;

const EDITING_PROMPT_TEMPLATE = `You're a code editor.

You will perform a one-shot code editing task on the following files:

{{FILES}}

The task you must perform is:

{{TASK}}

To complete this task, you must use the commands below:

To edit or create a file in "whole mode":

<write file=path_to_file>
complete code here
</write>

To edit a file in "diff mode":

<patch file=path_to_file>
<<<<<<< SEARCH
some code here
=======
new code here
some code here
new code here
>>>>>>> REPLACE
</patch>

Your response can include any number of <write/> and <patch/> commands.`;

const COMMENT_IMPORT_PREFIXES = [
  { start: '--./', end: '--' },
  { start: '//./', end: '//' },
  { start: '##./', end: '##' },
];

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
  throw new Error(message);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function ensureInSandbox(absPath: string, root: string): void {
  const relative = path.relative(root, absPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`Path "${absPath}" is outside of the workspace (${root}).`);
  }
}

async function realpathSafe(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err
      ? (err as { code?: string }).code
      : undefined;
    if (code === 'ENOENT') {
      return path.resolve(p);
    }
    throw err;
  }
}

function buildModelSpec(base: ResolvedModelSpec, thinking: ThinkingLevel): string {
  return `${base.vendor}:${base.model}:${thinking}`;
}

function findMarker(content: string): { index: number; marker: string } | null {
  let bestIndex = Number.POSITIVE_INFINITY;
  let bestMarker: string | null = null;
  for (const marker of MARKERS) {
    const index = content.indexOf(marker);
    if (index !== -1 && index < bestIndex) {
      bestIndex = index;
      bestMarker = marker;
    }
  }
  return bestMarker ? { index: bestIndex, marker: bestMarker } : null;
}

function formatContext(context: ContextMap): string {
  if (context.size === 0) {
    return '(no files loaded)';
  }
  return Array.from(context.entries())
    .map(([file, contents]) => `${file}\n\`\`\`\n${contents}\n\`\`\``)
    .join('\n\n');
}

function applyTemplate(template: string, filesSection: string, task: string): string {
  return template
    .replace(/{{FILES}}/g, filesSection)
    .replace(/{{TASK}}/g, task.trim());
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
}

async function logHolefill2Session(
  compactPrompt: string,
  compactResponse: string,
  editingPrompt: string,
  editingResponse: string,
): Promise<void> {
  const aiDir = path.join(os.homedir(), '.ai');
  const historyDir = path.join(aiDir, 'holefill2_history');
  await fs.mkdir(aiDir, { recursive: true });
  await fs.mkdir(historyDir, { recursive: true });
  const timestamp = formatTimestamp(new Date());

  const entries: { suffix: string; content: string }[] = [
    { suffix: 'prompt.txt', content: editingPrompt },
    {
      suffix: 'compact.txt',
      content: [
        '=== COMPACTING PROMPT ===\n',
        compactPrompt,
        '\n\n=== COMPACTING RESPONSE ===\n',
        compactResponse,
        '\n',
      ].join(''),
    },
    { suffix: 'response.txt', content: editingResponse },
  ];

  for (const entry of entries) {
    const historyPath = path.join(historyDir, `${timestamp}-${entry.suffix}`);
    await fs.writeFile(historyPath, entry.content, 'utf8');
    const latestPath = path.join(aiDir, `holefill2-${entry.suffix}`);
    await fs.writeFile(latestPath, entry.content, 'utf8');
  }
}

function trimBlankEdges(text: string): string {
  const usesCRLF = text.includes('\r\n');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  const normalized = lines.join('\n');
  if (normalized.length === 0) {
    return '';
  }
  return usesCRLF ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function extractFileAttribute(attrs: string): string | null {
  const match = attrs.match(/file\s*=\s*("([^\"]+)"|'([^']+)'|([^\s>]+))/i);
  if (!match) {
    return null;
  }
  return match[2] ?? match[3] ?? match[4] ?? null;
}

function normalizeFileReference(reference: string): string {
  return reference.replace(/^\.\//, '').trim();
}

async function askAI(model: string, prompt: string): Promise<string> {
  const ai = await GenAI(model);
  const reply = await ai.ask(prompt, {});
  if (typeof reply === 'string') {
    return reply;
  }
  if (Array.isArray((reply as any).messages)) {
    return (reply as any).messages.map((m: any) => m.content).join('\n');
  }
  return String(reply);
}

function parseOmitCommands(response: string, root: string): Set<string> {
  const regex = /<omit\b([^>]*)\/>/gi;
  const results = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(response)) !== null) {
    const fileAttr = extractFileAttribute(match[1] || '');
    if (!fileAttr) {
      continue;
    }
    const resolved = path.resolve(root, normalizeFileReference(fileAttr));
    ensureInSandbox(resolved, root);
    const rel = toPosix(path.relative(root, resolved));
    results.add(rel);
  }
  return results;
}

function parseCommands(response: string): EditCommand[] {
  const commands: EditCommand[] = [];
  const regex = /<(write|patch)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(response)) !== null) {
    const type = match[1].toLowerCase() as 'write' | 'patch';
    const attrs = match[2] || '';
    const body = match[3] || '';
    const fileAttr = extractFileAttribute(attrs);
    if (!fileAttr) {
      console.warn(`Skipping <${type}> command without a file attribute.`);
      continue;
    }
    const normalizedFile = normalizeFileReference(fileAttr);
    if (type === 'write') {
      commands.push({ type: 'write', file: normalizedFile, content: body });
    } else {
      const operations = parsePatchOperations(body);
      commands.push({ type: 'patch', file: normalizedFile, operations });
    }
  }
  return commands;
}

function parsePatchOperations(body: string): PatchOperation[] {
  const normalized = body.replace(/\r\n/g, '\n');
  const pattern = /<<<<<<<\s*SEARCH\s*\n([\s\S]*?)\n=======\s*\n([\s\S]*?)\n>>>>>>>[ \t]*REPLACE/gi;
  const operations: PatchOperation[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    operations.push({ search: match[1], replace: match[2] });
  }
  if (operations.length === 0) {
    throw new Error('No valid <<<<<<< SEARCH blocks found inside <patch>.');
  }
  return operations;
}

async function applyCommands(commands: EditCommand[], root: string): Promise<void> {
  for (const command of commands) {
    if (command.type === 'write') {
      await applyWrite(command, root);
    } else {
      await applyPatch(command, root);
    }
  }
}

async function applyWrite(command: WriteCommand, root: string): Promise<void> {
  const target = path.resolve(root, command.file);
  ensureInSandbox(target, root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const trimmed = trimBlankEdges(command.content);
  await fs.writeFile(target, trimmed, 'utf8');
  console.log(`Wrote ${toPosix(path.relative(root, target))}`);
}

async function applyPatch(command: PatchCommand, root: string): Promise<void> {
  const target = path.resolve(root, command.file);
  ensureInSandbox(target, root);
  const raw = await fs.readFile(target, 'utf8');
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  let current = raw.replace(/\r\n/g, '\n');
  for (const op of command.operations) {
    const search = op.search.replace(/\r\n/g, '\n');
    if (search.length === 0) {
      throw new Error(`Empty SEARCH block encountered for patch on ${command.file}.`);
    }
    const replace = op.replace.replace(/\r\n/g, '\n');
    const idx = current.indexOf(search);
    if (idx === -1) {
      throw new Error(`Failed to apply patch: search block not found in ${command.file}.`);
    }
    current = current.slice(0, idx) + replace + current.slice(idx + search.length);
  }
  const finalContent = newline === '\r\n' ? current.replace(/\n/g, '\r\n') : current;
  await fs.writeFile(target, finalContent, 'utf8');
  console.log(`Patched ${toPosix(path.relative(root, target))}`);
}

function findImports(content: string): string[] {
  const imports = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let matched = false;
    for (const { start, end } of COMMENT_IMPORT_PREFIXES) {
      if (trimmed.startsWith(start) && trimmed.endsWith(end)) {
        const inner = trimmed.slice(start.length, trimmed.length - end.length).trim();
        if (inner) {
          imports.add(inner);
        }
        matched = true;
        break;
      }
    }
    if (matched) {
      continue;
    }
    const includeMatch = trimmed.match(/^#include\s+"([^\"]+)"/);
    if (includeMatch) {
      imports.add(includeMatch[1]);
    }
  }
  return Array.from(imports);
}

async function collectContext(
  entryFile: string,
  entryContent: string,
  root: string,
): Promise<ContextMap> {
  const context: ContextMap = new Map();
  const visited = new Set<string>();

  async function visit(filePath: string, contents: string | null): Promise<void> {
    const resolved = path.resolve(filePath);
    ensureInSandbox(resolved, root);
    if (visited.has(resolved)) {
      return;
    }
    visited.add(resolved);
    const text = contents ?? await fs.readFile(resolved, 'utf8');
    const rel = toPosix(path.relative(root, resolved));
    context.set(rel, text);
    const imports = findImports(text);
    for (const importPath of imports) {
      const absoluteImport = path.resolve(path.dirname(resolved), importPath);
      await visit(absoluteImport, null);
    }
  }

  await visit(entryFile, entryContent);
  return context;
}

async function main(): Promise<void> {
  const [, , fileArg, modelArg] = process.argv;
  if (!fileArg) {
    console.log('Usage: holefill2 <file> [model]');
    process.exit(1);
  }

  const workspaceRoot = await realpathSafe(process.cwd());
  const absoluteFile = path.resolve(workspaceRoot, fileArg);
  ensureInSandbox(absoluteFile, workspaceRoot);

  const raw = await fs.readFile(absoluteFile, 'utf8');
  const markerInfo = findMarker(raw);
  if (!markerInfo) {
    fail('No task marker found. Use one of //!, --!, or ##!');
  }

  const prompt = raw.slice(markerInfo.index + markerInfo.marker.length).trim();
  if (!prompt) {
    fail('Prompt section is empty. Add instructions after the marker.');
  }

  const fileContents = raw.slice(0, markerInfo.index);
  const baseResolved = await realpathSafe(absoluteFile);
  ensureInSandbox(baseResolved, workspaceRoot);

  const context = await collectContext(baseResolved, fileContents, workspaceRoot);
  const baseRel = toPosix(path.relative(workspaceRoot, baseResolved));

  const modelSpec = modelArg || 'g';
  const resolvedModel = resolveModelSpec(modelSpec);
  const resolvedModelId = `${resolvedModel.vendor}:${resolvedModel.model}:${resolvedModel.thinking}`;

  const baseTokenCount = tokenCount(fileContents);
  console.log(`model: ${resolvedModelId}`);
  console.log(`tokens: ${baseTokenCount}`);

  let contextBlock = formatContext(context);
  const totalTokens = tokenCount(`${contextBlock}\n\n${prompt}`);
  const hasImports = context.size > 1;
  const shouldCompact = hasImports && totalTokens >= 8000;
  let compactPrompt = '';
  let compactResponse = '';

  console.log(`Loaded ${context.size} context file(s).`);

  if (shouldCompact) {
    compactPrompt = applyTemplate(COMPACTING_PROMPT_TEMPLATE, contextBlock, prompt);
    console.log('Running compaction...');
    compactResponse = await askAI(buildModelSpec(resolvedModel, 'low'), compactPrompt);

    const omits = parseOmitCommands(compactResponse, workspaceRoot);
    for (const omit of omits) {
      if (omit === baseRel) {
        console.log(`Ignoring omit for primary file ${omit}.`);
        continue;
      }
      if (context.delete(omit)) {
        console.log(`Omitted ${omit}`);
      }
    }
    contextBlock = formatContext(context);
    console.log(`Compacted to ${context.size} file(s).`);
  } else {
    const reasons: string[] = [];
    if (!hasImports) reasons.push('no imports detected');
    if (totalTokens < 8000) reasons.push('context under 8k tokens');
    const reasonText = reasons.join(' and ') || 'conditions not met';
    console.log(`Skipping compaction (${reasonText}).`);
    compactPrompt = `[compaction skipped: ${reasonText}]`;
    compactResponse = '[compaction skipped]';
  }

  console.log('Requesting edits...');
  const editingPrompt = applyTemplate(EDITING_PROMPT_TEMPLATE, contextBlock, prompt);
  const editingResponse = await askAI(buildModelSpec(resolvedModel, 'high'), editingPrompt);

  try {
    await logHolefill2Session(compactPrompt, compactResponse, editingPrompt, editingResponse);
  } catch (err) {
    console.warn('Failed to record holefill2 session history:', err);
  }

  const commands = parseCommands(editingResponse);
  if (commands.length === 0) {
    console.log('No <write/> or <patch/> commands found in the AI response.');
    return;
  }

  await applyCommands(commands, workspaceRoot);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
