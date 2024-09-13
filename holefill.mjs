#!/usr/bin/env node
import { chat, MODELS, tokenCount } from './Chat.mjs';
import process from "process";
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/*
const system = `
You are a HOLE FILLER. You are provided with a file containing holes, formatted
as '{{HOLE_NAME}}'. Your TASK is to complete with a string to replace this hole
with, inside a <COMPLETION/> XML tag, including context-aware indentation, if
needed. All completions MUST be truthful, accurate, well-written and correct.

## EXAMPLE QUERY:

<QUERY>
function sum_evens(lim) {
  var sum = 0;
  for (var i = 0; i < lim; ++i) {
    {{FILL_HERE}}
  }
  return sum;
}
</QUERY>

## CORRECT COMPLETION

<COMPLETION>if (i % 2 === 0) {
      sum += i;
    }</COMPLETION>

## EXAMPLE QUERY:

<QUERY>
def sum_list(lst):
  total = 0
  for x in lst:
  {{FILL_HERE}}
  return total

print sum_list([1, 2, 3])
</QUERY>

## CORRECT COMPLETION:

<COMPLETION>  total += x</COMPLETION>

## EXAMPLE QUERY:

<QUERY>
// data Tree a = Node (Tree a) (Tree a) | Leaf a

// sum :: Tree Int -> Int
// sum (Node lft rgt) = sum lft + sum rgt
// sum (Leaf val)     = val

// convert to TypeScript:
{{FILL_HERE}}
</QUERY>

## CORRECT COMPLETION:

<COMPLETION>type Tree<T>
  = {$:"Node", lft: Tree<T>, rgt: Tree<T>}
  | {$:"Leaf", val: T};

function sum(tree: Tree<number>): number {
  switch (tree.$) {
    case "Node":
      return sum(tree.lft) + sum(tree.rgt);
    case "Leaf":
      return tree.val;
  }
}</COMPLETION>

## EXAMPLE QUERY:

The 2nd {{FILL_HERE}} is Saturn.

## CORRECT COMPLETION:

<COMPLETION>gas giant</COMPLETION>

## EXAMPLE QUERY:

function hypothenuse(a, b) {
  return Math.sqrt({{FILL_HERE}}b ** 2);
}

## CORRECT COMPLETION:

<COMPLETION>a ** 2 + </COMPLETION>

## IMPORTANT:

- Answer ONLY with the <COMPLETION/> block. Do NOT include anything outside it.
`;
*/

const SYSTEM = `You're a code completion assistant.`;
const FILL   = "{:FILL_HERE:}";
const TASK   = "### TASK: complete the "+FILL+" part of the file above. Write ONLY the needed text to replace "+FILL+" by the correct completion, including correct spacing and indentation. Include the answer inside a <COMPLETION></COMPLETION> tag.";

var file  = process.argv[2];
var mini  = process.argv[3];
var model = process.argv[4] || "c";
var ask   = chat(model);

if (!file) {
  console.log("Usage: holefill <file> [<shortened_file>] [<model_name>]");
  console.log("");
  console.log("This will complete a HOLE, written as '.?.', in <file>, using the AI.");
  console.log("A shortened file can be used to omit irrelevant parts.");
  process.exit();
}

var file_code = await fs.readFile(file, 'utf-8');
var mini_code = mini ? await fs.readFile(mini, 'utf-8') : file_code;

// Imports context files when //./path_to_file// is present.
var regex = /\/\/\.\/(.*?)\/\//g;
var match;
while ((match = regex.exec(mini_code)) !== null) {
  var import_path = path.resolve(path.dirname(file), match[1]);
  if (await fs.stat(import_path).then(() => true).catch((e) => false)) {
    var import_text = await fs.readFile(import_path, 'utf-8');
    console.log("import_file:", match[0]);
    mini_code = mini_code.replace(match[0], '\n' + import_text);
  } else {
    console.log("import_file:", match[0], "ERROR");
    process.exit(1);
  }
}

await fs.writeFile(mini, mini_code, 'utf-8');

var tokens = tokenCount(mini_code);
var prompt = mini_code.replace(".?.", FILL) + "\n\n" + TASK;

await fs.mkdir(path.join(os.homedir(), '.ai'), { recursive: true });
await fs.writeFile(path.join(os.homedir(), '.ai', '.holefill'), SYSTEM + "\n###\n" + prompt, "utf-8");

console.log("token_count:", tokens);
console.log("model_label:", MODELS[model] || model);

if (mini_code.indexOf(".?.") === -1) {
  console.log("No hole found.");
  process.exit();
}

await savePromptHistory(SYSTEM, prompt, reply, MODELS[model] || model);

var reply = (await ask(prompt, {system: SYSTEM, model, max_tokens: 8192}));
var reply = reply.indexOf("<COMPLETION>")  === -1 ? "<COMPLETION>" + reply  : reply;
var reply = reply.indexOf("</COMPLETION>") === -1 ? reply + "</COMPLETION>" : reply;
var match = reply.match(/<COMPLETION>([\s\S]*?)<\/COMPLETION>/);
if (match) {
  file_code = file_code.replace(".?.", match[1]);
} else {
  console.error("Error: Could not find <COMPLETION> tags in the AI's response.");
  process.exit(1);
}

await fs.writeFile(file, file_code, 'utf-8');

async function savePromptHistory(SYSTEM, prompt, reply, model) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(os.homedir(), '.ai', 'prompt_history', `${timestamp}_${model}.log`);
  const logContent = `SYSTEM:\n${SYSTEM}\n\nPROMPT:\n${prompt}\n\REPLY:\n${reply}\n\n`;
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, logContent, 'utf-8');
}
