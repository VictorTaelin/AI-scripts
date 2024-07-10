#!/usr/bin/env node

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import process from "process";
import { chat, MODELS, tokenCount } from './Chat.mjs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const kind2_guide = await fs.readFile(new URL('./KIND2_GUIDE_AI.md', import.meta.url), 'utf-8');

// System prompt for the AI model, defining its role and behavior
const system = `
You are KindCoder, a Kind2-Lang coding assistant.

# USER INPUT

You will receive:

1. A target <FILE/> in the Kind2 language. That's the code you must update.

2. The user's change <REQUEST/>. You must perform that change on the target file.

3. Some additional context (files, dirs) that could be helpful.

# KINDCODER OUTPUT

You, KindCoder, must answer with a single <RESULT/> tag, which must include the
user's file, except *modified* to fulfill the user's request, and nothing else.

# GUIDE FOR REFACTORING

1. Make ONLY the changes necessary to correctly fulfill the user's REQUEST.
2. Do NOT fix, remove, complete, or alter any parts unrelated to the REQUEST.
3. Preserve the same indentation and style of the target FILE.
4. Consult Kind2's guide to emit syntactically correct code.
5. Be precise and careful in your modifications.

${kind2_guide}

# KINDCODER EXAMPLE

Below is a complete example of how KindCoder should interact with the user.

## User:

<FILE path="/Users/v/vic/dev/kind2/book/Nat/_.kind2">
...
</FILE>

<FILE path="/Users/v/vic/dev/kind2/book/Nat/succ.kind2">
...
</FILE>

<FILE path="/Users/v/vic/dev/kind2/book/Nat/zero.kind2">
...
</FILE>

<FILE path="/Users/v/vic/dev/kind2/book/Nat/is_even.kind2" target>
use Nat/{succ,zero}

is_even
- n: Nat
: Nat

?a
</FILE>

<CHECKER>
GOAL ?a : Nat
- n: Nat
</CHECKER>

<REQUEST>
case-split on n
</REQUEST>

## KindCoder:

<RESULT>
use Nat/{succ,zero}

is_even
- n: Nat
: Nat

match n {
  zero: ?zero_case
  succ: ?succ_case
}
</RESULT>

# EXPLANATION

## Input:

The user provided a target file (Nat/is_even) to be modified, and a request:
"case-split on n". The user also provided some additional files and dirs for
context (including Nat, Nat/succ, Nat/zero). The target file had an incomplete
top-level definition, 'is_even', with a hole, '?a', as its body.

## Output:

As a response, you, KindCoder, performed a case-split on 'n', by using Kind's
'match' syntax-sugar. You did NOT perform any extra work, nor change anything
beyond what the user explicitly asked for. Instead, you just placed NEW holes
('?n_is_zero'/'?n_is_succ') on the respective cases. You included the updated
file inside a RESULT tag, completing the task successfully. Good job!

# TASK

The user will now give you a Kind2 file, and a change request. Read it carefully
and update it as demanded. Consult the guides above as necessary. Pay attention
to syntax details, like mandatory parenthesis, to emit valid code. Do it now:
`;

// Main function to handle the refactoring process
async function main() {
  // Check for correct usage and parse command-line arguments
  if (process.argv.length < 3) {
    console.log("Usage: kind-refactor <file> <request> [<model>]");
    process.exit(1);
  }

  let file = process.argv[2];
  let request = process.argv[3];
  let model = process.argv[4] || "s";

  // Initialize the chat function with the specified model
  let ask = chat(model);

  // Get directory and file information
  let dir = path.dirname(file);
  let fileContent = await fs.readFile(file, 'utf-8');
  let dirContent = await fs.readdir(dir);

  // New functionality: Handle lines starting with '//@'
  let extraFiles = [];
  fileContent = fileContent.split('\n').filter(line => {
    if (line.startsWith('//@')) {
      extraFiles.push(line.slice(3));
      return false;
    }
    return true;
  }).join('\n');

  // If the request is empty, replace it by a default request.
  if (request.trim() === '') {
    request = [
      "Update this file.",
      "- If it is empty, implement the *Initial Template*.",
      "- If it has holes, fill them, up to \"one layer\". Don't fully complete it.",
      "- If it has no holes, fully complete it, as much as possible."
    ].join('\n');
  }

  // If the file is empty, ask the AI to fill with an initial template
  if (fileContent.trim() === '') {

    const getAllKind2Files = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = await Promise.all(entries.map(async (entry) => {
        const res = path.resolve(dir, entry.name);
        if (entry.isDirectory()) {
          const subFiles = await getAllKind2Files(res);
          return { name: entry.name, children: subFiles };
        } else if (entry.name.endsWith('.kind2')) {
          return { name: entry.name };
        }
        return null;
      }));
      return files.filter(Boolean);
    };

    const buildTree = (files, prefix = '') => {
      let result = '';
      for (const file of files) {
        if (file.children) {
          result += `${prefix}- ${file.name}/\n`;
          result += buildTree(file.children, `${prefix}  `);

        } else {
          result += `${prefix}- ${file.name}\n`;
        }
      }
      return result;
    };

    const allFiles = await getAllKind2Files(path.join(dir, '..', '..', 'book'));
    const relativeFilesString = buildTree(allFiles);

    fileContent = [
      "This is a new, empty file.",
      "",
      "Please replace this file with a Kind2 definition, including:",
      "- 'use' imports (read the list above to decide which are relevant)",
      "- the function name and its arguments (based on the file name)",
      "- a hole in the place of its body (just `?body`)",
      "",
      "Example Initial Template:",
      "",
      "```kind2",
      "/// Does foo.",
      "///",
      "/// # Input",
      "///",
      "/// * `x0` - Description",
      "/// * `x1` - Description",
      "/// ...",
      "///",
      "/// # Output",
      "///",
      "/// The result of doing foo",
      "",
      "use Lib/A/{a,b}",
      "use Lib/B/{c,d}",
      "...",
      "",
      "foo <A> <B> ...",
      "- x0: X0",
      "- x1: X1",
      "...",
      "",
      "?body",
      "```",
      "",
      "Do not complete the file yet. Just write this *Initial Template*.",
      "Exception: if this should be a 'data' declaration, fully complete it.",
      "",
      "[HINT] Below is a list of ALL files in the book:",
      relativeFilesString,
    ].join('\n');
  }

  // Extract the definition name from the file path
  let defName = file.split('/book/')[1].replace('.kind2', '');

  // Get dependencies
  let depsCmd = `kind2 deps ${defName}`;
  let { stdout: depsOutput } = await execAsync(depsCmd);
  let deps = depsOutput.trim().split('\n');
  deps = [...new Set([...deps, ...extraFiles])];

  // Read dependent files
  let depFiles = await Promise.all(deps.map(async (dep) => {
    let depPath, content;
    let path0 = path.join(dir, '..', `${dep}.kind2`);
    let path1 = path.join(dir, '..', `${dep}/_.kind2`); 
    try {
      content = await fs.readFile(path0, 'utf-8');
      depPath = path0;
    } catch (error) {
      try {
        content = await fs.readFile(path1, 'utf-8');
        depPath = path1;
      } catch (error) {
        return "";
      }
    }
    return `<FILE path="${depPath}">\n${content}\n</FILE>`;
  }));

  // Perform initial type checking
  let initialCheck = await typeCheck(defName);

  // Prepare AI input
  let aiInput = [
    ...depFiles,
    `<FILE path="${file}" target>`,
    fileContent,
    '</FILE>',
    '<CHECKER>',
    initialCheck,
    '</CHECKER>',
    '<REQUEST>',
    request,
    '</REQUEST>'
  ].join('\n').trim();

  // TODO: write a .prompt file with the system + aiInput strings
  
  // Write a .prompt file with the system + aiInput strings
  await fs.writeFile('.kindcoder', system + '\n\n' + aiInput, 'utf-8');

  // Call the AI model
  let aiOutput = await ask(aiInput, { system, model });

  // Extract the result from AI output
  let resultMatch = aiOutput.match(/<RESULT>([\s\S]*)<\/RESULT>/);
  if (!resultMatch) {
    console.error("Error: AI output does not contain a valid RESULT tag.");
    process.exit(1);
  }

  let result = resultMatch[1].trim();

  // Write the result back to the file
  await fs.writeFile(file, result, 'utf-8');

  console.log("File updated successfully.");
}

// Function to perform type checking based on file extension
async function typeCheck(file) {
  let ext = path.extname(file);
  let cmd = `kind2 check ${file}`;
  try {
    var result = await execAsync(cmd);
    return result.stderr.trim() || result.stdout.trim();
  } catch (error) {
    return error.stderr.trim();
  }
}

// Run the main function and handle any errors
main().catch(console.error);
