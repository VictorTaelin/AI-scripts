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

interface DeleteCommand {
  type: 'delete';
  file: string;
}

type EditCommand = WriteCommand | PatchCommand | DeleteCommand;

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

To omit files located under a directory, issue the command:

<omit path="./some/dir">
file_a.ext
file_b.ext
</omit>

List each file name on its own line inside the block. You can include multiple <omit/> commands.`;

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

To delete a file entirely:

<delete file=path_to_file/>

Your response can include any number of <write/>, <patch/>, and <delete/> commands.

Prefer <patch/> when:
- editing small parts of large files
- the edits can be done unambiguously

Prefer <write/> when:
- creating a new file
- the edited file is small
- patching would be error-prone

Always use <delete/> to clean up (ex: when you "rename" a file by writing a new
one, when you combine files, etc.).
`;

const IMPORT_PREFIXES = ['#[./', '--[./', '//[./'];

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

function formatContextEntries(entries: [string, string][]): string {
  if (entries.length === 0) {
    return '';
  }
  return entries
    .map(([file, contents]) => `${file}\n\`\`\`\n${contents}\n\`\`\``)
    .join('\n\n');
}

function formatContextSubset(context: ContextMap, predicate: (file: string) => boolean): string {
  const entries = Array.from(context.entries()).filter(([file]) => predicate(file));
  return formatContextEntries(entries);
}

function formatContext(context: ContextMap): string {
  return formatContextSubset(context, () => true) || '(no files loaded)';
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

interface SessionLogContext {
  aiDir: string;
  historyDir: string;
  timestamp: string;
}

async function initSessionLogContext(): Promise<SessionLogContext> {
  const aiDir = path.join(os.homedir(), '.ai');
  const historyDir = path.join(aiDir, 'refactor_history');
  await fs.mkdir(aiDir, { recursive: true });
  await fs.mkdir(historyDir, { recursive: true });
  return { aiDir, historyDir, timestamp: formatTimestamp(new Date()) };
}

async function writeSessionLog(
  ctx: SessionLogContext,
  suffix: 'full_prompt.txt' | 'mini_prompt.txt' | 'response.txt',
  content: string,
): Promise<void> {
  try {
    const historyPath = path.join(ctx.historyDir, `${ctx.timestamp}-${suffix}`);
    await fs.writeFile(historyPath, content, 'utf8');
    const latestPath = path.join(ctx.aiDir, `refactor-${suffix}`);
    await fs.writeFile(latestPath, content, 'utf8');
  } catch (err) {
    console.warn(`Failed to write refactor ${suffix}:`, err);
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

function matchImportPath(line: string): string | null {
  const trimmed = line.trim();
  for (const prefix of IMPORT_PREFIXES) {
    if (trimmed.startsWith(prefix) && trimmed.endsWith(']')) {
      const inner = trimmed.slice(prefix.length, trimmed.length - 1).trim();
      if (inner) {
        return inner;
      }
    }
  }
  const includeMatch = trimmed.match(/^#include\s+(?:"([^"]+)"|'([^']+)')/);
  if (includeMatch) {
    return includeMatch[1] || includeMatch[2] || null;
  }
  return null;
}

function getInstructionText(line: string): string | null {
  const trimmedLeft = line.replace(/^\s+/, '');
  if (!trimmedLeft) {
    return null;
  }
  if (matchImportPath(trimmedLeft)) {
    return null;
  }
  if (trimmedLeft.startsWith('//')) {
    return trimmedLeft.slice(2).replace(/^\s+/, '');
  }
  if (trimmedLeft.startsWith('--')) {
    return trimmedLeft.slice(2).replace(/^\s+/, '');
  }
  if (trimmedLeft.startsWith('#')) {
    return trimmedLeft.slice(1).replace(/^\s+/, '');
  }
  return null;
}

function extractPromptSections(raw: string): { body: string; prompt: string } {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let idx = lines.length - 1;
  while (idx >= 0 && lines[idx].trim() === '') {
    idx--;
  }
  if (idx < 0) {
    fail('File must end with a comment block describing the task.');
  }
  const promptLines: string[] = [];
  while (idx >= 0) {
    const line = lines[idx];
    const instruction = getInstructionText(line);
    if (instruction === null) {
      break;
    }
    promptLines.push(instruction);
    idx--;
  }
  if (promptLines.length === 0) {
    fail('File must end with a comment block using //, --, or #.');
  }
  const prompt = trimBlankEdges(promptLines.reverse().join('\n'));
  if (!prompt) {
    fail('Prompt section is empty. Add instructions using a trailing comment block.');
  }
  const bodyLines = lines.slice(0, idx + 1);
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
    bodyLines.pop();
  }
  const bodyNormalized = bodyLines.join('\n');
  const body = newline === '\r\n' ? bodyNormalized.replace(/\n/g, '\r\n') : bodyNormalized;
  return { body, prompt };
}

function extractAttribute(attrs: string, name: string): string | null {
  const regex = new RegExp(`${name}\\s*=\\s*("([^\\"]+)"|'([^']+)'|([^\\s>]+))`, 'i');
  const match = attrs.match(regex);
  if (!match) {
    return null;
  }
  return match[2] ?? match[3] ?? match[4] ?? null;
}

function extractFileAttribute(attrs: string): string | null {
  return extractAttribute(attrs, 'file');
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
  const results = new Set<string>();
  const blockRegex = /<omit\b([^>]*)>([\s\S]*?)<\/omit>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(response)) !== null) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    const dirAttr = extractAttribute(attrs, 'path') ?? extractAttribute(attrs, 'dir');
    if (!dirAttr) {
      continue;
    }
    const dirNormalized = normalizeFileReference(dirAttr);
    const dirAbsolute = path.resolve(root, dirNormalized);
    ensureInSandbox(dirAbsolute, root);
    for (const line of body.split(/\r?\n/)) {
      const fileName = line.trim();
      if (!fileName) {
        continue;
      }
      const target = path.resolve(dirAbsolute, fileName);
      ensureInSandbox(target, root);
      const rel = toPosix(path.relative(root, target));
      results.add(rel);
    }
  }

  const legacyRegex = /<omit\b([^>]*)\/>/gi;
  while ((match = legacyRegex.exec(response)) !== null) {
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
  const regex = /<(write|patch)\b([^>]*)>([\s\S]*?)<\/\1>|<delete\b([^>]*)(?:\/|>([\s\S]*?)<\/delete>)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(response)) !== null) {
    if (match[1]) {
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
    } else {
      const attrs = match[4] || '';
      const fileAttr = extractFileAttribute(attrs);
      if (!fileAttr) {
        console.warn('Skipping <delete> command without a file attribute.');
        continue;
      }
      const normalizedFile = normalizeFileReference(fileAttr);
      commands.push({ type: 'delete', file: normalizedFile });
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
    } else if (command.type === 'patch') {
      await applyPatch(command, root);
    } else if (command.type === 'delete') {
      await applyDelete(command, root);
    }
  }
}

async function applyWrite(command: WriteCommand, root: string): Promise<void> {
  const target = path.resolve(root, command.file);
  ensureInSandbox(target, root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const trimmed = trimBlankEdges(command.content);
  await fs.writeFile(target, trimmed, 'utf8');
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
}

async function applyDelete(command: DeleteCommand, root: string): Promise<void> {
  const target = path.resolve(root, command.file);
  ensureInSandbox(target, root);
  try {
    const stats = await fs.stat(target);
    if (!stats.isFile()) {
      console.warn(`Skipping delete for ${command.file}: not a file.`);
      return;
    }
    await fs.unlink(target);
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err
      ? (err as { code?: string }).code
      : undefined;
    if (code === 'ENOENT') {
      return;
    }
    throw err;
  }
}

function findImports(content: string): string[] {
  const imports = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = matchImportPath(line);
    if (match) {
      imports.add(match);
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

  async function visit(filePath: string, contents: string | null, importer?: string): Promise<void> {
    const resolved = path.resolve(filePath);
    ensureInSandbox(resolved, root);
    if (visited.has(resolved)) {
      return;
    }
    let text: string;
    if (contents !== null) {
      text = contents;
    } else {
      try {
        text = await fs.readFile(resolved, 'utf8');
      } catch (err) {
        const code = typeof err === 'object' && err && 'code' in err
          ? (err as { code?: string }).code
          : undefined;
        if (code === 'ENOENT') {
          const relMissing = toPosix(path.relative(root, resolved));
          const suffix = importer ? ` (imported from ${importer})` : '';
          console.warn(`WARNING: missing import ${relMissing}${suffix}`);
          return;
        }
        throw err;
      }
    }
    visited.add(resolved);
    const rel = toPosix(path.relative(root, resolved));
    context.set(rel, text);
    const imports = findImports(text);
    for (const importPath of imports) {
      const absoluteImport = path.resolve(path.dirname(resolved), importPath);
      await visit(absoluteImport, null, rel);
    }
  }

  await visit(entryFile, entryContent);
  return context;
}

async function main(): Promise<void> {
  const [, , fileArg, modelArg] = process.argv;
  if (!fileArg) {
    console.log('Usage: refactor <file> [model]');
    process.exit(1);
  }

  const workspaceRoot = await realpathSafe(process.cwd());
  const absoluteFile = path.resolve(workspaceRoot, fileArg);
  ensureInSandbox(absoluteFile, workspaceRoot);
  const logContext = await initSessionLogContext();

  const baseResolved = await realpathSafe(absoluteFile);
  ensureInSandbox(baseResolved, workspaceRoot);

  const modelSpec = modelArg || 'g';
  const resolvedModel = resolveModelSpec(modelSpec);
  const resolvedModelId = `${resolvedModel.vendor}:${resolvedModel.model}:${resolvedModel.thinking}`;
  console.log(`model: ${resolvedModelId}`);

  const raw = await fs.readFile(absoluteFile, 'utf8');
  let fileContents = '';
  let prompt = '';
  let baseTokenCount = 0;
  try {
    const extracted = extractPromptSections(raw);
    fileContents = extracted.body;
    prompt = extracted.prompt;
    baseTokenCount = tokenCount(fileContents);
  } catch (err) {
    const fallbackTokens = tokenCount(trimBlankEdges(raw));
    console.log(`token: ${fallbackTokens} + 0 = ${fallbackTokens}`);
    throw err;
  }
  const context = await collectContext(baseResolved, fileContents, workspaceRoot);
  const baseRel = toPosix(path.relative(workspaceRoot, baseResolved));

  let contextBlock = formatContext(context);
  const fullContextBlock = contextBlock;
  const importsBlock = formatContextSubset(context, file => file !== baseRel);
  const importTokens = importsBlock ? tokenCount(importsBlock) : 0;
  console.log(`token: ${baseTokenCount} + ${importTokens} = ${baseTokenCount + importTokens}`);
  const totalTokens = tokenCount(`${fullContextBlock}\n\n${prompt}`);
  const hasImports = context.size > 1;
  const shouldCompact = hasImports && totalTokens >= 8000;
  let compactPrompt = '';
  let compactResponse = '';
  const hypotheticalEditingPrompt = applyTemplate(EDITING_PROMPT_TEMPLATE, fullContextBlock, prompt);
  await writeSessionLog(logContext, 'full_prompt.txt', hypotheticalEditingPrompt);

  if (shouldCompact) {
    const compactorSpec = buildModelSpec(resolvedModel, 'low');
    compactPrompt = applyTemplate(COMPACTING_PROMPT_TEMPLATE, contextBlock, prompt);
    compactResponse = await askAI(compactorSpec, compactPrompt);

    const omits = parseOmitCommands(compactResponse, workspaceRoot);
    for (const omit of omits) {
      if (omit === baseRel) {
        continue;
      }
      context.delete(omit);
    }
    contextBlock = formatContext(context);
    const compactTokens = tokenCount(`${contextBlock}\n\n${prompt}`);
    console.log(`token: ${compactTokens} (compacted)`);
  } else {
    const reasons: string[] = [];
    if (!hasImports) reasons.push('no imports detected');
    if (totalTokens < 8000) reasons.push('context under 8k tokens');
    const reasonText = reasons.join(' and ') || 'conditions not met';
    compactPrompt = `[compaction skipped: ${reasonText}]`;
    compactResponse = '[compaction skipped]';
  }

  const editingPrompt = applyTemplate(EDITING_PROMPT_TEMPLATE, contextBlock, prompt);
  await writeSessionLog(logContext, 'mini_prompt.txt', editingPrompt);
  const editorSpec = buildModelSpec(resolvedModel, resolvedModel.thinking);
  const editingResponse = await askAI(editorSpec, editingPrompt);
  const responseLog = [
    '=== COMPACTOR PROMPT ===',
    compactPrompt,
    '',
    '=== COMPACTOR RESPONSE ===',
    compactResponse,
    '',
    '=== EDITOR RESPONSE ===',
    editingResponse,
    '',
  ].join('\n');
  await writeSessionLog(logContext, 'response.txt', responseLog);

  const commands = parseCommands(editingResponse);
  if (commands.length === 0) {
    return;
  }

  await applyCommands(commands, workspaceRoot);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
