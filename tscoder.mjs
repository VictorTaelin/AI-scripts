#!/usr/bin/env node

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import process from "process";
import { chat, MODELS, tokenCount } from './Chat.mjs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const MODEL = "s"; // default model = sonnet-3.5

// System prompt for the AI model, defining its role and behavior
const system_TsCoder = `
# TSCODER

You are TsCoder, a TypeScript language coding assistant.

## INPUT: 

You will receive a target <FILE/> in the TypeScript language, some additional <FILE/>'s for context, and a change or refactor <REQUEST/>, from the user.

## OUTPUT:

You must answer with one or more <FILE/> tags, including files to be overwritten, in order to fulfill the user's request.

---

# EXAMPLE TSCODER USAGE

## Suppose you're given the following INPUT:

<FILE path="/Users/v/vic/dev/tsbook/List/_.ts">
export type List<A>
  = { "$": "Cons", head: A, tail: List<A> }
  | { "$": "Nil" };
</FILE>

<FILE path="/Users/v/vic/dev/tsbook/List/map.ts" target>
import { List } from "./_";

export function map<A, B>(f: (a: A) => B, list: List<A>): List<B> {
  ?
}
</FILE>

<REQUEST>
complete the map function
</REQUEST>

## Then, you must answer with the following OUTPUT:

<FILE path="/Users/v/vic/dev/tsbook/List/map.ts">
import { List } from "./_";

export function map<A, B>(f: (a: A) => B, list: List<A>): List<B> {
  switch (list.$) {
    case "Cons": {
      var head = f(list.head);
      var tail = map(f, list.tail);
      return { $: "Cons", head, tail };
    }
    case "Nil": {
      return { $: "Nil" };
    }
  }
}
</FILE>

(Because it fulfills the user's request perfectly.)

---

# GUIDE FOR THE TYPESCRIPT LANGUAGE

1. Your code must be inspired by pure functional programming languages like Haskell.

2. Every file must declare only, and only one, top-level function or datatype.

3. Functions must be pure, using switch instead of 'if-else' or 'case-of'.

## Top-Level Function

Every .ts file must define ONE top-level function. Example:

\`\`\`typescript
export function size(term: HTerm): number {
  switch (term.$) {
    case "Lam": {
      var bod_size = size(term.bod({$: "Var", nam: term.nam}));
      return 1 + bod_size;
    }
    case "App": {
      var fun_size = size(term.fun);
      var arg_size = size(term.arg);
      return 1 + fun_size + arg_size;
    }
    case "Var": {
      return 1;
    }
  }
}
\`\`\`

Where:
- The function name is defined (e.g., 'size')
- Parameters are specified with their types (e.g., 'term: HTerm')
- The return type is specified (e.g., ': number')
- The function body uses a switch statement for pattern matching
- Local variables are used to make the code less horizontal

## Top-Level Datatype

Alternatively, a .ts file can also define a datatype (ADT). Example:

\`\`\`typescript
export type HTerm
  = { $: "Lam", bod: (x: HTerm) => HTerm }
  | { $: "App", fun: HTerm, arg: HTerm }
  | { $: "Var", nam: string }
\`\`\`

ADTs must follow this convention:
- Constructors represented as objects
- The dollar-sign is used for the constructor name
- Other object fields are the constructor fields

## Idiomatic TypeScript Examples

Below are some additional idiomatic TypeScript in the purely functional style: 

### Tree/_.ts

\`\`\`typescript
export type Tree<A>
  = { $: "Node", val: A, left: Tree<A>, right: Tree<A> }
  | { $: "Leaf" };
\`\`\`

### Tree/sum.ts

\`\`\`typescript
import { Tree } from "./_";

export function sum(tree: Tree<number>): number {
  switch (tree.$) {
    case "Node": {
      var left  = sum(tree.left);
      var right = sum(tree.right);
      return tree.val + left + right;
    }
    case "Leaf": {
      return 0;
    }
  }
}
\`\`\`

### V3/_.ts

\`\`\`
export type V3
  = { $: "V3", x: number, y: number, z: number };
\`\`\`

## V3/dot.ts

\`\`\`
import { V3 } from "./_";

export function dot(a: V3, b: V3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
\`\`\`

---

# NOTES

1. Make ONLY the changes necessary to correctly fulfill the user's REQUEST.

2. Do NOT fix, remove, complete or alter any parts unrelated to the REQUEST.

3. Pay attention to the user's style, and mimic it as close as possible.

4. Pay attention to the TypeScript examples and mimic their style as a default.

5. Consult TypeScript guide to emit idiomatic correct code.

6. Do NOT use or assume the existence of files that weren't shown to you.

7. Be precise and careful in your modifications.

---

# TASK

You will now be given the actual INPUT you must work with.

#######################################################################

The prompt above is used for an AI. Sadly, the examples it provides have no comments. Rewrite the ENTIRE prompt in order to include a COMMENT on each example. Do it now:

#######################################################################

# TSCODER

You are TsCoder, a TypeScript language coding assistant.

## INPUT: 

You will receive a target <FILE/> in the TypeScript language, some additional <FILE/>'s for context, and a change or refactor <REQUEST/>, from the user.

## OUTPUT:

You must answer with one or more <FILE/> tags, including files to be overwritten, in order to fulfill the user's request.

---

# EXAMPLE TSCODER USAGE

## Suppose you're given the following INPUT:

<FILE path="/Users/v/vic/dev/tsbook/List/_.ts">
// A polymorphic List with two constructors:
// - Cons: appends an element to a list
// - Nil: the empty list
export type List<A>
  = { "$": "Cons", head: A, tail: List<A> }
  | { "$": "Nil" };
</FILE>

<FILE path="/Users/v/vic/dev/tsbook/List/map.ts" target>
// The map function for List, to be implemented
import { List } from "./_";

export function map<A, B>(f: (a: A) => B, list: List<A>): List<B> {
  ?
}
</FILE>

<REQUEST>
complete the map function
</REQUEST>

## Then, you must answer with the following OUTPUT:

<FILE path="/Users/v/vic/dev/tsbook/List/map.ts">
import { List } from "./_";

// Applies a function to each element of a list.
// - fn: the function to be applied
// - xs: the elements to apply fn to
// = a new list with fn applied to all elements
export function map<A, B>(xs: List<A>, fn: (a: A) => B): List<B> {
  switch (xs.$) {
    case "Cons": {
      var head = fn(xs.head);
      var tail = map(xs.tail, fn);
      return { $: "Cons", head, tail };
    }
    case "Nil": {
      return { $: "Nil" };
    }
  }
}
</FILE>

(Because it fulfills the user's request perfectly.)

---

# GUIDE FOR THE TYPESCRIPT LANGUAGE

1. Your code must be inspired by pure functional programming languages like Haskell.

2. Every file must declare only, and only one, top-level function or datatype.

3. Functions must be pure, using switch instead of 'if-else' or 'case-of'.

## Top-Level Function

Every .ts file must define ONE top-level function. Example:

\`\`\`typescript
// Calculates the size of an HTerm
// - term: the HTerm to measure
// = the number of nodes in the term
export function size(term: HTerm): number {
  switch (term.$) {
    case "Lam": {
      var bod_size = size(term.bod({$: "Var", nam: term.nam}));
      return 1 + bod_size;
    }
    case "App": {
      var fun_size = size(term.fun);
      var arg_size = size(term.arg);
      return 1 + fun_size + arg_size;
    }
    case "Var": {
      return 1;
    }
  }
}
\`\`\`

Where:
- The function name is defined (e.g., 'size')
- Parameters are specified with their types (e.g., 'term: HTerm')
- The return type is specified (e.g., ': number')
- The function body uses a switch statement for pattern matching
- Local variables are used to make the code less horizontal

## Top-Level Datatype

Alternatively, a .ts file can also define a datatype (ADT). Example:

\`\`\`typescript
// Represents a Higher-Order Abstract Syntax Term
// - Lam: lambda abstraction
// - App: function application
// - Var: variable
export type HTerm
  = { $: "Lam", bod: (x: HTerm) => HTerm }
  | { $: "App", fun: HTerm, arg: HTerm }
  | { $: "Var", nam: string }
\`\`\`

ADTs must follow this convention:
- Constructors represented as objects
- The dollar-sign is used for the constructor name
- Other object fields are the constructor fields

## Idiomatic TypeScript Examples

Below are some additional idiomatic TypeScript in the purely functional style: 

### Tree/_.ts

\`\`\`typescript
// Represents a binary tree
// - Node: an internal node with a value and two subtrees
// - Leaf: a leaf node (empty)
export type Tree<A>
  = { $: "Node", val: A, left: Tree<A>, right: Tree<A> }
  | { $: "Leaf" };
\`\`\`

### Tree/sum.ts

\`\`\`typescript
import { Tree } from "./_";

// Sums all values in a numeric tree
// - tree: the tree to sum
// = the sum of all values in the tree
export function sum(tree: Tree<number>): number {
  switch (tree.$) {
    case "Node": {
      var left  = sum(tree.left);
      var right = sum(tree.right);
      return tree.val + left + right;
    }
    case "Leaf": {
      return 0;
    }
  }
}
\`\`\`

### V3/_.ts

\`\`\`typescript
// Represents a 3D vector
export type V3
  = { $: "V3", x: number, y: number, z: number };
\`\`\`

## V3/dot.ts

\`\`\`typescript
import { V3 } from "./_";

// Calculates the dot product of two 3D vectors
// - a: the first vector
// - b: the second vector
// = the dot product of a and b
export function dot(a: V3, b: V3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
\`\`\`

---

# NOTES

1. Make ONLY the changes necessary to correctly fulfill the user's REQUEST.

2. Do NOT fix, remove, complete or alter any parts unrelated to the REQUEST.

3. Pay attention to the user's style, and mimic it as close as possible.

4. Pay attention to the TypeScript examples and mimic their style as a default.

5. When defining local variables, align equal signs whenever possible.

6. Use CamelCase for types and underscore_case for everything else. (IMPORTANT)

7. Consult TypeScript guide to emit idiomatic correct code.

8. Do NOT use or assume the existence of files that weren't shown to you.

9. Be precise and careful in your modifications.

---

# TASK

You will now be given the actual INPUT you must work with.
`.trim();

const system_DepsPredictor = `
# ABOUT TypeScript FOR THE PROJECT

TypeScript is being used as a minimal functional programming language, where very file defines exactly ONE function, type or constant. For example:

'''
// Nat/add.ts: defines Nat addition

import { succ } from './succ' };
import { zero } from './zero' };
import { Nat } from './_' };
import { match } from './match' };

export function add(a: Nat, b: Nat): Nat {
  switch(a.type) {
    case 'succ':
      return succ(add(a.pred, b));
    case 'zero':
      return b;
  }
}
'''

The file above implements and exports the global Nat/add definition.

# INPUT

You will be given the NAME of a TypeScript file, its source code (which may be empty), and a list of ALL TypeScript definitions available in the stdlib.

# OUTPUT

You must answer with a list of definitions that are, or that you predict WILL BE used, directly or not, inside that TypeScript file. Answer in a <DEPENDENCIES/> tag.

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

- If the file is the constructor of an ADT, then, INCLUDE its type
  Example: 'List/cons' MUST include 'List'

- When in doubt, prefer to include MORE, rather than LESS, potencial dependencies.

- Try to include AT LEAST 4 dependencies, and AT MOST (only if needed) 16.

- Sometimes the user will give hints in the file. Follow them.
`.trim();

// Function to predict dependencies
async function predictDependencies(name, fileContent) {
  // Function to get all Typescript files recursively
 async function getAllTsFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await getAllTsFiles(res);
        return subFiles.length > 0 ? { name: entry.name, children: subFiles } : null;
      } else if (entry.name.endsWith('.ts')) {
        return { name: entry.name.replace('.ts', '') };
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

  const allFiles = await getAllTsFiles("./");
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

  const aiOutput = await chat(MODEL)(aiInput, { system: system_DepsPredictor, model: MODEL });
  console.clear();

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
  let cmd = `tsc ${file} --noEmit`;
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
    console.log("Usage: tscoder <file> <request> [<model>]");
    process.exit(1);
  }

  let file = process.argv[2];
  let request = process.argv[3] || "";
  let model = process.argv[4] || MODEL;

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
    request = ["Complete this file."].join('\n');
  }

  // If the file is empty, ask the AI to fill with an initial template
  if (fileContent.trim() === '') {
    fileContent = ["(empty file)"].join('\n');
  }

  // Extract the definition name from the file path
  let defName = file.replace('.ts', '');

  // Collect direct and indirect dependencies
  let deps;
  try {
    let { stdout } = await execAsync(`ts-deps ${file}`);
    deps = stdout.trim().split('\n');
  } catch (e) {
    deps = [];
  }

  // Predict additional dependencies
  const predictedDeps = await predictDependencies(defName, fileContent);

  deps = [...new Set([...deps, ...predictedDeps])];
  deps = deps.filter(dep => dep !== defName);

  // Read dependent files
  let depFiles = await Promise.all(deps.map(async (dep) => {
    let depPath, content;
    let path0 = path.join(dir, `${dep}.ts`);
    let path1 = path.join(dir, `${dep}/_.ts`); 
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
  await fs.writeFile('.tscoder', system_TsCoder + '\n\n' + aiInput, 'utf-8');

  // Call the AI model
  let aiOutput = await ask(aiInput, { system: system_TsCoder, model, system_cacheable: true });
  console.log("");


  //// Extract the result from AI output
  //let resultMatch = aiOutput.match(/<RESULT>([\s\S]*)<\/RESULT>/);
  //if (!resultMatch) {
    //console.error("Error: AI output does not contain a valid RESULT tag.");
    //process.exit(1);
  //}

  //let result = resultMatch[1].trim();

  //// Write the result back to the file
  //await fs.writeFile(file, result, 'utf-8');

  //PROBLEM: the script above has been written assuming the AI would output only
  //one result. Now, the system prompt has been updated, allowing it to emit an
  //arbitrary number of <FILE/> outputs. Refactor the commented-out code above,
  //in order to properly read all FILE that the AI output, and write them to the
  //correct location. As a safeguard, do NOT write files outside of the current
  //working directory. Rewrite the commented out code below:

  // Extract all FILE tags from AI output
  let fileMatches = aiOutput.matchAll(/<FILE path="([^"]+)">([\s\S]*?)<\/FILE>/g);
  let filesToWrite = Array.from(fileMatches, match => ({path: match[1], content: match[2].trim()}));

  if (filesToWrite.length === 0) {
    console.error("Error: AI output does not contain any valid FILE tags.");
    process.exit(1);
  }

  // Write each file
  for (let fileToWrite of filesToWrite) {
    let absolutePath = path.resolve(fileToWrite.path);
    let currentDir = process.cwd();

    // Check if the file is within the current working directory
    if (!absolutePath.startsWith(currentDir)) {
      console.error(`Error: Cannot write to file outside of current working directory: ${fileToWrite.path}`);
      continue;
    }

    try {
      await fs.writeFile(absolutePath, fileToWrite.content, 'utf-8');
      console.log(`File updated successfully: ${fileToWrite.path}`);
    } catch (error) {
      console.error(`Error writing file ${fileToWrite.path}: ${error.message}`);
    }
  }
}

// Run the main function and handle any errors
main().catch(console.error);

