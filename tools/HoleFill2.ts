#!/usr/bin/env bun

// HoleFill2 fills or edits a file from a prompt written inside the file
// itself. The file (with its imports recursively inlined) is normalized into
// BLOCKS -- maximal runs of non-blank lines -- and rendered with a BLOCKn
// label above each one. The block whose last line is a marker is the user's
// prompt; its comment text is cut out and appended after the file, and the
// marked spot is shown by an EXCERPT between the file and the comment: the
// few file lines around the spot, re-quoted with a placeholder line
// ({:FILL_HERE:} or {:REQUEST_HERE:}) at it. The rendered file itself never
// contains the placeholder, so it is byte-stable across runs no matter where
// the hole sits, and vendor prompt caches hit up to the first line that
// actually changed since the previous run (see the cache_cuts scheme in
// askai/Vendors/Anthropic.ts; the cuts sent are the hole's offset, the
// divergence from the previous run's prompt, and the file|prompt seam).
//
//   .?.  fill: the AI replies <COMPLETION>...</COMPLETION>, which replaces
//        the marker line only; the comment lines above it stay in the file,
//        with the content right below them.
//   .!.  edit: the AI replies <SPLICE from=A to=B>...</SPLICE> commands,
//        each replacing blocks A..B (inclusive) with its content. The
//        request block is consumed: it is an executed instruction.
//
// Marker decorations, in any order: `^N` omits every block after the prompt
// except the next N (bare `^` means N=0); `-` enables filter mode, where a
// first no-thinking pass of the same model selects the relevant blocks and
// the rest are elided to "..." before the real call.
//
// Import lines (`//./x//`, `{-./x-}`, `#./x#`) are inlined into the one
// block space, deduplicated by absolute path. Imported blocks are read-only:
// splices may not target them, and on write-back the import line itself is
// preserved, never its expansion.
//
// Every run logs to ~/.ai/holefill2_history (prompt before the call, so a
// cancelled run still leaves a trace) and mirrors the outgoing prompt to
// ~/.ai/.holefill2. Without a marker, it prints the token count and stops.

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as process from "process";
import * as askai from "../askai/AskAI";

// Types
// =====

type Line = string;

type Part =
  | { $: "Own" }               // a run of the user's own lines
  | { $: "Imp"; line: Line };  // an import line, expanded into blocks

type Blk = {
  lines: Line[];
  part: number;
};

type Doc = {
  parts: Part[];
  blks: Blk[];
};

type Marker = {
  mode: "fill" | "edit";
  after: number | null;  // ^N: blocks kept after the prompt; null = no ^
  filter: boolean;       // -: two-pass block filtering
};

type Prompt = {
  marker: Marker;
  text: string;    // the comment, prefixes stripped, for the NOTE
  lines: Line[];   // the comment lines verbatim, restored on fill write-back
  pos: number;     // block index where the prompt block sat (post-removal)
  part: number;
};

type Splice = {
  from: number;
  to: number;
  blks: Line[][];
};

// Constructors
// ============

function Own(): Part {
  return { $: "Own" };
}

function Imp(line: Line): Part {
  return { $: "Imp", line };
}

// Text
// ====

function text_blocks(text: string): Line[][] {
  const blocks: Line[][] = [];
  let cur: Line[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      if (cur.length > 0) {
        blocks.push(cur);
        cur = [];
      }
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) {
    blocks.push(cur);
  }
  return blocks;
}

// Line
// ====

function line_import(line: Line): string | null {
  const t = line.trim();
  const m = t.match(/^\/\/(\.\.?\/.+?)\/\/$/)
         ?? t.match(/^\{-(\.\.?\/.+?)-\}$/)
         ?? t.match(/^#(\.\.?\/.+?)#$/);
  if (m === null) {
    return null;
  }
  return m[1];
}

function line_marker(line: Line): Marker | null {
  const m = line.trim().match(/^\.([?!])\.((?:\^\d*|-)*)$/);
  if (m === null) {
    return null;
  }
  const mode = m[1] === "?" ? "fill" as const : "edit" as const;
  let after: number | null = null;
  let filter = false;
  const ext = m[2];
  let i = 0;
  while (i < ext.length) {
    if (ext[i] === "-") {
      filter = true;
      i = i + 1;
    } else {
      let j = i + 1;
      while (j < ext.length && ext[j] >= "0" && ext[j] <= "9") {
        j = j + 1;
      }
      after = j === i + 1 ? 0 : parseInt(ext.slice(i + 1, j), 10);
      i = j;
    }
  }
  return { mode, after, filter };
}

function line_comment(line: Line): Line {
  return line.trim().replace(/^(\/\/|--|#)\s?/, "").trim();
}

// Doc
// ===

async function import_read(file: string, seen: Set<string>): Promise<string> {
  const abs = path.resolve(file);
  if (seen.has(abs)) {
    return "";
  }
  seen.add(abs);
  let text: string;
  try {
    text = (await fs.readFile(abs, "utf-8")).replace(/\r\n/g, "\n");
  } catch {
    die(`import not found: ${abs}`);
  }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const imp = line_import(line);
    if (imp === null) {
      out.push(line);
    } else {
      out.push(await import_read(path.resolve(path.dirname(abs), imp), seen));
    }
  }
  return out.join("\n");
}

async function doc_load(file: string, cwd: string | null): Promise<Doc> {
  const text = (await fs.readFile(file, "utf-8")).replace(/\r\n/g, "\n");
  const base = cwd ?? path.dirname(path.resolve(file));
  const seen = new Set<string>([path.resolve(file)]);
  const parts: Part[] = [];
  const blks: Blk[] = [];
  let run: Line[] = [];
  function flush(): void {
    if (run.length > 0) {
      const part = parts.length;
      parts.push(Own());
      for (const lines of text_blocks(run.join("\n"))) {
        blks.push({ lines, part });
      }
      run = [];
    }
  }
  for (const line of text.split("\n")) {
    const imp = line_import(line);
    if (imp === null) {
      run.push(line);
      continue;
    }
    flush();
    const part = parts.length;
    parts.push(Imp(line.trim()));
    const body = await import_read(path.resolve(base, imp), seen);
    for (const lines of text_blocks(body)) {
      blks.push({ lines, part });
    }
  }
  flush();
  return { parts, blks };
}

function doc_prompt(doc: Doc): Prompt | null {
  let found: { idx: number; marker: Marker } | null = null;
  for (let i = 0; i < doc.blks.length; i++) {
    const blk = doc.blks[i];
    for (let j = 0; j < blk.lines.length; j++) {
      const line = blk.lines[j];
      if (!line.includes(".?.") && !line.includes(".!.")) {
        continue;
      }
      const marker = line_marker(line);
      if (marker === null || j !== blk.lines.length - 1) {
        die(`stray marker: "${line.trim()}"\nA marker must be alone on the last line of its block.`);
      }
      if (doc.parts[blk.part].$ === "Imp") {
        die(`marker inside imported content: "${line.trim()}"`);
      }
      if (found !== null) {
        die("multiple markers found; keep exactly one.");
      }
      found = { idx: i, marker };
    }
  }
  if (found === null) {
    return null;
  }
  const blk = doc.blks[found.idx];
  const lines = blk.lines.slice(0, -1);
  const text = lines.map(line_comment).join("\n").trim();
  doc.blks.splice(found.idx, 1);
  return { marker: found.marker, text, lines, pos: found.idx, part: blk.part };
}

function doc_render(doc: Doc, visible: boolean[]): string {
  const out: string[] = [];
  let elided = false;
  for (let i = 0; i < doc.blks.length; i++) {
    if (visible[i]) {
      out.push(`BLOCK${i}\n` + doc.blks[i].lines.join("\n"));
      elided = false;
    } else if (!elided) {
      out.push("...");
      elided = true;
    }
  }
  return out.join("\n\n");
}

// Char offset of the hole in doc_render's output: the render of the blocks
// before it is a literal prefix of the full render (each piece depends only
// on the visibility flags before it), so the offset is that prefix plus its
// trailing separator.
function doc_offset(doc: Doc, visible: boolean[], at: number): number {
  if (at <= 0) {
    return 0;
  }
  const head = { parts: doc.parts, blks: doc.blks.slice(0, at) };
  return doc_render(head, visible.slice(0, at)).length + 2;
}

// The excerpt re-quotes the file around the hole with the placeholder at its
// exact spot, below the tail of the author's comment when there is one.
// EXCERPT_KEEP lines of the nearest visible blocks on each side anchor it;
// "..." marks a truncated side.
const EXCERPT_KEEP = 4;

function doc_excerpt(doc: Doc, visible: boolean[], at: number, mark: string, lead: Line[]): string {
  const out: string[] = [];
  let prev = at - 1;
  while (prev >= 0 && !visible[prev]) {
    prev = prev - 1;
  }
  if (prev >= 0) {
    const lines = doc.blks[prev].lines;
    const head = lines.length > EXCERPT_KEEP ? "...\n" : "";
    out.push(`BLOCK${prev}\n` + head + lines.slice(-EXCERPT_KEEP).join("\n"));
  }
  const held = lead.length > EXCERPT_KEEP ? ["...", ...lead.slice(-EXCERPT_KEEP)] : lead;
  out.push([...held, mark].join("\n"));
  let next = at;
  while (next < doc.blks.length && !visible[next]) {
    next = next + 1;
  }
  if (next < doc.blks.length) {
    const lines = doc.blks[next].lines;
    const tail = lines.length > EXCERPT_KEEP ? "\n..." : "";
    out.push(`BLOCK${next}\n` + lines.slice(0, EXCERPT_KEEP).join("\n") + tail);
  }
  return out.join("\n\n");
}

// The completion takes the marker line's place: the comment lines above it
// are restored verbatim, glued to the completion's first block.
function doc_fill(doc: Doc, prompt: Prompt, content: string): void {
  const blks = text_blocks(content).map((lines) => ({ lines, part: prompt.part }));
  if (prompt.lines.length > 0) {
    if (blks.length === 0) {
      blks.push({ lines: prompt.lines, part: prompt.part });
    } else {
      blks[0] = { lines: [...prompt.lines, ...blks[0].lines], part: prompt.part };
    }
  }
  doc.blks.splice(prompt.pos, 0, ...blks);
}

function doc_splice(doc: Doc, splices: Splice[], editable: boolean[]): number {
  const sorted = splices.slice().sort((a, b) => a.from - b.from);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.from > s.to || s.from < 0 || s.to >= doc.blks.length) {
      die(`bad splice range: from=${s.from} to=${s.to}`);
    }
    for (let b = s.from; b <= s.to; b++) {
      if (!editable[b]) {
        die(`splice targets read-only or hidden block: BLOCK${b}`);
      }
      if (doc.blks[b].part !== doc.blks[s.from].part) {
        die(`splice crosses an import boundary at BLOCK${b}`);
      }
    }
    if (i > 0 && sorted[i - 1].to >= s.from) {
      die(`overlapping splices at BLOCK${s.from}`);
    }
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i];
    const part = doc.blks[s.from].part;
    const blks = s.blks.map((lines) => ({ lines, part }));
    doc.blks.splice(s.from, s.to - s.from + 1, ...blks);
  }
  return sorted.length;
}

function doc_show(doc: Doc): string {
  const out: string[] = [];
  for (let p = 0; p < doc.parts.length; p++) {
    const part = doc.parts[p];
    if (part.$ === "Imp") {
      out.push(part.line);
    } else {
      for (const blk of doc.blks) {
        if (blk.part === p) {
          out.push(blk.lines.join("\n"));
        }
      }
    }
  }
  return out.join("\n\n") + "\n";
}

// Ranges
// ======

function ranges_show(idxs: number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < idxs.length) {
    let j = i;
    while (j + 1 < idxs.length && idxs[j + 1] === idxs[j] + 1) {
      j = j + 1;
    }
    out.push(i === j ? `BLOCK${idxs[i]}` : `BLOCK${idxs[i]}-BLOCK${idxs[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

function ranges_parse(reply: string, max: number): Set<number> {
  const sel = new Set<number>();
  const re = /BLOCK(\d+)(?:\s*-\s*BLOCK(\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply)) !== null) {
    const a = parseInt(m[1], 10);
    const b = m[2] === undefined ? a : parseInt(m[2], 10);
    for (let i = a; i <= b && i < max; i++) {
      sel.add(i);
    }
  }
  return sel;
}

// Prompts
// =======

// three refusal classes were bisected live and shape these prompts.
// (1) cyber, 2026-08-03: a persona ("You are X, an AI that...") plus
// obedience phrasing ("follow the instructions exactly"), next to file
// content with an embedded TODO, reads as injection; prompts state the task
// impersonally. (2) frontier_llm, 2026-08-04: voice-stripped harvesting
// phrasing -- "verbatim", "match exactly", "no commentary", "an empty reply
// is never valid" -- reads as a distillation pipeline; prompts say plainly
// what the tool is (an editor command run by the file's author), say why
// each constraint exists, and never forbid refusing. (3) frontier_llm,
// 2026-08-04, the decisive one: cutting the marker out of the file and
// naming its location in prose ("write what belongs after BLOCKn") is
// document CONTINUATION -- the raw-completion shape of an output-duplication
// pipeline -- and refused 7/7 on a prose file, while the same request
// anchored to a literal placeholder rendered in the file passed (labels and
// the tail TASK were exonerated by the same bisect). refined 2026-08-05:
// the placeholder needs literal file context, not the full render -- the
// EXCERPT (nearby file lines re-quoted with the placeholder at the mark)
// passed 7/7 on the same file whose prose-located shape refused 7/7 on
// 08-04 and 2/2 replayed verbatim on 08-05. that freed the full render to
// stay placeholder-free, which is what the cache scheme needs. wrap at 80.
const FILL_MARK = "{:FILL_HERE:}";
const EDIT_MARK = "{:REQUEST_HERE:}";

// The excerpt keeps the placeholder anchored in literal file context while
// the full render stays placeholder-free: the file's bytes then do not
// depend on where the hole sits, which is what lets the vendor prompt cache
// hit across runs (the marker's position is not a content change).
function excerpt_head(): string {
  return [
    "The marked spot, with the file lines around it re-quoted from above and",
    "the placeholder at the author's mark (the editor renders the file itself",
    "without the placeholder so its bytes stay stable for prompt caching):",
  ].join("\n");
}

const SYSTEM = [
  "This is an editor command: the author of a file marked a spot in it where",
  "they want help writing or revising content, and their editor sent the file",
  "here so the reply can be placed back at that spot. The file is shown as",
  "numbered blocks; each BLOCKn line labels the block below it. A TASK",
  "section at the end of the message describes the request and the reply",
  "format.",
].join("\n");

function fill_task(): string {
  return [
    `TASK: the author marked the spot where they want content written; the`,
    `excerpt above shows it as the ${FILL_MARK} placeholder at its exact spot`,
    "in the file. The NOTE above, when present, is their comment, written",
    "right above that spot. Reply with the content that goes there:",
    "",
    "- Wrap the content in a single <COMPLETION>...</COMPLETION> block, with",
    "  nothing before or after.",
    "- The editor replaces only the placeholder line with the content; the",
    "  author's comment stays in the file above it, so do not repeat the",
    "  comment.",
    "- Everything inside the block must be file content: BLOCK labels, code",
    "  fences and commentary are not part of the file and would corrupt it.",
    "- Write in the file's own language, style, formatting and conventions,",
    "  so the new content reads native to it.",
    "- Without a comment, the surrounding context shows what the author left",
    "  blank at the placeholder; write that.",
  ].join("\n");
}

function edit_task(ranges: string): string {
  return [
    `TASK: the author wrote the request quoted in the NOTE above at the`,
    `${EDIT_MARK} mark shown in the excerpt, at its exact spot in the file.`,
    "Perform it by replying with SPLICE commands, which the editor applies",
    "to the file:",
    "",
    "<SPLICE from=2 to=4>",
    "new content",
    "</SPLICE>",
    "",
    "Mechanics:",
    "- A splice deletes blocks `from`..`to` INCLUSIVE (from=2 to=4 deletes",
    "  BLOCK2, BLOCK3 and BLOCK4) and inserts its content in their place.",
    "- from=N to=N replaces exactly BLOCK N. Empty content just deletes.",
    "- To insert without deleting, splice one adjacent block and repeat its",
    "  full text plus the new content.",
    "- Splice content goes into the file as-is, so it must be file text:",
    "  BLOCK labels and code fences are not part of the file and would",
    "  corrupt it. Blank lines inside it are fine (they split it into new",
    "  blocks).",
    "- All splices apply to the block numbers shown above (numbers do not",
    "  shift between splices); ranges must not overlap.",
    `- Only these blocks may be spliced: ${ranges}.`,
    "  Everything else is read-only context.",
    "- Make the requested change and nothing more; prefer few, tight",
    "  splices.",
    "- Reply with SPLICE commands only: text outside them is not applied.",
  ].join("\n");
}

function filter_task(): string {
  return [
    "TASK: the author's request -- the NOTE above or, without one, the",
    "marked spot shown in the excerpt -- is fulfilled in a second, separate",
    "step. To cut",
    "cost, blocks of the file may be hidden from that step; each hidden",
    "region is collapsed to \"...\". Reply with the blocks to hide, as",
    "comma-separated ranges (or nothing, to hide none):",
    "",
    "BLOCK30-BLOCK61, BLOCK70",
    "",
    "Every block not listed stays visible. Hiding must be safe: the second",
    "step still has to see everything the request could touch. Hide a",
    "region only when all of these hold:",
    "",
    "- it is large enough that hiding it saves real space;",
    "- the code under edit does not use it, directly or through",
    "  intermediates: no function, type, constant or import it needs;",
    "- it teaches nothing about the request: not similar code, not a",
    "  precedent, not docs or conventions describing the goal;",
    "- it is far from the request's location.",
    "",
    "When any point is uncertain, leave the region visible. Hiding nothing",
    "is a valid reply. Reply with the ranges only: nothing else is read.",
  ].join("\n");
}

// Replies
// =======

function reply_completion(reply: string): string {
  const m = /<COMPLETION>([\s\S]*?)<\/COMPLETION>/.exec(reply);
  if (m !== null) {
    return m[1];
  }
  const open = reply.indexOf("<COMPLETION>");
  if (open === -1) {
    return reply;
  }
  let raw = reply.slice(open + "<COMPLETION>".length).replace(/\s+$/, "");
  const tag = "</COMPLETION>";
  for (let k = tag.length; k >= 2; k--) {
    if (raw.endsWith(tag.slice(0, k))) {
      raw = raw.slice(0, raw.length - k);
      break;
    }
  }
  return raw;
}

function reply_splices(reply: string): Splice[] {
  const out: Splice[] = [];
  const re = /<SPLICE\s+from=["']?(\d+)["']?\s+to=["']?(\d+)["']?\s*>\n?([\s\S]*?)\n?<\/SPLICE>/g;
  let residual = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply)) !== null) {
    residual += reply.slice(last, m.index);
    last = m.index + m[0].length;
    out.push({ from: parseInt(m[1], 10), to: parseInt(m[2], 10), blks: text_blocks(m[3]) });
  }
  residual += reply.slice(last);
  if (out.length > 0 && /<\/?SPLICE/.test(residual)) {
    die("malformed reply: stray SPLICE tag outside matched commands; file untouched.");
  }
  return out;
}

// Model
// =====

function model_label(spec: askai.ResolvedModelSpec): string {
  return `${spec.vendor}:${spec.model}:${spec.thinking}${["", ":fast", ":ultrafast"][spec.fast]}`;
}

// the filter pass runs the same model with thinking off (fable has no
// thinking-off mode, so it gets the lowest; fusion panels filter via the
// board panel's synthesizer)
function model_filter(spec: askai.ResolvedModelSpec): string {
  if (spec.vendor === "fusion") {
    return `${".".repeat(spec.fast)}anthropic:claude-opus-5-5:none`;
  }
  const thinking = spec.model.startsWith("claude-fable") ? "low" : "none";
  return `${".".repeat(spec.fast)}${spec.vendor}:${spec.model}:${thinking}`;
}

// Mirror
// ======

// The previous run's outgoing prompt, kept in the ~/.ai/.holefill2 mirror.
// The char where this run's prompt diverges from it becomes a cache cut:
// the vendor lookup then lands exactly at the deepest cache entry the
// previous run could have written (see askai/Vendors/Anthropic.ts).
async function mirror_read(): Promise<string> {
  try {
    const prev = await fs.readFile(path.join(os.homedir(), ".ai", ".holefill2"), "utf-8");
    const sep = prev.indexOf("\n###\n");
    return sep === -1 ? "" : prev.slice(sep + 5);
  } catch {
    return "";
  }
}

function common_prefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
    i = i + 1;
  }
  return i;
}

// Log
// ===

let log_path: string | null = null;

async function log_note(label: string, tag: string, text: string): Promise<void> {
  if (log_path === null) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(os.homedir(), ".ai", "holefill2_history");
    await fs.mkdir(dir, { recursive: true });
    log_path = path.join(dir, `${ts}_${label.replace(/[:/]/g, "_")}.log`);
  }
  await fs.appendFile(log_path, `${tag}:\n${text}\n\n`, "utf-8");
}

async function preview_write(prompt: string): Promise<void> {
  await fs.mkdir(path.join(os.homedir(), ".ai"), { recursive: true });
  await fs.writeFile(path.join(os.homedir(), ".ai", ".holefill2"), `${SYSTEM}\n###\n${prompt}`, "utf-8");
}

// Main
// ====

function die(msg: string): never {
  console.log(msg);
  process.exit(1);
}

async function main(): Promise<void> {
  const args: string[] = [];
  let cwd: string | null = null;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--cwd") {
      cwd = process.argv[i + 1] ?? null;
      i = i + 1;
    } else {
      args.push(process.argv[i]);
    }
  }
  const file = args[0];
  const model = args[1] ?? "f";
  if (file === undefined) {
    console.log("Usage: holefill2 <file> [<model>] [--cwd <dir>]");
    console.log("");
    console.log("Write a comment block in <file> ending in a marker line:");
    console.log("  .?.  fill: the AI's completion replaces the comment block");
    console.log("  .!.  edit: the AI splices block ranges of the file");
    console.log("Decorations: ^N omits blocks after the prompt except N; - filters context.");
    process.exit(1);
  }

  const spec = askai.resolveModelSpec(model);
  const label = model_label(spec);
  const doc = await doc_load(file, cwd);
  const prompt = doc_prompt(doc);

  if (prompt === null) {
    const all = doc.blks.map(() => true);
    console.log("token_count:", askai.tokenCount(doc_render(doc, all)));
    console.log("model_label:", label);
    console.log("No hole found.");
    process.exit(1);
  }

  const visible = doc.blks.map(() => true);
  if (prompt.marker.after !== null) {
    for (let i = prompt.pos + prompt.marker.after; i < doc.blks.length; i++) {
      visible[i] = false;
    }
  }

  if (prompt.text === "" && prompt.marker.mode === "edit") {
    die("empty edit request: the .!. marker needs a comment in its own block.");
  }

  const mark = prompt.marker.mode === "fill" ? FILL_MARK : EDIT_MARK;
  let ask: string;
  if (prompt.text === "") {
    ask = "";
  } else {
    ask = `NOTE: the author's comment below sits just above the ${mark} mark shown above.\n${prompt.text}\n\n`;
  }
  await log_note(label, "SYSTEM", SYSTEM);

  const past = await mirror_read();
  const pos = prompt.pos;
  const lead = prompt.lines;
  function render(): { head: string; cuts: number[] } {
    const stable = doc_render(doc, visible) + "\n\n";
    const excerpt = excerpt_head() + "\n\n" + doc_excerpt(doc, visible, pos, mark, lead) + "\n\n";
    const cuts = [doc_offset(doc, visible, pos), common_prefix(past, stable), stable.length];
    return { head: stable + excerpt, cuts };
  }

  if (prompt.marker.filter) {
    const { head, cuts } = render();
    const fprompt = head + ask + filter_task();
    const fai = await askai.AskAI(model_filter(spec));
    await preview_write(fprompt);
    await log_note(label, "PROMPT", fprompt);
    console.log("filter_tokens:", askai.tokenCount(fprompt));
    const freply = await fai.ask(fprompt, { system: SYSTEM, cache_cuts: cuts });
    const ftext = typeof freply === "string" ? freply : "";
    await log_note(label, "REPLY", ftext);
    const hide = ranges_parse(ftext, doc.blks.length);
    hide.delete(prompt.pos - 1);
    hide.delete(prompt.pos);
    for (let i = 0; i < visible.length; i++) {
      visible[i] = visible[i] && !hide.has(i);
    }
    const hidden = doc.blks.flatMap((blk, i) => hide.has(i) ? [i] : []);
    console.log("filter_hidden:", hidden.length === 0 ? "(none)" : ranges_show(hidden));
  }

  const editable = doc.blks.map((blk, i) => visible[i] && doc.parts[blk.part].$ === "Own");
  if (prompt.marker.mode === "edit" && !editable.some((e) => e)) {
    die("no editable blocks (everything visible is imported).");
  }

  let task: string;
  if (prompt.marker.mode === "fill") {
    task = fill_task();
  } else {
    task = edit_task(ranges_show(editable.flatMap((e, i) => e ? [i] : [])));
  }
  const { head, cuts } = render();
  const full = head + ask + task;
  const ai = await askai.AskAI(model);
  await preview_write(full);
  await log_note(label, "PROMPT", full);
  console.log("token_count:", askai.tokenCount(full));
  console.log("model_label:", label);
  const reply = await ai.ask(full, { system: SYSTEM, cache_cuts: cuts });
  const text = typeof reply === "string" ? reply : "";
  await log_note(label, "REPLY", text);

  if (prompt.marker.mode === "fill") {
    const content = reply_completion(text).replace(/^\n+|\n+$/g, "");
    if (content.trim() === "") {
      die("empty completion; file untouched.");
    }
    doc_fill(doc, prompt, content);
  } else {
    const splices = reply_splices(text);
    if (splices.length === 0) {
      die("no SPLICE commands found in reply.");
    }
    const applied = doc_splice(doc, splices, editable);
    console.log("splices_applied:", applied);
  }
  await fs.writeFile(file, doc_show(doc), "utf-8");
  console.log("output_file:", file);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
