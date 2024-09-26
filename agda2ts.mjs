#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { chat, MODELS } from './Chat.mjs';

const SYSTEM_PROMPT = `
You are an expert Agda <-> TypeScript compiler. Your task is to translate Agda to/from TypeScript, following these rules:

- Represent datatypes as JSON objects with a '$' field for the constructor name.
- Compile curried functions to 2 versions: curried and uncurried (prefixed with $).
- Always prefer the uncurried version of constructors ($Foo), since it is faster.
- Compile equational pattern-matching to TypeScript switch statements.
- Implement identical algorithms, even if that involves redundant pattern-matches.
- Preserve type annotations, comments, names, and coding style as much as possible.
- Use 'var' instead of 'let', to preserve Agda's variable shadowing behavior.
- TypeScript names are snake_case. Use '_' instead of '-' in variable names.
- On ES6 imports, always use '..' to cd from current file to root path. Example:
  - 'Base/Foo/Bar/term.agda' needs '../../../' to reach root (depth 3).
  - 'Base/Foo/term.agda' needs '../../' to reach root (depth 2).
  - 'HVM1/Main.agda' needs '../' to reach root (depth 1).
  - 'Main.agda' is already on root (depth 0).
- Compile do-notation blocks to a flat chain of bind and pure calls.
- For the IO monad specifically, use async functions (it is just a Promise).

Avoid the following common errors:

- Do NOT use special characters in TypeScript variable names (invalid syntax).
- Do NOT translate infix operators to TypeScript. Just skip them entirely.
- Do NOT forget to import ALL terms you use, including constructors like '$Cons'.
- Do NOT attempt to emulate dependent types (with 'ReturnType') on TypeScript.
- Do NOT use CamelCase (except for types) on TypeScript. Vars use snake_case.
  NOTE: that file names are always kebab-case, even on TypeScript.
  Example: the 'Foo/Bar/do-thing.ts' file must export the 'do_thing' function.

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

- U64:
  - Is compiled to a BigInt.

- F64:
  - Is compiled to a native number.

All other inductive datatypes are compiled to JSON.

For efficiency, native types must use native operations when possible.
The original algorithm must be preserved as '$$foo'.

Examples:

# Base/Bool/Bool.agda

\`\`\`agda
module Base.Bool.Bool where

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

# Base/Bool/Bool.ts

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

open import Base.Bool.Bool

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
import { Bool, $True, $False } from '../../Base/Bool/Bool';

// Performs logical AND operation on two boolean values.
// - a: The first boolean value.
// - b: The second boolean value.
// = True if both a and b are true.
export const $$and = (a: Bool, b: Bool): Bool => {
  if (a) {
    return b;
  } else {
    return $False;
  }
};

// NOTE: Using native boolean AND for efficiency.
export const $and = (a: Bool, b: Bool): Bool => a && b;
export const  and = (a: Bool) => (b: Bool) => a && b;

// NOTE: Operator omitted: '_&&_'.
\`\`\`

# Base/Maybe/Maybe.agda

\`\`\`agda
module Base.Maybe.Maybe where

data Maybe {a} (A : Set a) : Set a where
  None : Maybe A
  Some : A → Maybe A
{-# BUILTIN MAYBE Maybe #-}
\`\`\`

# Base/Maybe/Maybe.ts

\`\`\`ts
export type Maybe<A>
  = { $: 'None' }
  | { $: 'Some', value: A };

export const $None: Maybe<never> = { $: 'None' };
export const  None: Maybe<never> = $None;

export const $Some = <A>(value: A): Maybe<A> => ({ $: 'Some', value });
export const  Some = <A>(value: A) => $Some(value);
\`\`\`

# Base/List/List.agda

\`\`\`agda
module Base.List.List where

-- A polymorphic List with two constructors:
-- - _::_ : Appends an element to a list.
-- - []  : The empty list.
data List {a} (A : Set a) : Set a where
  []   : List A
  _::_ : (head : A) (tail : List A) → List A
{-# BUILTIN LIST List #-}

infixr 5 _::_
\`\`\`

# Base/List/List.ts

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

open import Base.List.List
open import Base.Maybe.Maybe

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
import { List, $Cons, $Nil } from '../../Base/List/List';
import { Maybe, $None, $Some } from '../../Base/Maybe/Maybe';

// Safely retrieves the first element of a list.
// - xs: The input list.
// = Some x if the list is non-empty (where x is the first element),
//   None if the list is empty.
export const $head = <A>(xs: List<A>): Maybe<A> => {
  switch (xs.$) {
    case '[]':
      return $None;
    case '::':
      return $Some(xs.head);
  }
};

export const head = <A>(xs: List<A>) => $head(xs);
\`\`\`

# Base/String/String.agda

\`\`\`agda
module Base.String.String where
  
open import Base.Bool.Bool

postulate String : Set
{-# BUILTIN STRING String #-}
\`\`\`

# Base/String/String.ts

\`\`\`ts
// Represents a string of characters.
export type String = string;

// NOTE: Using native string to represent String.
\`\`\`

# Base/String/from-char.agda

\`\`\`agda
module Base.String.from-char where

open import Base.Char.Char
open import Base.List.List
open import Base.String.String
open import Base.String.from-list

-- Converts a character to a string
-- - c: The input character.
-- = A string containing only the input character.
from-char : Char → String
from-char c = from-list (c :: [])
\`\`\`

# Base/String/from-char.ts

\`\`\`ts
import { Char } from '../../Base/Char/Char';
import { String } from '../../Base/String/String';
import { $Cons, $Nil } from '../../Base/List/List';
import { $from_list } from '../../Base/String/from-list';

// Converts a character to a string
// - c: The input character.
// = A string containing only the input character.
export const $$from_char = (c: Char): String => {
  return $from_list($Cons(c, $Nil));
};

// NOTE: Return the character directly for efficiency.
export const $from_char = (c: Char): String => c;
export const  from_char = (c: Char) => c;
\`\`\`

# Base/Bits/Bits.agda

\`\`\`agda
module Base.Bits.Bits where

-- Represents a binary string.
-- - O: Represents a zero bit.
-- - I: Represents a one bit.
-- - E: Represents the end of the binary string.
data Bits : Set where
  O : (tail : Bits) → Bits
  I : (tail : Bits) → Bits
  E : Bits
\`\`\`

# Base/Bits/Bits.ts

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

open import Base.Bits.Bits

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
import { Bits, $O, $I, $E } from '../../Base/Bits/Bits';

// Performs bitwise XOR operation on two Bits values.
// - a: The 1st Bits value.
// - b: The 2nd Bits value.
// = A new Bits value representing the bitwise XOR of a and b.
export const $xor = (a: Bits, b: Bits): Bits => {
  switch (a.$) {
    case 'E':
      switch (b.$) {
        case 'E':
          return $E;
        default:
          return b;
      }
    case 'O':
      switch (b.$) {
        case 'E':
          return a;
        case 'O':
          return $O($xor(a.tail, b.tail));
        case 'I':
          return $I($xor(a.tail, b.tail));
      }
    case 'I':
      switch (b.$) {
        case 'E':
          return a;
        case 'O':
          return $I($xor(a.tail, b.tail));
        case 'I':
          return $O($xor(a.tail, b.tail));
      }
  }
};

export const xor = (a: Bits) => (b: Bits) => $xor(a, b);

// NOTE: Operator omitted: '_^_'.
\`\`\`

# Base/Nat/Nat.agda:

\`\`\`agda
module Base.Nat.Nat where

data Nat : Set where
  Zero : Nat
  Succ : Nat → Nat

{-# BUILTIN NATURAL Nat #-}
\`\`\`

# Base/Nat/Nat.ts

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

open import Base.Nat.Nat

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
import { Nat, $Succ, $Zero } from '../../Base/Nat/Nat';

// Addition of nats.
// - m: The 1st nat.
// - n: The 2nd nat.
// = The sum of m and n.
export const $$add = (m: Nat, n: Nat): Nat => {
  if (m === 0n) {
    return n;
  } else {
    var m_ = m - 1n;
    return $Succ($add(m_, n));
  }
};

// NOTE: Native BigInt addition used for efficiency.
export const $add = (m: Nat, n: Nat): Nat => m + n;
export const  add = (m: Nat) => (n: Nat) => m + n;
\`\`\`

# Base/Parser/Examples/LambdaTerm/parse.agda

\`\`\`agda
module Base.Parser.Examples.LambdaTerm.parse where

open import Base.Function.case
open import Base.Maybe.Maybe
open import Base.Parser.Examples.LambdaTerm.LambdaTerm
open import Base.Parser.Monad.bind
open import Base.Parser.Monad.pure
open import Base.Parser.State
open import Base.Parser.Parser
open import Base.Parser.consume
open import Base.Parser.parse-name
open import Base.Parser.peek-one
open import Base.Parser.skip-trivia
open import Base.String.String

parse : Parser Term
parse = do
  skip-trivia
  one ← peek-one
  case one of λ where
    (Some 'λ') → do
      consume "λ"
      name ← parse-name
      body ← parse
      pure (Lam name body)
    (Some '(') → do
      consume "("
      func ← parse
      argm ← parse
      consume ")"
      pure (App func argm)
    _ → do
      name ← parse-name
      pure (Var name)
\`\`\`

# Base/Parser/Examples/LambdaTerm/parse.agda

\`\`\`ts
import { Maybe, $Some, $None } from '../../../../Base/Maybe/Maybe';
import { Term, $Lam, $App, $Var } from '../../../../Base/Parser/Examples/LambdaTerm/LambdaTerm';
import { $bind, bind } from '../../../../Base/Parser/Monad/bind';
import { $pure } from '../../../../Base/Parser/Monad/pure';
import { State } from '../../../../Base/Parser/State';
import { Parser } from '../../../../Base/Parser/Parser';
import { $consume } from '../../../../Base/Parser/consume';
import { $parse_name } from '../../../../Base/Parser/parse-name';
import { $peek_one } from '../../../../Base/Parser/peek-one';
import { $skip_trivia } from '../../../../Base/Parser/skip-trivia';
import { String } from '../../../../Base/String/String';

export const $parse: Parser<Term> = 
  $bind($skip_trivia, () =>
  $bind($peek_one, (one: Maybe<String>) => {
    switch (one.$) {
      case 'Some':
        switch (one.value) {
          case 'λ':
            return (
              $bind($consume('λ'), () =>
              $bind($parse_name, (name: String) =>
              $bind($parse, (body: Term) =>
              $pure($Lam(name, body))))));
          case '(':
            return (
              $bind($consume('('), () =>
              $bind($parse, (func: Term) =>
              $bind($parse, (argm: Term) =>
              $bind($consume(')'), () =>
              $pure($App(func, argm)))))));
          default:
            return (
              $bind($parse_name, (name: String) =>
              $pure($Var(name))));
        }
      case 'None':
        return (
          $bind($parse_name, (name: String) =>
          $pure($Var(name))));
    }
  }));

export const parse: Parser<Term> = (s: State) => $parse(s);
\`\`\`

# Main.agda

\`\`\`agda
module Main where

open import Base.ALL

loop : Nat -> IO Unit
loop i = do
  IO.print ("Hello " <> show i)
  loop (i + 1)

main : IO Unit
main = loop 0
\`\`\`

# Main.ts

\`\`\`ts
import { Nat, IO, Unit, String } from './Base/ALL';

const $loop = (i: Nat): IO<Unit> => async () => {
  await IO.$print(String.$append("Hello ", Nat.$show(i)))();
  return $loop(Nat.$add(i, 1n))();
};

export const $main: IO<Unit> = $loop(0n);
export const  main: IO<Unit> = $main;
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
    command = `agda-deps ${file} --recursive`;
  } else if (ext === '.ts') {
    command = `ts-deps ${file} --recursive`;
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

    //console.log(dep, !!sourceContent, !!targetContent);

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
  
  // Save the final prompt to a log file
  const logDir = path.join(process.env.HOME || process.env.USERPROFILE, '.ai', 'agda2ts_history');
  await fs.mkdir(logDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const logFile = path.join(logDir, `${timestamp}_${model}.log`);
  await fs.writeFile(logFile, prompt);
  console.log(`Saved prompt log: ${logFile}`);
}

main().catch(console.error);

