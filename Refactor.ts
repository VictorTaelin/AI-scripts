#!/usr/bin/env bun

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as process from 'process';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GenAI, resolveModelSpec, ResolvedModelSpec, ThinkingLevel, tokenCount } from './GenAI';

const execFileAsync = promisify(execFile);

type ContextMap = Map<string, string>;

interface WriteCommand {
  type: 'write';
  file: string;
  content: string;
}

interface BlockPatchCommand {
  type: 'patch';
  blockId: number;
  content: string;
}

interface DeleteCommand {
  type: 'delete';
  file: string;
}

type EditCommand = WriteCommand | BlockPatchCommand | DeleteCommand;

type LineEnding = '\n' | '\r\n';

interface BlockEntry {
  id: number;
  file: string;
  content: string;
}

interface FileBlockGroup {
  file: string;
  newline: LineEnding;
  blocks: BlockEntry[];
}

interface BlockState {
  files: FileBlockGroup[];
  blockMap: Map<number, BlockEntry>;
}

const COMPACTING_PROMPT_TEMPLATE = `You're a context compactor.

Consider the following files, split into labeled blocks:

{{FILES}}

(Each block is annotated with a leading '!id' marker, identifying it.)

Now, consider the following TASK:

{{TASK}}

Your goal is NOT to complete the TASK.

Your goal is to omit EVERY block that is IRRELEVANT to the TASK.

A block is RELEVANT when:
- It must be directly edited to complete the TASK.
- It declares types used on blocks that must be edited.
- It defines functions used on blocks that must be edited.
- It declares types or functions used on blocks
  ... that declare types of functions used on blocks
  ... that must be edited to complete the TASK
  (and so on, transitively).
- It contains helpful documentation about the domain.
- It contain similar functions that can serve as inspiration.
- It can help understanding the codebase's style or domain.

A block is IRRELEVANT when:
- It is unequivocally, completely unrelated to the TASK at hands.

To omit blocks, output an <omit> command listing their ids:

<omit>
12
100-103
</omit>

List one block id per line, or use START-END (end exclusive) to omit a range.
For example, "100-103" omits blocks 100, 101, and 102.`;

const EDITING_PROMPT_TEMPLATE = `You're a code editor.

You must complete a code editing TASK on the following files:

{{FILES}}

Note that the files were split into blocks (sequences of non-empty lines). Each
block is annotated with a leading '!id'. These markers are NOT part of the file;
they're identifiers designed to let you choose which parts of the file to patch.

The TASK you must perform is:

{{TASK}}

To replace a file, or to create a new file, output:

<write file=path-to-file>
complete file contents
</write>

To replace an existing block, output:

<patch id=BLOCK_ID>
new block contents
</patch>

To delete a file entirely, output:

<delete file=path-to-file/>

For example, given the file:

./hello-10.js:

!0
// prints hello 10 times

!1
function hello_10() {
  
!2
  for (var i = 0; i < 10; ++i) {
    console.log("hello " ++ i);

!3
  }

!4
}

And given the task:

> fix the error

You should output:

<patch id=2>
  for (var i = 0; i < 10; ++i) {
    console.log("hello " + i);
</patch>

You can delete a block by making it empty. For example:

<patch id=0></patch>

(This would delete the initial comment.)

You can split a block by including empty lines. For example:

<patch id=2>
  for (var i = 0; i < 10; ++i) {

    console.log("hello " + i);
</patch>

(This would split block 2 into two blocks.)

You can merge blocks by moving contents and deleting. For example:

<patch id=2>
  for (var i = 0; i < 10; ++i) {
    console.log("hello " + i);
  }
</patch>

<patch id=3>
</patch>

(This would merge blocks 2 and 3.)

Prefer <patch/> when:
- editing many parts of large files

Prefer <write/> when:
- creating a new file
- editing a small file
- patching would be longer than just rewriting

Always use <delete/> to clean up leftover files.

Now, output a series of commands to complete the TASK.
`;

const IMPORT_PATTERNS = [
  /^#\[(\.\/[^\]]+)\]$/,
  /^--\[(\.\/[^\]]+)\]$/,
  /^\/\/\[(\.\/[^\]]+)\]$/,
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

async function runGit(args: string[], root: string): Promise<void> {
  await execFileAsync('git', args, { cwd: root });
}

async function gitAddFile(relativePath: string, root: string, gitAvailable: boolean): Promise<void> {
  if (!gitAvailable) return;
  try {
    await runGit(['add', relativePath], root);
  } catch (err) {
    console.warn(`Failed to git add ${relativePath}:`, err);
  }
}

async function gitRemoveFile(relativePath: string, root: string, gitAvailable: boolean): Promise<boolean> {
  if (!gitAvailable) return false;
  try {
    await runGit(['rm', '-f', relativePath], root);
    return true;
  } catch (err) {
    console.warn(`Failed to git rm ${relativePath}:`, err);
    return false;
  }
}

function buildModelSpec(base: ResolvedModelSpec, thinking: ThinkingLevel): string {
  return `${base.vendor}:${base.model}:${thinking}`;
}

function detectLineEnding(text: string): LineEnding {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function toBlocks(text: string): string[] {
  const normalized = normalizeToLF(text);
  if (!normalized.trim()) {
    return [];
  }
  const lines = normalized.split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') {
    start++;
  }
  let end = lines.length - 1;
  while (end >= start && lines[end].trim() === '') {
    end--;
  }
  if (start > end) {
    return [];
  }
  const trimmed = lines.slice(start, end + 1);
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of trimmed) {
    if (line.trim() === '') {
      if (current.length > 0) {
        blocks.push(current.join('\n'));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current.join('\n'));
  }
  return blocks;
}

function canonicalizeBlocks(blocks: string[], newline: LineEnding): string {
  if (blocks.length === 0) {
    return '';
  }
  const joined = blocks.join('\n\n');
  return newline === '\r\n' ? joined.replace(/\n/g, '\r\n') : joined;
}

function canonicalizeFileText(text: string, preferredNewline?: LineEnding): string {
  const newline = preferredNewline ?? detectLineEnding(text);
  const normalized = normalizeToLF(text);
  const blocks = toBlocks(normalized);
  if (blocks.length === 0) {
    return '';
  }
  return canonicalizeBlocks(blocks, newline);
}

function buildBlockState(context: ContextMap): BlockState {
  let nextId = 0;
  const files: FileBlockGroup[] = [];
  const blockMap = new Map<number, BlockEntry>();
  for (const [file, contents] of context.entries()) {
    const newline = detectLineEnding(contents);
    const fileBlocks = toBlocks(contents);
    const group: FileBlockGroup = { file, newline, blocks: [] };
    for (const blockContent of fileBlocks) {
      const block: BlockEntry = { id: nextId++, file, content: blockContent };
      group.blocks.push(block);
      blockMap.set(block.id, block);
    }
    files.push(group);
  }
  return { files, blockMap };
}

function formatBlocks(state: BlockState, omit?: Set<number>): string {
  if (state.files.length === 0) {
    return '(no files loaded)';
  }
  const includeBlock = (block: BlockEntry) => !omit || !omit.has(block.id);
  const sections: string[] = [];
  for (const group of state.files) {
    const visibleBlocks = group.blocks.filter(includeBlock);
    if (omit && omit.size > 0 && visibleBlocks.length === 0) {
      continue;
    }
    const prefix = group.file.startsWith('./') ? group.file : `./${group.file}`;
    const lines: string[] = [`${prefix}:`];
    if (visibleBlocks.length > 0) {
      for (const block of visibleBlocks) {
        lines.push('');
        lines.push(`!${block.id}`);
        lines.push(block.content);
      }
    }
    sections.push(lines.join('\n'));
  }
  if (sections.length === 0) {
    return '';
  }
  return sections.join('\n\n');
}

function computeTokenBreakdown(state: BlockState, baseFile: string, omit?: Set<number>): { base: number; imports: number } {
  const includeBlock = (block: BlockEntry): boolean => !omit || !omit.has(block.id);
  let baseTokens = 0;
  let importTokens = 0;
  for (const group of state.files) {
    const blockTexts = group.blocks.filter(includeBlock).map(block => block.content);
    const text = blockTexts.length > 0 ? blockTexts.join('\n\n') : '';
    const tokens = text ? tokenCount(text) : 0;
    if (group.file === baseFile) {
      baseTokens += tokens;
    } else {
      importTokens += tokens;
    }
  }
  return { base: baseTokens, imports: importTokens };
}

function applyTemplate(template: string, filesSection: string, task: string): string {
  return template
    .replace(/{{FILES}}/g, filesSection)
    .replace(/{{TASK}}/g, task.split("\n").map(x => "> " + x).join("\n").trim());
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
  const historyDir = path.join(aiDir, 'refactor-history');
  await fs.mkdir(aiDir, { recursive: true });
  await fs.mkdir(historyDir, { recursive: true });
  return { aiDir, historyDir, timestamp: formatTimestamp(new Date()) };
}

async function writeSessionLog(
  ctx: SessionLogContext,
  suffix: 'full-prompt.txt' | 'mini-prompt.txt' | 'response.txt',
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
  for (const pattern of IMPORT_PATTERNS) {
    const match = line.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  const includeMatch = line.match(/^#include "([^"]+)"$/);
  if (includeMatch) {
    return includeMatch[1];
  }
  return null;
}


function getInstructionText(line: string): string | null {
  if (matchImportPath(line)) {
    return null;
  }
  const trimmedLeft = line.replace(/^\s+/, '');
  if (!trimmedLeft) {
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
    throw new Error('File must end with a comment block describing the task.');
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
    throw new Error('File must end with a comment block using //, --, or #.');
  }
  const prompt = trimBlankEdges(promptLines.reverse().join('\n'));
  if (!prompt) {
    throw new Error('Prompt section is empty. Add instructions using a trailing comment block.');
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

function addOmitValue(token: string, collector: Set<number>): void {
  const trimmed = token.trim();
  if (!trimmed) {
    return;
  }
  const rangeMatch = trimmed.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start < end
    ) {
      for (let id = start; id < end; id++) {
        collector.add(id);
      }
      return;
    }
  }
  const id = Number(trimmed);
  if (!Number.isNaN(id) && Number.isInteger(id)) {
    collector.add(id);
  }
}

function stripOmitComments(line: string): string {
  const hashIndex = line.indexOf('#');
  const slashIndex = line.indexOf('//');
  let end = line.length;
  if (hashIndex !== -1 && hashIndex < end) {
    end = hashIndex;
  }
  if (slashIndex !== -1 && slashIndex < end) {
    end = slashIndex;
  }
  return line.slice(0, end);
}

function parseOmitLine(line: string, collector: Set<number>): void {
  const withoutComments = stripOmitComments(line).trim();
  if (!withoutComments) {
    return;
  }
  const tokens = withoutComments.split(/[\s,]+/);
  for (const token of tokens) {
    addOmitValue(token, collector);
  }
}

function parseOmitCommands(response: string): Set<number> {
  const results = new Set<number>();
  const blockRegex = /<omit\b([^>]*)>([\s\S]*?)<\/omit>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(response)) !== null) {
    const body = match[2] || '';
    for (const line of body.split(/\r?\n/)) {
      parseOmitLine(line, results);
    }
  }

  const legacyRegex = /<omit\b([^>]*)\/>/gi;
  while ((match = legacyRegex.exec(response)) !== null) {
    const attrs = match[1] || '';
    const blockAttr = extractAttribute(attrs, 'id') ?? extractAttribute(attrs, 'block');
    if (!blockAttr) {
      continue;
    }
    addOmitValue(blockAttr, results);
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
      if (type === 'write') {
        const fileAttr = extractFileAttribute(attrs);
        if (!fileAttr) {
          console.warn('Skipping <write> command without a file attribute.');
          continue;
        }
        const normalizedFile = normalizeFileReference(fileAttr);
        commands.push({ type: 'write', file: normalizedFile, content: body });
      } else {
        const idAttr = extractAttribute(attrs, 'id') ?? extractAttribute(attrs, 'block');
        if (!idAttr) {
          console.warn('Skipping <patch> command without an id attribute.');
          continue;
        }
        const blockId = Number(idAttr.trim());
        if (Number.isNaN(blockId) || !Number.isInteger(blockId)) {
          console.warn(`Skipping <patch> command with invalid block id: ${idAttr}`);
          continue;
        }
        commands.push({ type: 'patch', blockId, content: body });
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

async function applyCommands(
  commands: EditCommand[],
  root: string,
  gitAvailable: boolean,
  blockState: BlockState,
): Promise<void> {
  const patchCommands = commands.filter((cmd): cmd is BlockPatchCommand => cmd.type === 'patch');
  if (patchCommands.length > 0) {
    await applyBlockPatches(patchCommands, blockState, root);
  }

  for (const command of commands) {
    if (command.type === 'write') {
      await applyWrite(command, root, gitAvailable);
    } else if (command.type === 'delete') {
      await applyDelete(command, root, gitAvailable);
    }
  }
}

async function applyWrite(command: WriteCommand, root: string, gitAvailable: boolean): Promise<void> {
  const target = path.resolve(root, command.file);
  ensureInSandbox(target, root);
  let existed = true;
  let preferredNewline: LineEnding | undefined;
  try {
    await fs.stat(target);
    const current = await fs.readFile(target, 'utf8');
    preferredNewline = detectLineEnding(current);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      existed = false;
    } else {
      throw err;
    }
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const canonical = canonicalizeFileText(command.content, preferredNewline);
  await fs.writeFile(target, canonical, 'utf8');
  if (!existed) {
    const relative = toPosix(path.relative(root, target));
    await gitAddFile(relative, root, gitAvailable);
  }
}

async function applyBlockPatches(commands: BlockPatchCommand[], state: BlockState, root: string): Promise<void> {
  const replacements = new Map<number, string[]>();
  for (const command of commands) {
    if (replacements.has(command.blockId)) {
      throw new Error(`Duplicate patch for block ${command.blockId}.`);
    }
    const block = state.blockMap.get(command.blockId);
    if (!block) {
      throw new Error(`Unknown block id ${command.blockId}.`);
    }
    const normalized = normalizeToLF(command.content);
    const replacementBlocks = toBlocks(normalized);
    replacements.set(command.blockId, replacementBlocks);
  }
  await saveBlocks(state, replacements, root);
}

async function saveBlocks(state: BlockState, replacements: Map<number, string[]>, root: string): Promise<void> {
  const filesToWrite = new Map<string, { newline: LineEnding; blocks: string[] }>();
  for (const group of state.files) {
    let mutated = false;
    const newBlocks: string[] = [];
    for (const block of group.blocks) {
      const replacement = replacements.get(block.id);
      if (replacement) {
        mutated = true;
        for (const blockContent of replacement) {
          newBlocks.push(blockContent);
        }
      } else {
        newBlocks.push(block.content);
      }
    }
    if (mutated) {
      filesToWrite.set(group.file, { newline: group.newline, blocks: newBlocks });
    }
  }

  for (const [relativePath, data] of filesToWrite.entries()) {
    const absolutePath = path.resolve(root, relativePath);
    ensureInSandbox(absolutePath, root);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const finalContent = canonicalizeBlocks(data.blocks, data.newline);
    await fs.writeFile(absolutePath, finalContent, 'utf8');
  }
}

async function applyDelete(command: DeleteCommand, root: string, gitAvailable: boolean): Promise<void> {
  const target = path.resolve(root, command.file);
  ensureInSandbox(target, root);
  let stats;
  try {
    stats = await fs.stat(target);
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err
      ? (err as { code?: string }).code
      : undefined;
    if (code === 'ENOENT') {
      if (gitAvailable) {
        const relative = toPosix(path.relative(root, target));
        await gitRemoveFile(relative, root, gitAvailable);
      }
      return;
    }
    throw err;
  }

  if (!stats.isFile()) {
    console.warn(`Skipping delete for ${command.file}: not a file.`);
    return;
  }

  const relative = toPosix(path.relative(root, target));
  const removedViaGit = await gitRemoveFile(relative, root, gitAvailable);
  if (!removedViaGit) {
    await fs.unlink(target);
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
    const normalizedText = trimBlankEdges(text);
    context.set(rel, normalizedText);
    const imports = findImports(normalizedText);
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
  const gitAvailable = await pathExists(path.join(workspaceRoot, '.git'));
  const logContext = await initSessionLogContext();

  const baseResolved = await realpathSafe(absoluteFile);
  ensureInSandbox(baseResolved, workspaceRoot);

  const modelSpec = modelArg || 'g';
  const resolvedModel = resolveModelSpec(modelSpec);
  const resolvedModelId = `${resolvedModel.vendor}:${resolvedModel.model}:${resolvedModel.thinking}`;
  console.log(`model: ${resolvedModelId}`);

  const raw = await fs.readFile(absoluteFile, 'utf8');
  let fileContents = '';
  let promptStr = '';
  let promptError: Error | null = null;
  try {
    const extraction = extractPromptSections(raw);
    fileContents = extraction.body;
    promptStr = extraction.prompt;
  } catch (err) {
    promptError = err instanceof Error ? err : new Error(String(err));
    fileContents = trimBlankEdges(raw);
  }

  const context = await collectContext(baseResolved, fileContents, workspaceRoot);
  const blockState = buildBlockState(context);
  const baseRel = toPosix(path.relative(workspaceRoot, baseResolved));
  const { base: baseTokenCount, imports: importTokens } = computeTokenBreakdown(blockState, baseRel);
  const baseLineTotal = baseTokenCount + importTokens;
  console.log(`count: ${baseTokenCount} + ${importTokens} = ${baseLineTotal} tokens`);

  if (promptError) {
    console.error(`Error: ${promptError.message}`);
    process.exit(1);
  }

  const prompt = promptStr;
  const fullContextBlock = formatBlocks(blockState);
  let omitBlocks = new Set<number>();
  let contextBlock = fullContextBlock;
  const totalTokens = tokenCount(`${fullContextBlock}\n\n${prompt}`);
  const hasImports = blockState.files.length > 1;
  const shouldCompact = hasImports && totalTokens >= 32000;
  let compactPrompt = '';
  let compactResponse = '';
  const hypotheticalEditingPrompt = applyTemplate(EDITING_PROMPT_TEMPLATE, fullContextBlock, prompt);
  await writeSessionLog(logContext, 'full-prompt.txt', hypotheticalEditingPrompt);

  if (shouldCompact) {
    console.log('\n**Calling compaction model...**\n');
    const compactorSpec = buildModelSpec(resolvedModel, 'low');
    compactPrompt = applyTemplate(COMPACTING_PROMPT_TEMPLATE, contextBlock, prompt);
    compactResponse = await askAI(compactorSpec, compactPrompt);

    omitBlocks = parseOmitCommands(compactResponse);
    contextBlock = formatBlocks(blockState, omitBlocks);
    const compactBreakdown = computeTokenBreakdown(blockState, baseRel, omitBlocks);
    const compactTotal = compactBreakdown.base + compactBreakdown.imports;
    const originalTotal = baseTokenCount + importTokens;
    const compactionPercent = originalTotal > 0
      ? Math.max(0, Math.min(100, Math.round((originalTotal - compactTotal) * 100 / originalTotal)))
      : 0;
    console.log(
      `count: ${compactBreakdown.base} + ${compactBreakdown.imports} = ${compactTotal} tokens (compaction: ${compactionPercent}%)`,
    );
  } else {
    const reasons: string[] = [];
    if (!hasImports) reasons.push('no imports detected');
    if (totalTokens < 32000) reasons.push('context under 32k tokens');
    const reasonText = reasons.join(' and ') || 'conditions not met';
    compactPrompt = `[compaction skipped: ${reasonText}]`;
    compactResponse = '[compaction skipped]';
  }

  const editingPrompt = applyTemplate(EDITING_PROMPT_TEMPLATE, contextBlock, prompt);
  await writeSessionLog(logContext, 'mini-prompt.txt', editingPrompt);
  console.log('\n**Calling coding model...**\n');
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

  await applyCommands(commands, workspaceRoot, gitAvailable, blockState);
}

main().catch(err => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
