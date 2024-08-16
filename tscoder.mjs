#!/usr/bin/env node

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import process from "process";
import { chat, MODELS, tokenCount } from './Chat.mjs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const DEPS_MODEL = "claude-3-5-sonnet-20240620"; // default model for dependency guessing
const CODE_MODEL = "claude-3-5-sonnet-20240620"; // default model for coding

// TsCoder System Prompt
// ---------------------

const system_TsCoder = `
# TSCODER

You are TsCoder, a TypeScript language coding assistant.

## INPUT: 

You will receive a TARGET <FILE/> in the TypeScript language, some additional <FILE/>'s for context, and a change or refactor <REQUEST/>, from the user.

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

<FILE path="/Users/v/vic/dev/tsbook/List/map.ts" TARGET>
// The map function for List, to be implemented
import { List } from "./_";

export function map<A, B>(fn: (a: A) => B, list: List<A>): List<B> {
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

- Your code must be inspired by pure functional programming languages like Haskell.

- Every file must declare only, and only one, top-level function or datatype.

- Functions must be pure, using switch instead of 'if-else' or 'case-of'.

- When defining local variables, align equal signs whenever possible.

- Use CamelCase for types and underscore_case for everything else. (IMPORTANT)

- A 'Foo/Bar' top-level definition must be either on './Foo/Bar.ts' or './Foo/Bar/_.ts'. 

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

### List/zip.ts

\`\`\`typescript
import { List } from "./_";

// Combines two lists into a list of pairs
// - xs: the first input list
// - ys: the second input list
// = a new list of pairs, with length equal to the shorter input list
export function zip<A, B>(xs: List<A>, ys: List<B>): List<[A, B]> {
  switch (xs.$) {
    case "Cons": {
      switch (ys.$) {
        case "Cons": {
          var head = [xs.head, ys.head] as [A,B];
          var tail = zip(xs.tail, ys.tail);
          return { $: "Cons", head, tail };
        }
        case "Nil": {
          return { $: "Nil" };
        }
      }
    }
    case "Nil": {
      return { $: "Nil" };
    }
  }
}
\`\`\`

### List/filter.ts

\`\`\`typescript
import { List } from "./_";

// Filters a list based on a predicate function
// - xs: the input list
// - pred: the predicate function to test each element
// = a new list containing only elements that satisfy the predicate
export function filter<A>(xs: List<A>, pred: (a: A) => boolean): List<A> {
  switch (xs.$) {
    case "Cons": {
      var head = xs.head;
      var tail = filter(xs.tail, pred);
      return pred(xs.head) ? { $: "Cons", head, tail } : tail;
    }
    case "Nil": {
      return { $: "Nil" };
    }
  }
}
\`\`\`

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

### V3/dot.ts

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

- Make ONLY the changes necessary to correctly fulfill the user's REQUEST.

- Do NOT fix, remove, complete or alter any parts unrelated to the REQUEST.

- Pay attention to the user's style, and mimic it as close as possible.

- Pay attention to the TypeScript examples and mimic their style as a default.

- Consult TypeScript guide to emit idiomatic correct code.

- Do NOT use or assume the existence of files that weren't shown to you.

- Be precise and careful in your modifications.

---

# TASK

You will now be given the actual INPUT you must work with.
`.trim();

// TsDepGuesser System Prompt
// --------------------------

const system_TsDepGuesser = `
# TSDEPGUESSER

You're TsDepGuesser, coding dependency predictor. You predict the dependencies of an incomplete TypeScript file.

## INPUT

You will be given:

1. The contents of a TypeScript file

2. Plus the complete file tree of this repository.

3. A request for refactor, coming from an user.

## OUTPUT

You must answer with:

1. A SHORT, single-paragraph <REASONING/>, justifying your predicted dependencies and reasoning.

2. A list of <DEPENDENCIES/> that might be used, directly or not, inside that TypeScript file.

# EXAMPLE

## Suppose you're given the following file:

<FILE path="/Users/v/vic/dev/tsbook/Nat/equal.ts">
// TODO: implement using 'compare'
function equal(a: Nat, b: Nat): boolean {
  ... TODO ...
}
</FILE>

<TREE>
- List/
  - _.ts
  - cons.ts
  - nil.ts
  - map.ts
  - fold.ts
  - filter.ts
  - equal.ts
  - zip.ts
  - length.ts
- Nat/
  - _.ts
  - fold.ts
  - succ.ts
  - zero.ts
  - compare.ts
  - add.ts
  - sub.ts
  - mul.ts
  - div.ts
  - mod.ts
- Bool/
  - _.ts
  - fold.ts
  - true.ts
  - false.ts
  - not.ts
  - and.ts
  - or.ts
</TREE>

<REQUEST>
implement equality for Nat
</REQUEST>

## Then, you must answer with the following output:

<REASONING>
Nat/equal.ts is likely to be a pairwise comparison between Nats. As such, it
must include the Nat type, as well as its constructor. It returns a Bool, so, it
must also include the boolean constructors. Since the source mentions 'compare',
I'll also include it. For completion, I've also included bool AND and OR, since
these are often used in comparisons. Finally, List/equal might be a similar
algorithms, so, I included it for inspiration.
</REASONING>

<DEPENDENCIES>
Nat/_.ts
Nat/succ.ts
Nat/zero.ts
Nat/match.ts
Nat/compare.ts
Bool/_.ts
Bool/true.ts
Bool/false.ts
Bool/match.ts
Bool/and.ts
Bool/or.ts
List/equal.ts
</DEPENDENCIES>

# GUIDE FOR PATHS

You're in functional TypeScript repository, where every file defines exactly ONE top-level definition, which can be a function, type or constant. For example, a List map function could be defined in the following file:

\`\`\`typescript
// ./List/map.ts

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
\`\`\`

As a convention, datatypes and entry files are defined on 'TypeName/_.ts' or 'LibName/_.ts'.

# NOTES

- Attempt to include ALL files that might be relevant, directly or not.

- Always include files that might be similar algorithms to the current one.
  Example: 'Map/set' MUST include 'Mat/get', because it is similar.

- If the file is the constructor of an ADT, then, INCLUDE its type.
  Example: 'List/cons' MUST include 'List', because it is the relevant type.

- When in doubt, always opt to include a file. More is better.

- Always try to include at least 4 dependencies, and at most 16.

- Sometimes, the user will give hints in the file. Follow them.
`.trim();

// Function to predict dependencies
async function predictDependencies(file, fileContent, request) {
  // Function to get all Typescript files recursively
  async function getAllTsFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await getAllTsFiles(res);
        return subFiles.length > 0 ? { name: entry.name, children: subFiles } : null;
      } else if (entry.name.endsWith('.ts')) {
        return { name: entry.name };
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

  const allFiles = (await getAllTsFiles("./")).filter(file => !file.name.includes('.backup') && !file.name.includes('node_modules'));
  const defsTree = buildTree(allFiles);

  const aiInput = [
    `<FILE path="${file}">`,
    fileContent.trim(),
    '</FILE>',
    '<TREE>',
    defsTree.trim(),
    '</TREE>',
    '<REQUEST>',
    request,
    '</REQUEST>'
  ].join('\n').trim();

  const ask = chat(DEPS_MODEL);
  const res = await ask(aiInput, { system: system_TsDepGuesser, model: DEPS_MODEL });
  console.log("");
  console.log("");
  //console.log(aiInput);
  //console.log(res);
  //process.exit();
  //console.clear();

  const dependenciesMatch = res.match(/<DEPENDENCIES>([\s\S]*)<\/DEPENDENCIES>/);
  if (!dependenciesMatch) {
    console.error("Error: AI output does not contain a valid DEPENDENCIES tag.");
    return [];
  }

  return dependenciesMatch[1].trim().split('\n').map(dep => dep.trim());
}

// Function to perform type checking based on file extension
// NOTE: not currently used
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
  let model = process.argv[4] || CODE_MODEL;

  // Initialize the chat function with the specified model
  let ask = chat(model);

  // Get directory and file information
  let dir = process.cwd();
  let fileContent;
  try {
    fileContent = await fs.readFile(file, 'utf-8');
  } catch (e) {
    fileContent = "";
  }

  // If the request is empty, replace it by a default request.
  if (request.trim() === '') {
    request = ["Complete the TARGET file."].join('\n');
  }

  // If the file is empty, ask the AI to fill with an initial template
  if (fileContent.trim() === '') {
    fileContent = ["(empty file)"].join('\n');
  }

  // Collect direct and indirect dependencies
  let deps, pred;
  try {
    let { stdout } = await execAsync(`ts-deps ${file}`);
    deps = stdout.trim().split('\n');
  } catch (e) {
    deps = [];
  }

  // Predict additional dependencies
  pred = await predictDependencies(file, fileContent, request);
  pred = pred.map(dep => dep.replace(/\.ts$/, '').replace(/\/_$/, ''));
  deps = [...new Set([...deps, ...pred])];
  deps = deps.filter(dep => !path.resolve(dep).startsWith(path.resolve(file.replace(".ts",""))));

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

  //console.log(dir, pred, deps, depFiles);
  //process.exit();

  // Perform initial type checking
  //let initialCheck = (await typeCheck(defName)).replace(/\x1b\[[0-9;]*m/g, '');

  // Prepare AI input
  let aiInput = [
    ...depFiles,
    `<FILE path="${file}" TARGET>`,
    fileContent,
    '</FILE>',
    //'<CHECKER>',
    //initialCheck,
    //'</CHECKER>',
    '<REQUEST>',
    request,
    '</REQUEST>'
  ].join('\n').trim();

  // Write a .prompt file with the system + aiInput strings
  await fs.writeFile('.tscoder', system_TsCoder + '\n\n' + aiInput, 'utf-8');

  // Call the AI model
  let res = await ask(aiInput, { system: system_TsCoder, model });
  console.log("\n");

  // Extract all FILE tags from AI output
  let fileMatches = res.matchAll(/<FILE path="([^"]+)">([\s\S]*?)<\/FILE>/g);
  let filesToWrite = Array.from(fileMatches, match => ({path: match[1], content: match[2].trim()}));

  if (filesToWrite.length === 0) {
    console.error("Error: AI output does not contain any valid FILE tags.");
    process.exit(1);
  }

  //// Write each file
  //for (let fileToWrite of filesToWrite) {
    //let absolutePath = path.resolve(fileToWrite.path);
    //let currentDir = process.cwd();

    //// Check if the file is within the current working directory
    //if (!absolutePath.startsWith(currentDir)) {
      //console.error(`Error: Cannot write to file outside of current working directory: ${fileToWrite.path}`);
      //continue;
    //}

    //try {
      //await fs.writeFile(absolutePath, fileToWrite.content, 'utf-8');
      //console.log(`File updated successfully: ${fileToWrite.path}`);
    //} catch (error) {
      //console.error(`Error writing file ${fileToWrite.path}: ${error.message}`);
    //}
  //}

  // PROBLEM: the code above overwrite files, which may cause data loss. Add a backup of each overwritten file to the ./backup directory. Note the path of the back-upped file (in the same line of the "file updated..." message). NOTE: the "backup created" message must be in the SAME LINE of the "file updated" message. i.e., it should show both paths on the message: the file updated, and its location inside the .backup dir.

  
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
      // Create backup directory if it doesn't exist
      const backupDir = path.join(currentDir, '.backup');
      await fs.mkdir(backupDir, { recursive: true });

      // Create backup file path
      const backupPath = path.join(backupDir, path.relative(currentDir, absolutePath));

      // Create necessary directories for backup file
      await fs.mkdir(path.dirname(backupPath), { recursive: true });

      // Backup existing file if it exists
      if (await fs.access(absolutePath).then(() => true).catch(() => false)) {
        await fs.copyFile(absolutePath, backupPath);
      }

      // Write the new content
      await fs.writeFile(absolutePath, fileToWrite.content, 'utf-8');
      
      console.log(`File updated successfully: ${fileToWrite.path}`);
    } catch (error) {
      console.error(`Error writing file ${fileToWrite.path}: ${error.message}`);
    }
  }
}

// Run the main function and handle any errors
main().catch(console.error);

