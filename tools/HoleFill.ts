#!/usr/bin/env bun

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as process from 'process';
import { AskAI, resolveModelSpec, tokenCount, AskOptions } from '../askai/AskAI';

/* ==================================================================
 * HoleFill has two modes:
 *
 *   1. FILL mode  (".?." marker): the AI fills a single hole.
 *   2. EDIT mode  (".!." marker): the AI makes MANY edits to the file,
 *      following instructions written inside the file itself.
 *
 * EDIT mode uses the same edit strategy as the `pi` coding agent:
 * a list of exact search/replace operations, all matched against the
 * ORIGINAL file, then applied in an order-resistant manner (matched
 * up-front, sorted by position, applied in reverse).
 * ================================================================== */

const FILL = '{:FILL_HERE:}';

const SYSTEM_FILL = [
  "You fill exactly one placeholder inside a user-provided file.",
  "",
  "Rules:",
  `- The user sends the complete file text containing a single ${FILL} marker.`,
  `- Inspect the surrounding text to understand the context (code, prose, question, etc.) and produce content that fits seamlessly.`,
  "- Preserve indentation, spacing, and style so the replacement feels native to the file.",
  "- Unless the user explicitly asks you to rewrite the entire file, output only the text that should replace the placeholder.",
  "- When asked to rewrite the entire file, emit the full file contents while keeping everything else identical apart from the requested changes.",
  "- Wrap the replacement in a single <COMPLETION>...</COMPLETION> block with no commentary before or after the tags.",
  "- The text inside <COMPLETION> should be exactly what replaces the placeholder (no fences, no marker tokens).",
  `- Never include ${FILL} in your response and never output more than one <COMPLETION> block.`,
].join('\n');

const SYSTEM_EDIT = [
  "You make edits to a user-provided file.",
  "",
  "Rules:",
  "- Apply the requested changes by emitting a series of edit operations.",
  "- Each edit is an exact search/replace. Format every edit EXACTLY like this:",
  "",
  "<EDIT>",
  "<FIND>",
  "exact text copied verbatim from the file",
  "</FIND>",
  "<REPLACE>",
  "the replacement text",
  "</REPLACE>",
  "</EDIT>",
  "",
  "- The text inside <FIND> must match the file EXACTLY, including all whitespace and indentation.",
  "- The <FIND> text must be UNIQUE in the file. Include just enough surrounding context to make it unique. Do not pad it with large unchanged regions.",
  "- Edits must target disjoint, NON-OVERLAPPING regions. If two changes are adjacent or touch the same lines, merge them into a single edit.",
  "- To INSERT new text, pick a unique existing anchor as <FIND> and repeat it in <REPLACE> together with your new text.",
  "- Output ONLY <EDIT> blocks. No commentary before, between, or after them.",
].join('\n');

/* ------------------------------------------------------------------
 * Utility: force every ".?." placeholder to column-0 (FILL mode)
 * ------------------------------------------------------------------ */
function leftAlignHoles(code: string): string {
  return code.replace(/^([ \t]+)(\.\?\.)/gm, '$2');
}

/* ==================================================================
 * Edit engine (mirrors pi's edit tool)
 * ================================================================== */

interface Edit { oldText: string; newText: string; }

function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

interface MatchResult { found: boolean; index: number; matchLength: number; usedFuzzyMatch: boolean; }

function fuzzyFindText(content: string, oldText: string): MatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  }
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

function countOccurrences(content: string, oldText: string): number {
  return normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1;
}

/* Apply all edits against the ORIGINAL content, order-resistant.
 * Returns the new content. Skips edits that fail to match (logging them). */
function applyEdits(content: string, edits: Edit[]): { result: string; applied: number; skipped: string[] } {
  const skipped: string[] = [];
  const fuzzyNeeded = edits.some((e) => fuzzyFindText(content, e.oldText).usedFuzzyMatch);
  const base = fuzzyNeeded ? normalizeForFuzzyMatch(content) : content;

  const matched: { index: number; length: number; newText: string }[] = [];
  edits.forEach((edit, i) => {
    if (edit.oldText.length === 0) { skipped.push(`edits[${i}]: empty FIND`); return; }
    const m = fuzzyFindText(base, edit.oldText);
    if (!m.found) { skipped.push(`edits[${i}]: FIND not found`); return; }
    const occ = countOccurrences(base, edit.oldText);
    if (occ > 1) { skipped.push(`edits[${i}]: FIND not unique (${occ} occurrences)`); return; }
    matched.push({ index: m.index, length: m.matchLength, newText: edit.newText });
  });

  matched.sort((a, b) => a.index - b.index);
  /* drop overlaps (keep the earlier one) */
  const safe: typeof matched = [];
  for (const cur of matched) {
    const prev = safe[safe.length - 1];
    if (prev && prev.index + prev.length > cur.index) {
      skipped.push(`overlap at index ${cur.index} (skipped)`);
      continue;
    }
    safe.push(cur);
  }

  let result = base;
  for (let i = safe.length - 1; i >= 0; i--) {
    const e = safe[i];
    result = result.substring(0, e.index) + e.newText + result.substring(e.index + e.length);
  }
  return { result, applied: safe.length, skipped };
}

/* Parse <EDIT><FIND>..</FIND><REPLACE>..</REPLACE></EDIT> blocks from a reply.
 * Strips exactly one leading/trailing newline inside each section. */
function parseEdits(reply: string): Edit[] {
  const edits: Edit[] = [];
  const blockRe = /<EDIT>([\s\S]*?)<\/EDIT>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(reply)) !== null) {
    const body = m[1];
    const find = /<FIND>\n?([\s\S]*?)\n?<\/FIND>/.exec(body);
    const repl = /<REPLACE>\n?([\s\S]*?)\n?<\/REPLACE>/.exec(body);
    if (find && repl) {
      edits.push({ oldText: find[1], newText: repl[1] });
    }
  }
  return edits;
}

/* Find the ".!." marker, extract the comment block immediately above it
 * (consecutive comment lines up to the first non-comment line), strip the
 * comment markers, and remove that block + the marker from the code.
 * Returns null when there is no comment block before the marker. */
function extractInstruction(code: string): { instruction: string; code: string } | null {
  const lines = code.split('\n');
  const markerIdx = lines.findIndex((l) => l.includes('.!.'));
  if (markerIdx === -1) return null;

  const isComment = (line: string): boolean => {
    const t = line.trim();
    if (t === '') return false;
    return /^(\/\/|#|--|\/\*|\*)/.test(t) || /\*\/$/.test(t);
  };

  const stripMarkers = (line: string): string =>
    line.trim()
      .replace(/^\/\//, '')   // //
      .replace(/^--/, '')     // --
      .replace(/^#/, '')      // #
      .replace(/^\/\*/, '')   // /*
      .replace(/\*\/$/, '')   // */
      .replace(/^\*/, '')     // * (block-comment continuation)
      .trim();

  /* skip blank lines, then collect consecutive comment lines upward */
  let start = markerIdx - 1;
  while (start >= 0 && lines[start].trim() === '') start--;
  const block: string[] = [];
  while (start >= 0 && isComment(lines[start])) {
    block.unshift(stripMarkers(lines[start]));
    start--;
  }
  if (block.length === 0) return null;

  /* drop the comment block, any blanks, and the marker line */
  const cleaned = [...lines.slice(0, start + 1), ...lines.slice(markerIdx + 1)].join('\n');
  return { instruction: block.join('\n'), code: cleaned };
}

/* ==================================================================
 * Shared helpers
 * ================================================================== */

async function expandImports(code: string, baseFile: string): Promise<string> {
  const expanded: string[] = [];
  for (const line of code.split('\n')) {
    const m1 = line.match(/^\/\/\.\/(.*?)\/\/$/);
    const m2 = line.match(/^{-\.\/(.*?)-\}$/);
    const m3 = line.match(/^#\.\/(.*?)#$/);
    const m  = m1 || m2 || m3;
    if (m) {
      const p = path.resolve(path.dirname(baseFile), m[1]);
      try { expanded.push(await fs.readFile(p, 'utf-8')); }
      catch { console.log('import_file:', line, 'ERROR'); process.exit(1); }
    } else {
      expanded.push(line);
    }
  }
  return expanded.join('\n');
}

async function logRun(modelDescriptor: string, system: string, prompt: string, reply: string): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = path.join(os.homedir(), '.ai', 'prompt_history');
  await fs.mkdir(logDir, { recursive: true });
  const safeModelLabel = modelDescriptor.replace(/[:/]/g, '_');
  await fs.writeFile(path.join(logDir, `${ts}_${safeModelLabel}.log`),
                     `SYSTEM:\n${system}\n\nPROMPT:\n${prompt}\n\nREPLY:\n${reply}\n\n`, 'utf-8');
}

/* ==================================================================
 * Main
 * ================================================================== */

async function main(): Promise<void> {
  const file  = process.argv[2];
  const mini  = process.argv[3];
  const model = process.argv[4] || 'gpt-4o-mini';
  const resolvedModel = resolveModelSpec(model);
  const modelDescriptor = `${resolvedModel.vendor}:${resolvedModel.model}:${resolvedModel.thinking}${resolvedModel.fast ? ':fast' : ''}`;

  if (!file) {
    console.log('Usage: holefill <file> [<shortened_file>] [<model_name>]');
    console.log('\nFILL mode: write ".?." in <file> to complete a single hole.');
    console.log('EDIT mode: write ".!." in <file> to make many edits, following');
    console.log('           instructions written inside the file itself.');
    process.exit(1);
  }

  const ai = await AskAI(model);

  /* read user files */
  let file_code = await fs.readFile(file, 'utf-8');
  let mini_code = mini ? await fs.readFile(mini, 'utf-8') : file_code;

  /* expand inline import markers in mini_code */
  mini_code = await expandImports(mini_code, file);

  const editMode = file_code.includes('.!.');

  if (editMode) {
    /* ---------------------------------------------------------- *
     *  EDIT mode: extract the instruction comment block before the
     *  ".!." marker, move it to AFTER the file, send the whole file,
     *  parse many edits, apply them order-resistant to file_code.
     * ---------------------------------------------------------- */
    const ext = extractInstruction(file_code);
    if (!ext) { console.log('No instruction comment block found before .!.'); process.exit(1); }
    file_code = ext.code;
    const instruction = ext.instruction;

    /* the prompt uses the (possibly shortened) mini_code, also with its
     * instruction block removed; fall back to mini_code untouched. */
    const miniExt = extractInstruction(mini_code);
    const promptCode = miniExt ? miniExt.code : mini_code;

    const prompt = `<FILE>\n${promptCode}\n</FILE>\n\n${instruction}`;
    const tokens = tokenCount(prompt);

    await fs.mkdir(path.join(os.homedir(), '.ai'), { recursive: true });
    await fs.writeFile(path.join(os.homedir(), '.ai', '.holefill'),
                       `${SYSTEM_EDIT}\n###\n${prompt}`, 'utf-8');

    console.log('token_count:', tokens);
    console.log('model_label:', modelDescriptor);

    const replyRaw = await ai.ask(prompt, { system: SYSTEM_EDIT } as AskOptions);
    const replyStr = typeof replyRaw === 'string'
                     ? replyRaw
                     : replyRaw.messages.map((m: any) => m.content).join('\n');

    const edits = parseEdits(replyStr);
    if (edits.length === 0) { console.log('No edits found in reply.'); process.exit(1); }

    const { result, applied, skipped } = applyEdits(file_code, edits);
    await fs.writeFile(file, result, 'utf-8');

    console.log('edits_parsed:', edits.length);
    console.log('edits_applied:', applied);
    if (skipped.length) { for (const s of skipped) console.log('skipped:', s); }
    console.log('output_file:', file);

    await logRun(modelDescriptor, SYSTEM_EDIT, prompt, replyStr);
    return;
  }

  /* ------------------------------------------------------------ *
   *  FILL mode (legacy single-hole behaviour)
   * ------------------------------------------------------------ */
  file_code = leftAlignHoles(file_code);
  mini_code = leftAlignHoles(mini_code);

  if (mini) {
    const miniPath = path.join(os.tmpdir(), `holefill-${process.pid}-${path.basename(mini)}`);
    await fs.writeFile(miniPath, mini_code, 'utf-8');
  }

  const tokens = tokenCount(mini_code);
  const prompt = mini_code.replace('.?.', FILL);

  await fs.mkdir(path.join(os.homedir(), '.ai'), { recursive: true });
  await fs.writeFile(path.join(os.homedir(), '.ai', '.holefill'),
                     `${SYSTEM_FILL}\n###\n${prompt}`, 'utf-8');

  console.log('token_count:', tokens);
  console.log('model_label:', modelDescriptor);

  if (!mini_code.includes('.?.')) { console.log('No hole found.'); process.exit(1); }

  const replyRaw = await ai.ask(prompt, { system: SYSTEM_FILL } as AskOptions);
  const replyStr = typeof replyRaw === 'string'
                   ? replyRaw
                   : replyRaw.messages.map((m: any) => m.content).join('\n');

  let raw: string;
  const full = /<COMPLETION>([\s\S]*?)<\/COMPLETION>/.exec(replyStr);
  if (full) {
    raw = full[1];
  } else {
    const openIdx = replyStr.indexOf('<COMPLETION>');
    if (openIdx !== -1) {
      raw = replyStr.slice(openIdx + '<COMPLETION>'.length);
      raw = raw.replace(/<\/?COMPLETION>?\s*$/, '');
    } else {
      raw = replyStr;
    }
  }
  const wrapped = `<COMPLETION>${raw}</COMPLETION>`;

  const fill = raw.replace(/\$/g, '$$$$').replace(/^\n+|\n+$/g, '');
  file_code  = file_code.replace('.?.', fill);

  await fs.writeFile(file, file_code, 'utf-8');
  console.log('output_file:', file);

  await logRun(modelDescriptor, SYSTEM_FILL, prompt, wrapped);
}

main().catch(console.error);
