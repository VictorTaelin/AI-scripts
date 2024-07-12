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
const system_KindCoder = `
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
`.trim();

const system_DepsPredictor = `
# ABOUT KIND2

Kind2 is a minimal purely functional programming language, where every file
defines exactly ONE function, type or constant. For example:

'''
// Nat/add.kind2: defines Nat addition

use Nat/{succ,zero}

add
- a: Nat
- b: Nat
: Nat

match a {
  succ: (succ (add a.pred b))
  zero: b
}
'''

The file above implements the global 'Nat/add' definition.

# INPUT

You will be given the NAME of a Kind2 file, its source code (which may be
empty), and a list of ALL Kind2 definitions available in the stdlib.

# OUTPUT

You must answer with a list of definitions that are, or that you predict WILL BE
used, directly or not, inside that Kind2 file. Answer in a <DEPENDENCIES/> tag.

Optionally, you can also include a SHORT, 1-paragraph <JUSTIFICATION/>.

# EXAMPLE INPUT

<NAME>Nat/equal</NAME>

<SOURCE>
</SOURCE>

<DEFINITIONS>
- List/
  - cons
  - nil
  - match
  - map
  - fold
  - filter
  - equal
  - zip
  - length
- Nat/
  - match
  - fold
  - succ
  - zero
  - compare
  - add
  - sub
  - mul
  - div
  - mod
  - pow
  - lte
  - gte
- Bool/
  - match
  - fold
  - true
  - false
  - not
  - and
  - or
  - xor
  - nand
</DEFINITION>

# EXAMPLE OUTPUT

<JUSTIFICATION>
Nat/equal is likely to be a pairwise comparison between Nats. As such, it must
include Nat (obviously), as well as its constructor and match. It returns a
Bool, so, it must also include its constructors and match. For completion, I've
also added bool AND and OR, since these are often used in comparison. Finally,
Nat/compare and List/equal might be similar algorithms, so, I included them.
</JUSTIFICATION>
<DEPENDENCIES>
Nat
Nat/succ
Nat/zero
Nat/match
Bool
Bool/true
Bool/false
Bool/match
Bool/and
Bool/or
Nat/compare
List/equal
</DEPENDENCIES>

# HINTS

- Attempt to include ALL files that might be relevant, directly or not.

- Always include files that might be similar algorithms to the current one.
  Example: 'Map/set' MUST include 'Mat/get'

- If the file is the constructor of an ADT, then, INCLUDE its type.
  Example: 'List/cons' MUST include 'List'

- When in doubt, prefer to include MORE, rather than LESS, potencial dependencies.

- Try to include AT LEAST 4 dependencies, and AT MOST (only if needed) 16.

- Sometimes the user will give hints in the file. Follow them.
`.trim();

// Function to predict dependencies
async function predictDependencies(name, fileContent) {
  // Function to get all Kind2 files recursively
  async function getAllKind2Files(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await getAllKind2Files(res);
        return subFiles.length > 0 ? { name: entry.name, children: subFiles } : null;
      } else if (entry.name.endsWith('.kind2')) {
        return { name: entry.name.replace('.kind2', '') };
      }
      return null;
    }));
    return files.filter(file => file !== null).map(file => ({...file, name: file.name.replace(/\/_$/, '')}));
  }

  // Function to build a tree structure from files
  function buildTree(files, prefix = '') {
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
  }

  const allFiles = await getAllKind2Files("./");
  const defsTree = buildTree(allFiles);

  const aiInput = [
    `<NAME>${name}</NAME>`,
    '<SOURCE>',
    fileContent.trim(),
    '</SOURCE>',
    '<DEFINITIONS>',
    defsTree.trim(),
    '</DEFINITIONS>'
  ].join('\n').trim();

  const aiOutput = await chat("s")(aiInput, { system: system_DepsPredictor, model: "s" });
  console.log("");

  const dependenciesMatch = aiOutput.match(/<DEPENDENCIES>([\s\S]*)<\/DEPENDENCIES>/);
  if (!dependenciesMatch) {
    console.error("Error: AI output does not contain a valid DEPENDENCIES tag.");
    return [];
  }

  return dependenciesMatch[1].trim().split('\n').map(dep => dep.trim());
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

// Main function to handle the refactoring process
async function main() {
  // Check for correct usage and parse command-line arguments
  if (process.argv.length < 3) {
    console.log("Usage: kindcoder <file> <request> [<model>]");
    process.exit(1);
  }

  let file = process.argv[2];
  let request = process.argv[3];
  let model = process.argv[4] || "s";

  // Initialize the chat function with the specified model
  let ask = chat(model);

  // Get directory and file information
  let dir = path.dirname(file);
  let fileContent;
  try {
    fileContent = await fs.readFile(file, 'utf-8');
  } catch (e) {
    fileContent = "";
  }
  let dirContent = await fs.readdir(dir);

  // If the request is empty, replace it by a default request.
  if (request.trim() === '') {
    request = [
      "Update this file.",
      "- If it is empty, implement an initial template.",
      "- If it has holes, fill them, up to \"one layer\".",
      "- If it has no holes, fully complete it, as much as possible."
    ].join('\n');
  }

  // If the file is empty, ask the AI to fill with an initial template
  if (fileContent.trim() === '') {
    fileContent = [
      "This file is empty. Please replace it with a Kind2 definition. Example:",
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
      "body",
      "```",
    ].join('\n');
  }

  // Extract the definition name from the file path
  let defName = file.split('/book/')[1].replace('.kind2', '');

  // Collect direct and indirect dependencies
  let deps;
  try {
    let { stdout } = await execAsync(`kind2 deps ${defName}`);
    deps = stdout.trim().split('\n');
  } catch (e) {
    deps = [];
  }

  // Predict additional dependencies
  const predictedDeps = await predictDependencies(defName, fileContent);
  //console.log(JSON.stringify(predictedDeps,null,2));
  //process.exit();
  deps = [...new Set([...deps, ...predictedDeps])];
  deps = deps.filter(dep => dep !== defName);

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
  let initialCheck = (await typeCheck(defName)).replace(/\x1b\[[0-9;]*m/g, '');

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

  // Write a .prompt file with the system + aiInput strings
  await fs.writeFile('.kindcoder', system_KindCoder + '\n\n' + aiInput, 'utf-8');

  // Call the AI model
  let aiOutput = await ask(aiInput, { system: system_KindCoder, model });
  console.log("");

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

// Run the main function and handle any errors
main().catch(console.error);

