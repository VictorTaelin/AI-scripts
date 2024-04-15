#!/usr/bin/env node
import { asker, MODELS } from './Ask.mjs';
import process from "process";
import fs from 'fs/promises';
import path from 'path';

const system = `
You are a HOLE FILLER. You are provided with a file containing holes, formatted
as '{{HOLE}}'. Your TASK is to answer with a string to replace this hole with.

## EXAMPLE QUERY:

function sum_evens(lim) {
  var sum = 0;
  for (var i = 0; i < lim; ++i) {
    {{LOOP}}
  }
  return sum;
}

TASK: Fill the {{LOOP}} hole.

## CORRECT ANSWER:

if (i % 2 === 0) {
      sum += i;
    }

## NOTICE THE CONTEXT-AWARE INDENTATION:

1. The first line is NOT indented, because there are already spaces before {{LOOP}}.

2. The other lines ARE indented, to match the indentation of the context.

# NOTICE NO EXTRA EXPLANATORY WORDS:

1. Do NOT add explanatory words like 'here is the code...' in the answer.

2. Unless demanded by context, do NOT add backticks around the answer.

3. Answer just with the correct substitution. 
`;

var file = process.argv[2];
var curr = process.argv[3];
var model = process.argv[4] || "C";

if (!file) {
  console.log("Usage: holefill <file> [<shortened_file>] [<model>]");
  console.log("Replaces {{HOLES}} in <file> using the specified model. Shortcuts:");
  for (var key in MODELS) {
    console.log("- " + key + " = " + MODELS[key]);
  }
  console.log("A shortened file can be used to provide relevant context.");
  process.exit(1);
}

var file_code = await fs.readFile(file, 'utf-8');
var curr_code = curr ? await fs.readFile(curr, 'utf-8') : file_code;

// Imports context files when //./path_to_file// is present.
var regex = /\/\/\.\/(.*?)\/\//g;
var match;
while ((match = regex.exec(curr_code)) !== null) {
  var import_path = path.resolve(path.dirname(file), match[1]);
  if (await fs.stat(import_path).then(() => true).catch(() => false)) {
    var import_text = await fs.readFile(import_path, 'utf-8');
    console.log("import_file:", match[0]);
    curr_code = curr_code.replace(match[0], '\n' + import_text);
  } else {
    console.log("import_file:", match[0], "ERROR");
    process.exit(1);
  }
}

await fs.writeFile(curr, curr_code, 'utf-8');

var tokens = curr_code.length; // Use the length of the code as a rough estimate of tokens
var holes = curr_code.match(/{{\w+}}/g) || [];

var ask = asker();

console.log("holes_found:", holes);
console.log("token_count:", tokens);
console.log("model_label:", MODELS[model] || model);

for (let hole of holes) {
  console.log("next_filled: " + hole + "...");
  var prompt = curr_code + "\nTASK: Fill the {{" + hole + "}} hole. Answer only with the EXACT completion to replace {{" + hole + "}} with. INDENT IT BASED ON THE CONTEXT.";
  var answer = await ask(prompt, { system, model, temperature: 0, max_tokens: 4096 });
  file_code = file_code.replace(hole, answer);
}

await fs.writeFile(file, file_code, 'utf-8');
