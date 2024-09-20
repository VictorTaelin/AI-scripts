#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { chat, MODELS } from './Chat.mjs';

const SYSTEM_PROMPT = `
You are an expert Agda <-> TypeScript compiler. Your task is to translate Agda to/from TypeScript, following these rules:

- Represent datatypes as JSON objects with a '$' field for the constructor name.
- Compile curried functions to 2 versions: curried and uncurried (prefixed with $).
- When an application is saturated, use the uncurried version as an optimization.
- Compile equational pattern-matching to TypeScript switch statements.
- Implement identical algorithms, even if that involves redundant pattern-matches.
- Preserve type annotations, comments, names, and coding style as much as possible.

Avoid the following common errors:

- Do NOT use use special characters in TypeScript variable names (invalid syntax).

Examples:

# Base/Maybe/Type.agda

\`\`\`agda
module Base.Maybe.Type where

data Maybe {a} (A : Set a) : Set a where
  None : Maybe A
  Some : A → Maybe A
{-# BUILTIN MAYBE Maybe #-}
\`\`\`

# Base/Maybe/Type.ts

\`\`\`ts
export type Maybe<A>
  = { $: 'None' }
  | { $: 'Some', value: A };

export const $None = <A>(): Maybe<A> => ({ $: 'None' });
export const  None = $None;

export const $Some = <A>(value: A): Maybe<A> => ({ $: 'Some', value });
export const  Some = <A>(value: A) => $Some(value);
\`\`\`

# Base/List/Type.agda

\`\`\`agda
module Base.List.Type where

data List {a} (A : Set a) : Set a where
  []   : List A
  _::_ : (head : A) (tail : List A) → List A
{-# BUILTIN LIST List #-}

infixr 5 _::_
\`\`\`

# Base/List/Type.ts

\`\`\`ts
export type List<A>
  = { $: '[]' }
  | { $: '::', head: A, tail: List<A> };

export const $Nil = <A>(): List<A> => ({ $: '[]' });
export const  Nil = $nil;

export const $Cons = <A>(head: A, tail: List<A>): List<A> => ({ $: '::', head, tail });
export const  Cons = <A>(head: A) => (tail: List<A>) => $Cons(head, tail);
\`\`\`

# Base/List/head.agda

\`\`\`agda
module Base.List.head where

open import Base.List.Type
open import Base.Maybe.Type

head : ∀ {A : Set} → List A → Maybe A
head []       = None
head (x :: _) = Some x
\`\`\`

# Base/List/head.ts

\`\`\`ts
import { List } from '../Base/List/Type';
import { Maybe, Some, None } from '../Base/Maybe/Type';

export const $head = <A>(list: List<A>): Maybe<A> => {
  switch (list.$) {
    case '[]':
      return None();
    case '::':
      return Some(list.head);
  }
};

export const head = <A>(list: List<A>) => $head(list);
\`\`\`

# Base/Bits/Type.agda

\`\`\`agda
module Base.Bits.Type where

data Bits : Set where
  O : Bits → Bits
  I : Bits → Bits
  E : Bits
\`\`\`

# Base/Bits/Type.ts

\`\`\`ts
export type Bits
  = { $: 'O', bits: Bits }
  | { $: 'I', bits: Bits }
  | { $: 'E' };

export const $O = (bits: Bits): Bits => ({ $: 'O', bits });
export const  O = (bits: Bits) => $O(bits);

export const $I = (bits: Bits): Bits => ({ $: 'I', bits });
export const  I = (bits: Bits) => $I(bits);

export const $E = (): Bits => ({ $: 'E' });
export const  E = $E;
\`\`\`

# Base/Bits/xor.agda

\`\`\`agda
module Base.Bits.xor where

open import Base.Bits.Type

xor : Bits → Bits → Bits
xor E     E     = E
xor E     b     = b
xor a     E     = a
xor (O a) (O b) = O (xor a b)
xor (O a) (I b) = I (xor a b)
xor (I a) (O b) = I (xor a b)
xor (I a) (I b) = O (xor a b)

_^_ : Bits → Bits → Bits
_^_ = xor

infixr 5 _^_
\`\`\`

# Base/Bits/xor.ts

\`\`\`ts
import { Bits, O, I, E } from './Type';

export const $xor = (a: Bits, b: Bits): Bits => {
  switch (a.$) {
    case 'E': {
      switch (b.$) {
        case 'E':
          return E();
        default:
          return b;
      }
    }
    case 'O': {
      switch (b.$) {
        case 'E':
          return a;
        case 'O':
          return O($xor(a.bits, b.bits));
        case 'I':
          return I($xor(a.bits, b.bits));
      }
    }
    case 'I': {
      switch (b.$) {
        case 'E':
          return a;
        case 'O':
          return I($xor(a.bits, b.bits));
        case 'I':
          return O($xor(a.bits, b.bits));
      }
    }
  }
};

export const xor = (a: Bits) => (b: Bits) => $xor(a, b);
\`\`\`

---

Your goal is to generate each (missing) file, in the following format:

# <missing_file_path>

\`\`\`language
<generated_code>
\`\`\``.trim().replace(/'''/g, "```");

async function getDeps(file) {
  const ext = path.extname(file);
  let command = '';

  if (ext === '.agda') {
    command = `agda-deps ${file}`;
  } else if (ext === '.ts') {
    command = `ts-deps ${file}`;
  } else {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  try {
    const output = execSync(command, { encoding: 'utf-8' });
    return output.trim().split('\n').filter(x => x !== "");
  } catch (error) {
    console.error(`Error getting dependencies for ${file}:`, error.message);
    return [];
  }
}

async function readFileContent(filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    //console.error(`Error reading file ${filePath}:`, error.message);
    return '(missing)';
  }
}

async function main() {
  if (process.argv.length < 3) {
    console.log("Usage: agda2ts <Path/To/File.[agda|ts]> [<model>]");
    process.exit(1);
  }

  const inputFile = process.argv[2];
  const model = process.argv[3] || 'c'; // Default to Claude if no model is specified

  if (!MODELS[model]) {
    console.log(`Invalid model. Available models: ${MODELS.join(', ')}`);
    process.exit(1);
  }

  const deps = await getDeps(inputFile);
  console.log("->", deps);
  let context = '';

  for (const dep of deps) {
    console.log("- dep: " + dep);
    const fileContent = await readFileContent(dep);
    const ext = path.extname(dep);
    const language = ext === '.agda' ? 'agda' : 'ts';
    context += `# ${dep}\n\n\`\`\`${language}\n${fileContent}\n\`\`\`\n\n`;

    // Load corresponding TypeScript or Agda file if it exists
    const otherExt = ext === '.agda' ? '.ts' : '.agda';
    const otherFile = dep.replace(/\.[^.]+$/, otherExt);
    const otherContent = await readFileContent(otherFile);
    const otherLanguage = otherExt === '.agda' ? 'agda' : 'ts';
    context += `# ${otherFile}\n\n\`\`\`${otherLanguage}\n${otherContent}\n\`\`\`\n\n`;
  }

  const mainFileContent = await readFileContent(inputFile);
  const mainExt = path.extname(inputFile);
  const mainLanguage = mainExt === '.agda' ? 'agda' : 'ts';
  context += `# ${inputFile}\n\n\`\`\`${mainLanguage}\n${mainFileContent}\n\`\`\`\n\n`;

  // Add the corresponding file for the input file as (missing)
  const otherInputExt = mainExt === '.agda' ? '.ts' : '.agda';
  const otherInputFile = inputFile.replace(/\.[^.]+$/, otherInputExt);
  const otherInputLanguage = otherInputExt === '.agda' ? 'agda' : 'ts';
  context += `# ${otherInputFile}\n\n\`\`\`${otherInputLanguage}\n(missing)\n\`\`\`\n\n`;

  const ask = chat(model);
  const prompt = `${context}\n\nTranslate all (missing) files to their corresponding language now:`;

  // First step: Generate initial draft
  const initialResponse = await ask(prompt, { system: SYSTEM_PROMPT, model, system_cacheable: true });
  console.log("\n");

  // Parse the initial response
  const initialFiles = parseResponse(initialResponse);

  // Construct the context for the second step
  let draftContext = 'To help you, here is a DRAFT of the missing files compilation:\n\n';
  for (const file of initialFiles) {
    draftContext += `# ${file.path}\n\n\`\`\`${file.language}\n${file.code}\n\`\`\`\n\n`;
  }
  draftContext += 'Note that this draft may contain errors and oversights\n';
  draftContext += 'Use it as an inspiration to provide your final answer.\n';
  draftContext += 'Do it now:\n';

  // Second step: Generate final answer
  const finalPrompt = `${prompt}\n\n${draftContext}`;
  const finalResponse = await ask(finalPrompt, { system: SYSTEM_PROMPT, model, system_cacheable: true });
  console.log("\n");

  // Parse the final response and save the compiled outputs
  const finalFiles = parseResponse(finalResponse);

  for (const file of finalFiles) {
    const dirPath = path.dirname(file.path);
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(file.path, file.code);
    console.log(`Generated: ${file.path}`);
  }

  const outputContent = `${finalPrompt}\n\n${finalResponse}`;
  await fs.writeFile(`.output.txt`, outputContent);
  console.log(`Generated: .output.txt`);
}

function parseResponse(response) {
  const files = [];
  const lines = response.split('\n');
  let currentFile = null;
  let currentCode = '';
  let inCodeBlock = false;
  let currentLanguage = '';

  for (const line of lines) {
    if (line.startsWith('# ')) {
      if (currentFile) {
        files.push({ path: currentFile, code: currentCode.trim(), language: currentLanguage });
      }
      currentFile = line.slice(2).trim();
      currentCode = '';
      inCodeBlock = false;
    } else if (line.startsWith('```ts')) {
      inCodeBlock = true;
      currentLanguage = 'ts';
    } else if (line.startsWith('```agda')) {
      inCodeBlock = true;
      currentLanguage = 'agda';
    } else if (line.startsWith('```') && inCodeBlock) {
      inCodeBlock = false;
    } else if (inCodeBlock) {
      currentCode += line + '\n';
    }
  }

  if (currentFile) {
    files.push({ path: currentFile, code: currentCode.trim(), language: currentLanguage });
  }

  return files;
}

main().catch(console.error);
