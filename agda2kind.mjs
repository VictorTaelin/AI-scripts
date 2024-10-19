#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { chat, MODELS } from './Chat.mjs';

/*

// Included examples
const examples = [
  "Base/Bool/Bool",
  "Base/Bool/and",
  "Base/Bool/if",
  "Base/Maybe/Maybe",
  "Base/Nat/Nat",
  "Base/Nat/add",
  "Base/Nat/half",
  "Base/Nat/eq",
  "Base/List/List",
  "Base/List/head",
  "Base/List/fold",
  "Base/Bits/Bits",
  "Base/Bits/xor",
  "Base/Bits/eq",
  //"Base/Bits/normal",
  "Base/BinTree/BinTree",
  "Base/BinTree/count",
  "Base/Trait/Monad",
  "Base/Trait/Eq",
  //"Base/Parser/Examples/LambdaTerm/parse",
];

// Find the 'monobook' directory
async function findMonobookDir(currentDir) {
  while (path.basename(currentDir) !== 'monobook') {
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error('monobook directory not found');
    }
    currentDir = parentDir;
  }
  return currentDir;
}

// Loads an example from the 'monobook'.
async function load_example(name, ext) {
  const monobookDir = await findMonobookDir(process.cwd());
  const filePath = path.join(monobookDir, `${name}${ext}`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content;
  } catch (error) {
    console.error(`Error loading ${filePath}:`, error.message);
    return '';
  }
}

// System prompt
const SYSTEM_PROMPT = `
You are an expert Agda <-> Kind compiler. Your task is to translate Agda to/from Kind.

Follow these rules:

- Preserve the source algorithm form and structure as closely as possible.
- Represent Agda's 'Char' as a Kind 'U32', and Agda's 'String' as a Kind '(List U32)'.
- Always use holes ('_') for type parameters, since these can be inferred.
- Do not compile infix operators (like '+') to Kind. Just skip them completely.
- Always use kebab-case on Kind, just as in Agda. Do not use snake_case.

Avoid the following common errors:

- In Kind, do not start names with '_'. That parses as a hole.

About Kind:

Kind is a minimal proof language. Below are some idiomatic Kind examples.

${(await Promise.all(examples.map(async (example) => `
# ${example}.agda

\`\`\`agda
${(await load_example(example, '.agda')).trim()}
\`\`\`

# ${example}.kind

\`\`\`kind
${(await load_example(example, '.kind')).trim()}
\`\`\`
`))).join('\n')}

The examples above demonstrate the most idiomatic Kind style. When encountering
code that deviates from this style, update it to conform to these conventions.

Note that, sometimes, a draft will be provided. When that is the case, review it
for errors and oversights that violate the guides, and provide a final version.
Now, generate/update the last file marked as (missing) or (draft).
Answer in the EXACT following format:

# Path/to/file.xyz

\`\`\`lang
<updated_file_here>
\`\`\`

DONE.
`.trim();

console.log(SYSTEM_PROMPT);

*/

const SYSTEM_PROMPT = `
You are an expert Agda <-> Kind compiler. Your task is to translate Agda to/from Kind.

Follow these rules:

- Preserve the source algorithm form and structure as closely as possible.
- Represent Agda's 'Char' as a Kind 'U32', and Agda's 'String' as a Kind '(List U32)'.
- Always use holes ('_') for type parameters, since these can be inferred.
- Do not compile infix operators (like '+') to Kind. Just skip them completely.
- Always use kebab-case on Kind, just as in Agda. Do not use snake_case.

Avoid the following common errors:

- In Kind, do not start names with '_'. That parses as a hole.

About Kind:

Kind is a minimal proof language. Below are some idiomatic Kind examples.

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

# Base/Bool/Bool.kind

\`\`\`kind
use Base/Bool/ as B/

// Represents a Boolean value.
// - True: Represents logical truth.
// - False: Represents logical falsehood.
B/Bool : * = data[]{
  #True : B/Bool
  #False : B/Bool
}
\`\`\`

# Base/Bool/and.agda

\`\`\`agda
module Base.Bool.and where

open import Base.Bool.Bool

-- Performs logical AND operation on two boolean values.
-- - 1st: The boolean value.
-- - 2nd: The boolean value.
-- = True if both 1st and 2nd are true.
and : Bool → Bool → Bool
and True  b = b
and False b = False

-- Infix operator for and bitwise operator.
_&&_ : Bool → Bool → Bool
_&&_ = and

infixr 6 _&&_
\`\`\`

# Base/Bool/and.kind

\`\`\`kind
use Base/Bool/ as B/

// Performs logical AND operation on two boolean values.
// - 1st: The boolean value.
// - 2nd: The boolean value.
// = True if both 1st and 2nd are true, False otherwise.
B/and : B/Bool -> B/Bool -> B/Bool
| #True  b = b
| #False b = b
\`\`\`

# Base/Bool/if.agda

\`\`\`agda
module Base.Bool.if where

open import Base.Bool.Bool

-- Performs a conditional operation based on a boolean value.
-- - 1st: The boolean condition to evaluate.
-- - 2nd: The value to return if the condition is true.
-- - 3td: The value to return if the condition is false.
-- = The value of 2nd if 1st is true, 3td otherwise.
if_then_else_ : ∀ {a} {A : Set a} → Bool → A → A → A
if True  then t else _ = t
if False then _ else f = f

-- Infix operator for if-then-else conditional.
infix 0 if_then_else_
\`\`\`

# Base/Bool/if.kind

\`\`\`kind
use Base/Bool/ as B/

// Conditional expression.
// - 1st: The type of the result.
// - 2nd: The boolean condition to evaluate.
// - 3rd: The value to return if the condition is true.
// - 4th: The value to return if the condition is false.
// = Either 3rd or 4th, depending on the condition.
B/if : ∀(A: *) B/Bool -> A -> A -> A
| A #True  t f = t
| A #False t f = f
\`\`\`

# Base/Maybe/Maybe.agda

\`\`\`agda
module Base.Maybe.Maybe where

-- Represents an optional value.
-- - None: Represents the absence of a value.
-- - Some: Represents the presence of a value.
data Maybe {a} (A : Set a) : Set a where
  None : Maybe A
  Some : A → Maybe A
{-# BUILTIN MAYBE Maybe #-}
\`\`\`

# Base/Maybe/Maybe.kind

\`\`\`kind
use Base/Maybe/ as M/

// Represents an optional value.
// - None: Represents the absence of a value.
// - Some: Represents the presence of a value.
M/Maybe : * -> *
= λA data[]{
  #None : (M/Maybe A)
  #Some{ value: A } : (M/Maybe A)
}
\`\`\`

# Base/Nat/Nat.agda

\`\`\`agda
module Base.Nat.Nat where

-- Represents nats.
-- - Zero: The zero nat.
-- - Succ: The successor of a nat.
data Nat : Set where
  Zero : Nat
  Succ : Nat → Nat
{-# BUILTIN NATURAL Nat #-}
\`\`\`

# Base/Nat/Nat.kind

\`\`\`kind
use Base/Nat/ as N/

// Represents nats.
// - Zero: The zero nat.
// - Succ: The successor of a nat.
N/Nat : *
= data[]{
  #Zero : N/Nat
  #Succ{ pred: N/Nat } : N/Nat
}
\`\`\`

# Base/Nat/add.agda

\`\`\`agda
module Base.Nat.add where

open import Base.Nat.Nat

-- Performs addition of natural numbers..
-- - 1st: natural number.
-- - 2nd: natural number.
-- = The sum of 1st and 2nd.
add : Nat → Nat → Nat
add Zero     n = n
add (Succ m) n = Succ (add m n)

{-# BUILTIN NATPLUS add #-}

-- Infix operator for addition.
_+_ : Nat → Nat → Nat
_+_ = add

infixl 6 _+_
\`\`\`

# Base/Nat/add.kind

\`\`\`kind
use Base/Nat/ as N/

// Performs addition of nats.
// - m: The 1st nat.
// - n: The 2nd nat.
// = The sum of the two nats.
N/add : N/Nat -> N/Nat -> N/Nat
| #Zero    n = n
| #Succ{m} n = #Succ{(N/add m n)}
\`\`\`

# Base/Nat/half.agda

\`\`\`agda
module Base.Nat.half where

open import Base.Nat.Nat

-- Calculates half of a natural number.
-- 1st: The number to halve.
-- = The result of the division by 2, rounded down.
half : Nat → Nat
half Zero            = Zero
half (Succ Zero)     = Zero
half (Succ (Succ n)) = Succ (half n)
\`\`\`

# Base/Nat/half.kind

\`\`\`kind
use Base/Nat/ as N/

// Calculates half of a nat.
// - n: The number to halve.
// = The largest nat not exceeding n/2.
N/half : N/Nat -> N/Nat
| #Succ{#Succ{n}} = #Succ{(N/half n)}
| #Succ{n}        = #Zero
| #Zero           = #Zero
\`\`\`

# Base/Nat/eq.agda

\`\`\`agda
module Base.Nat.eq where

open import Base.Bool.Bool
open import Base.Nat.Nat

-- Checks if two natural numbers are equal.
-- - 1st: The natural number.
-- - 2nd: The natural number.
-- = True if the numbers are equal, False otherwise.
eq : Nat → Nat → Bool
eq Zero     Zero     = True
eq (Succ m) (Succ n) = eq m n
eq _        _        = False

{-# BUILTIN NATEQUALS eq #-}

-- Infix operator for equality comparison of natural numbers.
_==_ : Nat → Nat → Bool
_==_ = eq

infix 4 _==_

-- TODO: update the Kind version to use the equational style
\`\`\`

# Base/Nat/eq.kind

\`\`\`kind
use Base/Nat/ as N/
use Base/Bool/ as B/

// Checks if two natural numbers are equal.
// - m: The natural number.
// - n: The natural number.
// = True if the numbers are equal, False otherwise.
N/eq : N/Nat -> N/Nat -> B/Bool
| #Zero     #Zero    = #True
| #Succ{m}  #Succ{n} = (N/eq m n)
| x         y        = #False
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

# Base/List/List.kind

\`\`\`kind
use Base/List/ as L/

// A polymorphic List with two constructors:
// - Cons: Appends an element to a list.
// - Nil: The empty list.
L/List : * -> *
= λA data[]{
  #Nil{} : (L/List A)
  #Cons{ head:A tail:(L/List A) } : (L/List A)
}
\`\`\`

# Base/List/head.agda

\`\`\`agda
module Base.List.head where

open import Base.List.List
open import Base.Maybe.Maybe

-- Safely retrieves the 1st element of a list.
-- - A: The type of elements in the list.
-- - xs: The input list.
-- = Some x if the list is non-empty (where x is the 1st element),
--   None if the list is empty.
head : ∀ {A : Set} → List A → Maybe A
head []       = None
head (x :: _) = Some x
\`\`\`

# Base/List/head.kind

\`\`\`kind
use Base/List/ as L/
use Base/Maybe/ as M/

// Safely retrieves the 1st element of a list.
// - A: The type of elements in the list.
// - x: The input list.
// = Some x if the list is non-empty (where x is the 1st element),
//   None if the list is empty.
L/head : ∀(A: *) (L/List A) -> (M/Maybe A)
| A #Nil             = #None
| A #Cons{head tail} = #Some{ head }
\`\`\`

# Base/List/fold.agda

\`\`\`agda
module Base.List.fold where

open import Base.List.List

-- Performs a right fold over a list.
-- - A: The type of elements in the list.
-- - P: The type of the accumulator and result.
-- - xs: The input list.
-- - nil: The initial value for the accumulator.
-- - cons: The function to apply to each element and the accumulator.
-- = The result of folding the list.
fold : ∀ {a p} {A : Set a} {P : Set p} → List A → P → (A → P → P) → P
fold []        nil cons = nil
fold (x :: xs) nil cons = cons x (fold xs nil cons)
\`\`\`

# Base/List/fold.kind

\`\`\`kind
use Base/List/ as L/

// Performs a right fold over a list.
L/fold : ∀(A: *) (L/List A) -> ∀(P: *) P -> (A -> P -> P) -> P
| A #Nil{}           P nil cons = nil
| A #Cons{head tail} P nil cons = (cons head (L/fold A tail P nil cons))
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

# Base/Bits/Bits.kind

\`\`\`kind
use Base/Bits/ as BS/

// Represents a binary string.
// - O: Represents a zero bit.
// - I: Represents a one bit.
// - E: Represents the end of the binary string.
BS/Bits : *
= data[]{
  #O{ tail: BS/Bits } : BS/Bits
  #I{ tail: BS/Bits } : BS/Bits
  #E{} : BS/Bits
}
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
xor (O a) (O b) = O (xor a b)
xor (O a) (I b) = I (xor a b)
xor (I a) (O b) = I (xor a b)
xor (I a) (I b) = O (xor a b)
xor a     b     = E

-- Infix operator for bitwise XOR
_^_ : Bits → Bits → Bits
_^_ = xor

infixr 5 _^_

-- TODO: refactor the Kind version to use the equational style
\`\`\`

# Base/Bits/xor.kind

\`\`\`kind
use Base/Bits/ as BS/

// Performs bitwise XOR operation on two Bits values.
// - a: The 1st Bits value.
// - b: The 2nd Bits value.
// = A new Bits value representing the bitwise XOR of a and b.
BS/xor : BS/Bits -> BS/Bits -> BS/Bits
| #O{a}  #O{b} = #O{(BS/xor a b)}
| #O{a}  #I{b} = #I{(BS/xor a b)}
| #I{a}  #O{b} = #I{(BS/xor a b)}
| #I{a}  #I{b} = #O{(BS/xor a b)}
| a      b     = b
\`\`\`

# Base/Bits/eq.agda

\`\`\`agda
module Base.Bits.eq where

open import Base.Bits.Bits
open import Base.Bool.Bool

-- Checks if two Bits values are equal.
-- - a: The 1st Bits value.
-- - b: The 2nd Bits value.
-- = True if a and b are equal, False otherwise.
eq : Bits → Bits → Bool
eq E     E     = True
eq (O x) (O y) = eq x y
eq (I x) (I y) = eq x y
eq _     _     = False

infix 4 _==_
_==_ : Bits → Bits → Bool
_==_ = eq
\`\`\`

# Base/Bits/eq.kind

\`\`\`kind
use Base/Bits/ as BS/
use Base/Bool/ as B/

// Checks if two Bits values are equal.
// - a: The 1st Bits value.
// - b: The 2nd Bits value.
// = True if a and b are equal, False otherwise.
BS/eq : BS/Bits -> BS/Bits -> B/Bool
| #E    #E    = #True
| #O{x} #O{y} = (BS/eq x y)
| #I{x} #I{y} = (BS/eq x y)
| a     b     = #False
\`\`\`

# Base/BinTree/BinTree.agda

\`\`\`agda
module Base.BinTree.BinTree where

-- Defines a binary tree datatype.
-- - Node: Contains a value and two subtrees.
-- - Leaf: Represents an empty tree.
data BinTree (A : Set) : Set where
  Node : (val : A) → (lft : BinTree A) → (rgt : BinTree A) → BinTree A
  Leaf : BinTree A
\`\`\`

# Base/BinTree/BinTree.kind

\`\`\`kind
use Base/BinTree/ as BT/

// Defines a binary tree datatype.
// - Node: Contains a value and two subtrees.
// - Leaf: Represents an empty tree.
BT/BinTree : * -> *
= λA data[]{
  #Node{ val:A lft:(BT/BinTree A) rgt:(BT/BinTree A) } : (BT/BinTree A)
  #Leaf{} : (BT/BinTree A)
}
\`\`\`


# Base/BinTree/count.agda

\`\`\`agda
module Base.BinTree.count where

open import Base.BinTree.BinTree
open import Base.Bool.Bool
open import Base.Bool.if
open import Base.Nat.Nat
open import Base.Nat.add
open import Base.Trait.Eq

-- Counts the occurrences of a given value in a binary tree.
-- 1st: The value to count.
-- 2nd: The binary tree to search.
-- = The number of occurrences of the given value in the tree.
count : ∀ {A : Set} {{EqA : Eq A}} → A → BinTree A → Nat
count _ Leaf         = Zero
count x (Node y l r) = (if x == y then 1 else 0) + count x l + count x r

-- TODO: update the kind version to use the new equational style
\`\`\`

# Base/BinTree/count.kind

\`\`\`kind
use Base/BinTree/ as BT/
use Base/Bool/ as B/
use Base/Nat/ as N/
use Base/Trait/ as T/

// Counts the occurrences of a given value in a binary tree.
// - A: The type of elements in the tree.
// - e: An equality instance for type A.
// - x: The value to count.
// - t: The binary tree to search.
// = The number of occurrences of the given value in the tree.
BT/count : ∀(A: *) (T/Eq A) -> A -> (BT/BinTree A) -> N/Nat
| A e x #Leaf = #Zero
| A e x #Node{val lft rgt} =
  let is_equal  = (T/Eq/eq A e x val)
  let count_val = (B/if N/Nat is_equal #Succ{#Zero} #Zero)
  let count_lft = (BT/count A e x lft)
  let count_rgt = (BT/count A e x rgt)
  (N/add count_val (N/add count_lft count_rgt))
\`\`\`

---

The examples above demonstrate the most idiomatic Kind style. When encountering
code that deviates from this style, update it to conform to these conventions.

Note that, sometimes, a draft will be provided. When that is the case, review it
for errors and oversights that violate the guides, and provide a final version.
Now, generate/update the last file marked as (missing) or (draft).
Answer in the EXACT following format:

# Path/to/file.xyz

\`\`\`lang
<updated_file_here>
\`\`\`

DONE.
`.trim();

async function getDeps(file) {
  const ext = path.extname(file);
  let command = '';

  if (ext === '.agda') {
    command = `agda-deps ${file} --recursive`;
  } else if (ext === '.kind') {
    command = `kind-deps ${file} --recursive`;
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
    } else if (line.startsWith('```kind')) {
      inCodeBlock = true;
      currentLanguage = 'kind';
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
    console.log("Usage: agda2kind <Path/To/File.[agda|kind]> [<model>]");
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
    const targetExt = sourceExt === '.agda' ? '.kind' : '.agda';
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
      const sourceLanguage = sourceExt === '.agda' ? 'agda' : 'kind';
      const targetLanguage = targetExt === '.agda' ? 'agda' : 'kind';
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
  const mainLanguage = mainExt === '.agda' ? 'agda' : 'kind';
  context += `# ${inputFile}\n\n\`\`\`${mainLanguage}\n${mainFileContent}\n\`\`\`\n\n`;

  // Add the corresponding file for the input file as a draft if it exists, otherwise as (missing)
  const otherInputExt = mainExt === '.agda' ? '.kind' : '.agda';
  const otherInputFile = inputFile.replace(/\.[^.]+$/, otherInputExt);
  const otherInputLanguage = otherInputExt === '.agda' ? 'agda' : 'kind';
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
  const logDir = path.join(process.env.HOME || process.env.USERPROFILE, '.ai', 'agda2kind_history');
  await fs.mkdir(logDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const logFile = path.join(logDir, `${timestamp}_${model}.log`);
  await fs.writeFile(logFile, prompt);
  console.log(`Saved prompt log: ${logFile}`);
}

main().catch(console.error);
