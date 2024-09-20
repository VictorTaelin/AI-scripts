#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { chat, MODELS } from './Chat.mjs';

const SYSTEM_PROMPT = `
You are an expert Agda <-> TypeScript compiler. Your task is to translate Agda to/from TypeScript, following these rules:

- Represent datatypes as JSON objects with a '$' field for the constructor name.
- Compile curried functions to 2 versions: curried and uncurried (prefixed with $).
- Whenever possible, use the uncurried version, since it is much faster.
- Compile equational pattern-matching to TypeScript switch statements.
- Implement identical algorithms, even if that involves redundant pattern-matches.
- Preserve type annotations, comments, names, and coding style as much as possible.
- Use 'var' instead of 'let', to preserve Agda's variable shadowing behavior.
- On ES6 imports, for consistency, always use '..' to reach the root path.

Avoid the following common errors:

- Do NOT use use special characters in TypeScript variable names (invalid syntax).
- Do NOT translate infix operators to TypeScript. Just skip them entirely.
- Do NOT forget to import ALL terms you use, including constructors like '$Cons'.
- Do NOT attempt to emulate dependent types (with 'ReturnType') on TypeScript.

Native types must NOT be compiled to JSON.

- Bool:
  - 'True' becomes 'true'.
  - 'False' becomes 'false'.
  - Pattern-match: 'if (x) { ... true-case ... } else { ... false-case ... }'.

- Nat:
  - 'Zero' becomes '0n'.
  - '(Succ x)' becomes '1n+x'.
  - Pattern-match: 'if (x === 0n) { ... zero-case ...  } else { var pred = x - 1n; ... succ-case ...  }'.

- Int:
  - Is compiled to a BigInt.

- Sigma<A,B> and Pair<A,B>:
  - Both are compiled to just [A,B].
  - When B depends on A, we just default to 'any' instead.

- Char:
  - Char literals are preserved as-is.

- String:
  - String literals are preserved as-is.
  - Pattern-match: 'if (x === "") { ... nil-case ... } else { var head = x[0]; var tail = x.slice(1); ... }'.

The U64 and F64 types are also compiled to native types.
All other inductive datatypes are compiled to JSON.

For efficiency, native types must use native operations when possible.
The original algorithm must be preserved as '$$foo'.

Examples:

# Base/Bool/Type.agda

\`\`\`agda
module Base.Bool.Type where

-- Represents a Boolean value.
-- - True: Represents logical truth.
-- - False: Represents logical falsehood.
data Bool : Set where
  True  : Bool
  False : Bool
{-# BUILTIN BOOL  Bool  #-}
{-# BUILTIN TRUE  True  #-}
{-# BUILTIN FALSE False #-}
\`\`\`

# Base/Bool/Type.ts

\`\`\`ts
// Represents a Boolean value.
export type Bool = boolean;

// - True: Represents logical truth.
export const $True: Bool = true;
export const  True: Bool = true;

// - False: Represents logical falsehood.
export const $False: Bool = false;
export const  False: Bool = false;

// NOTE: Using native boolean to represent Bool.
\`\`\`

# Base/Bool/and.agda

\`\`\`agda
module Base.Bool.and where

open import Base.Bool.Type

-- Performs logical AND operation on two boolean values.
-- - a: The first boolean value.
-- - b: The second boolean value.
-- = True if both a and b are true.
and : Bool → Bool → Bool
and True  b = b
and False b = False

_&&_ : Bool → Bool → Bool
_&&_ = and

infixr 6 _&&_
\`\`\`

# Base/Bool/and.ts

\`\`\`ts
import { Bool } from '../../Base/Bool/Type';

// Performs logical AND operation on two boolean values.
// - a: The first boolean value.
// - b: The second boolean value.
// = True if both a and b are true.
export const $$and = (a: Bool, b: Bool): Bool => {
  if (a) {
    return b;
  } else {
    return false;
  }
};

// NOTE: Using native boolean AND for efficiency.
export const $and = (a: Bool, b: Bool): Bool => a && b;
export const  and = (a: Bool) => (b: Bool) => a && b;

// NOTE: Operator omitted: '_&&_'.
\`\`\`

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

export const $None: Maybe<never> = { $: 'None' };
export const  None: Maybe<never> = $None;

export const $Some = <A>(value: A): Maybe<A> => ({ $: 'Some', value });
export const  Some = <A>(value: A) => $Some(value);
\`\`\`

# Base/List/Type.agda

\`\`\`agda
module Base.List.Type where

-- A polymorphic List with two constructors:
-- - _::_ : Appends an element to a list.
-- - []  : The empty list.
data List {a} (A : Set a) : Set a where
  []   : List A
  _::_ : (head : A) (tail : List A) → List A
{-# BUILTIN LIST List #-}

infixr 5 _::_
\`\`\`

# Base/List/Type.ts

\`\`\`ts
// A polymorphic List with two constructors:
// - [] : The empty list.
// - _::_ : Appends an element to a list.
export type List<A>
  = { $: '[]' }
  | { $: '::', head: A, tail: List<A> };

export const $Nil: List<never> = { $: '[]' };
export const  Nil: List<never> = $Nil;

export const $Cons = <A>(head: A, tail: List<A>): List<A> => ({ $: '::', head, tail });
export const  Cons = <A>(head: A) => (tail: List<A>) => $Cons(head, tail);

// NOTE: constructor '[]' renamed to 'Nil'.
// NOTE: constructor '_::_' renamed to 'Cons'.
\`\`\`

# Base/List/head.agda

\`\`\`agda
module Base.List.head where

open import Base.List.Type
open import Base.Maybe.Type

-- Safely retrieves the first element of a list.
-- - xs: The input list.
-- = Some x if the list is non-empty (where x is the first element),
--   None if the list is empty.
head : ∀ {A : Set} → List A → Maybe A
head []       = None
head (x :: _) = Some x
\`\`\`

# Base/List/head.ts

\`\`\`ts
import { List } from '../../Base/List/Type';
import { Maybe, None, Some } from '../../Base/Maybe/Type';

// Safely retrieves the first element of a list.
// - xs: The input list.
// = Some x if the list is non-empty (where x is the first element),
//   None if the list is empty.
export const $head = <A>(xs: List<A>): Maybe<A> => {
  switch (xs.$) {
    case '[]':
      return None;
    case '::':
      return Some(xs.head);
  }
};

export const head = <A>(xs: List<A>) => $head(xs);
\`\`\`

# Base/Bits/Type.agda

\`\`\`agda
module Base.Bits.Type where

-- Represents a binary string.
-- - O: Represents a zero bit.
-- - I: Represents a one bit.
-- - E: Represents the end of the binary string.
data Bits : Set where
  O : (tail : Bits) → Bits
  I : (tail : Bits) → Bits
  E : Bits
\`\`\`

# Base/Bits/Type.ts

\`\`\`ts
// Represents a binary string.
// - O: Represents a zero bit.
// - I: Represents a one bit.
// - E: Represents the end of the binary string.
export type Bits
  = { $: 'O', tail: Bits }
  | { $: 'I', tail: Bits }
  | { $: 'E' };            

export const $O = (tail: Bits): Bits => ({ $: 'O', tail });
export const  O = (tail: Bits): Bits => $O(tail);

export const $I = (tail: Bits): Bits => ({ $: 'I', tail });
export const  I = (tail: Bits): Bits => $I(tail);

export const $E: Bits = { $: 'E' };
export const  E: Bits = $E;
\`\`\`

# Base/Bits/xor.agda

\`\`\`agda
module Base.Bits.xor where

open import Base.Bits.Type

-- Performs bitwise XOR operation on two Bits values.
-- - a: The 1st Bits value.
-- - b: The 2nd Bits value.
-- = A new Bits value representing the bitwise XOR of a and b.
xor : Bits → Bits → Bits
xor E     E     = E
xor E     b     = b
xor a     E     = a
xor (O a) (O b) = O (xor a b)
xor (O a) (I b) = I (xor a b)
xor (I a) (O b) = I (xor a b)
xor (I a) (I b) = O (xor a b)

-- Infix operator for bitwise XOR
_^_ : Bits → Bits → Bits
_^_ = xor

infixr 5 _^_
\`\`\`

# Base/Bits/xor.ts

\`\`\`ts
import { Bits, O, I, E } from '../../Base/Bits/Type';

// Performs bitwise XOR operation on two Bits values.
// - a: The 1st Bits value.
// - b: The 2nd Bits value.
// = A new Bits value representing the bitwise XOR of a and b.
export const $xor = (a: Bits, b: Bits): Bits => {
  switch (a.$) {
    case 'E':
      switch (b.$) {
        case 'E':
          return E;
        default:
          return b;
      }
    case 'O':
      switch (b.$) {
        case 'E':
          return a;
        case 'O':
          return O($xor(a.tail, b.tail));
        case 'I':
          return I($xor(a.tail, b.tail));
      }
    case 'I':
      switch (b.$) {
        case 'E':
          return a;
        case 'O':
          return I($xor(a.tail, b.tail));
        case 'I':
          return O($xor(a.tail, b.tail));
      }
  }
};

export const xor = (a: Bits) => (b: Bits) => $xor(a, b);

// NOTE: Operator omitted: '_^_'.
\`\`\`

# Base/Nat/Type.agda:

\`\`\`agda
module Base.Nat.Type where

data Nat : Set where
  Zero : Nat
  Succ : Nat → Nat

{-# BUILTIN NATURAL Nat #-}
\`\`\`

# Base/Nat/Type.ts

\`\`\`ts
export type Nat = bigint;

export const $Zero: Nat = 0n;
export const  Zero: Nat = 0n;

export const $Succ = (n: Nat): Nat => 1n + n;
export const  Succ = (n: Nat) => $Succ(n);

// NOTE: Using native BigInt to represent Nat.
\`\`\`

# Base/Nat/add.agda

\`\`\`agda
module Base.Nat.add where

open import Base.Nat.Type

-- Addition of nats.
-- - m: The 1st nat.
-- - n: The 2nd nat.
-- = The sum of m and n.
add : Nat → Nat → Nat
add Zero     n = n
add (Succ m) n = Succ (add m n)

_+_ : Nat → Nat → Nat
_+_ = add

{-# BUILTIN NATPLUS _+_ #-}
\`\`\`

# Base/Nat/add.ts

\`\`\`ts
import { Nat } from './../../Base/Nat/Type';

// Addition of nats.
// - m: The 1st nat.
// - n: The 2nd nat.
// = The sum of m and n.
export const $$add = (m: Nat, n: Nat): Nat => {
  if (m === 0n) {
    return n;
  } else {
    var m_ = m - 1n;
    return 1n + $add(m_, n);
  }
};

// NOTE: Native BigInt addition used for efficiency.
export const $add = (m: Nat, n: Nat): Nat => m + n;
export const  add = (m: Nat) => (n: Nat) => m + n;
\`\`\`

---

Note that, sometimes, a draft will be provided. When that is the case, review it
for errors and oversights that violate the guides, and provide a final version.
Now, generate/update the last file marked as (missing) or (draft). Answer with:

# Path/to/file.xyz

\`\`\`lang
<updated_file_here>
\`\`\`
`.trim();


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
    console.log(`Invalid model. Available models: ${Object.keys(MODELS).join(', ')}`);
    process.exit(1);
  }

  const deps = (await getDeps(inputFile)).filter(x => x.slice(0,5) != "Agda/");
  let context = '';
  const missingDeps = [];

  for (const dep of deps) {
    const sourceExt = path.extname(inputFile);
    const targetExt = sourceExt === '.agda' ? '.ts' : '.agda';
    const sourceFile = dep;
    const targetFile = dep.replace(/\.[^.]+$/, targetExt);

    const sourceContent = await readFileContent(sourceFile);
    const targetContent = await readFileContent(targetFile);

    if (sourceContent === '(missing)') {
      missingDeps.push(sourceFile);
    } else if (targetContent === '(missing)') {
      missingDeps.push(targetFile);
    } else {
      const sourceLanguage = sourceExt === '.agda' ? 'agda' : 'ts';
      const targetLanguage = targetExt === '.agda' ? 'agda' : 'ts';
      context += `# ${sourceFile}\n\n\`\`\`${sourceLanguage}\n${sourceContent}\n\`\`\`\n\n`;
      context += `# ${targetFile}\n\n\`\`\`${targetLanguage}\n${targetContent}\n\`\`\`\n\n`;
    }
  }

  if (missingDeps.length > 0) {
    console.error("ERROR: Missing dependencies. Generate these files first:");
    missingDeps.forEach(dep => console.error(`- ${dep}`));
    process.exit(1);
  }

  const mainFileContent = await readFileContent(inputFile);
  const mainExt = path.extname(inputFile);
  const mainLanguage = mainExt === '.agda' ? 'agda' : 'ts';
  context += `# ${inputFile}\n\n\`\`\`${mainLanguage}\n${mainFileContent}\n\`\`\`\n\n`;

  // Add the corresponding file for the input file as a draft if it exists, otherwise as (missing)
  const otherInputExt = mainExt === '.agda' ? '.ts' : '.agda';
  const otherInputFile = inputFile.replace(/\.[^.]+$/, otherInputExt);
  const otherInputLanguage = otherInputExt === '.agda' ? 'agda' : 'ts';
  const otherInputContent = await readFileContent(otherInputFile);
  
  if (otherInputContent !== '(missing)') {
    context += `# ${otherInputFile} (draft)\n\n\`\`\`${otherInputLanguage}\n${otherInputContent}\n\`\`\`\n\n`;
  } else {
    context += `# ${otherInputFile} (missing)\n\n\`\`\`${otherInputLanguage}\n...\n\`\`\`\n\n`;
  }

  const ask = chat(model);
  const prompt = `${context}\n\nGenerate or update the file marked as (missing) or (draft) now:`;

  // Generate and save the compiled output
  const response = await ask(prompt, { system: SYSTEM_PROMPT, model, system_cacheable: true });
  console.log("\n");

  const files = parseResponse(response);

  for (const file of files) {
    if (path.extname(file.path) === otherInputExt) {
      const dirPath = path.dirname(file.path);
      await fs.mkdir(dirPath, { recursive: true });
      await fs.writeFile(file.path, file.code);
      console.log(`Saved: ${file.path}`);
    }
  }
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

