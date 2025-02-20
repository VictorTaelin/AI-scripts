#!/usr/bin/env -S node --no-warnings --no-deprecation

import { chat, MODELS, tokenCount } from './Chat.mjs';
import process from "process";
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

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

// Prevent recursive imports
const seen = new Set();

// Imports context files when // ./path_to_file // is present.
var regex = /\/\/\.\/(.*?)\/\//g;
var match;
while ((match = regex.exec(mini_code)) !== null) {
  var import_path = path.resolve(path.dirname(file), match[1]);
  if (!seen.has(import_path)) {
    if (await fs.stat(import_path).then(() => true).catch((e) => false)) {
      var import_text = await fs.readFile(import_path, 'utf-8');
      console.log("import_file:", match[0]);
      mini_code = mini_code.replace(match[0], '\n' + import_text);
      seen.add(import_path);
    } else {
      console.log("import_file:", match[0], "ERROR");
      process.exit(1);
    }
  } else {
    console.log("import_file:", match[0], "SKIPPED (already imported)");
  }
}

await fs.writeFile(mini, mini_code, 'utf-8');

var tokens  = tokenCount(mini_code);
var source  = mini_code.replace(".?.", FILL);
var prompt  = source + "\n\n" + TASK;
var predict = "<COMPLETION>\n" + source + "</COMPLETION>";

await fs.mkdir(path.join(os.homedir(), '.ai'), { recursive: true });
await fs.writeFile(path.join(os.homedir(), '.ai', '.holefill'), SYSTEM + "\n###\n" + prompt, "utf-8");

console.log("token_count:", tokens);
console.log("model_label:", MODELS[model] || model);

if (mini_code.indexOf(".?.") === -1) {
  console.log("No hole found.");
  process.exit();
}

await savePromptHistory(SYSTEM, prompt, reply, MODELS[model] || model);

var reply = (await ask(prompt, {system: SYSTEM, model, max_tokens: 8192, predict}));
var reply = reply.indexOf("<COMPLETION>")  === -1 ? "<COMPLETION>" + reply  : reply;
var reply = reply.indexOf("</COMPLETION>") === -1 ? reply + "</COMPLETION>" : reply;
var match = reply.match(/<COMPLETION>([\s\S]*?)<\/COMPLETION>/);
if (match) {
  var fill = match[1].replace(/\$/g, '$$$$').replace(/^\n+|\n+$/g, '');
  file_code = file_code.replace(".?.", fill);
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
