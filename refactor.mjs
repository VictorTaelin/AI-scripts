import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import process from "process";
import { chat, MODELS, tokenCount } from './Chat.mjs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// System prompt for the AI model, defining its role and behavior
const system = `
You are a file refactoring tool.

- INPUT: You will receive a FILE and a change REQUEST.

- OUTPUT: You must answer with the changed file inside <RESULT></RESULT> tags.

# GUIDE FOR REFACTORING

1. Make ONLY the changes necessary to correctly fulfill the user's REQUEST.
2. Do NOT fix, remove, complete, or alter any parts unrelated to the REQUEST.
3. Do not include any additional comments, explanations, or text outside of the RESULT tags.
4. NEVER assume information you don't have. ALWAYS request files to make sure.
5. Preserve the same indentation and style of the current file.
6. Be precise and careful in your modifications.

# GUIDE FOR NAVIGATING

In some cases, you WILL need additional context to fulfill a request. When that is the case, do NOT attempt to refactor the file immediatelly. Instead, ask for additional files inside <SHOW></SHOW> tags, as follows:

<SHOW>
["./README.md", "./src/some_file.js", "./src/some_dir"]
</SHOW>

You can ask for information as many times as you want.

# EXAMPLE

Below is a complete example of how you should interact with the user.

## User:

<DIR path="/Users/v/dev/nat-lib" current>
Bool.agda
Nat.agda
is_zero.agda
</DIR>

<FILE path="./is_zero.agda" current>
module is_zero where
open import Nat
open import Bool

is_zero : Nat -> Bool
is_zero n = ?
</FILE>

<REQUEST>
case-split on n
</REQUEST>

## You:

<REQUEST>
["./Nat.agda"]
</REQUEST>

## User:

<FILE path="./Nat.agda">
module Nat where

data Nat : Set where
  zero : Nat
  succ : Nat → Nat

open Nat public using (Nat; zero; succ)
</FILE>

## You:

<RESULT>
module is_zero where

open import Nat
open import Bool

is_zero : Nat -> Bool
is_zero zero     = ?
is_zero (succ n) = ?
</RESULT>

## User:

<REQUEST>
complete it
</REQUEST>

## You:

<REQUEST>
["/.Bool.agda"]
</REQUEST>

## User:

<FILE path="./Bool.agda">
module Bool where

data Bool : Set where
  true  : Bool
  false : Bool

open Bool public using (Bool; true; false)
</FILE>

## You:

<RESULT>
module is_zero where

open import Nat
open import Bool

is_zero : Nat -> Bool
is_zero zero     = true
is_zero (succ n) = false
</RESULT>
`;

// Main function to handle the refactoring process
async function main() {
  // Check for correct usage and parse command-line arguments
  if (process.argv.length < 3) {
    console.log("Usage: refactor <file> <request> [<model>] [--check]");
    process.exit(1);
  }

  const file = process.argv[2];
  const request = process.argv[3];
  const model = process.argv[4] || "s";
  const check = process.argv.includes("--check");

  // Initialize the chat function with the specified model
  const ask = chat(model);

  // Get directory and file information
  const dir = path.dirname(file);
  const fileContent = await fs.readFile(file, 'utf-8');
  const dirContent = await fs.readdir(dir);

  // Prepare initial input for the AI
  let aiInput = `<DIR path="${dir}" current>\n${dirContent.join('\n')}\n</DIR>\n\n<FILE path="${file}" current>\n${fileContent}\n</FILE>\n\n<REQUEST>\n${request}\n</REQUEST>`;

  // If --check flag is present, perform initial type check
  if (check) {
    const initialCheck = await typeCheck(file);
    aiInput += `\n\n<CHECK>\n${initialCheck || 'No errors.'}\n</CHECK>`;
  }

  // Main interaction loop with the AI
  while (true) {
    console.log("");
    const aiOutput = await ask(aiInput, { system, model });
    
    // Handle AI's request for additional information
    if (aiOutput.includes("<SHOW>")) {
      const showMatch = aiOutput.match(/<SHOW>([\s\S]*?)<\/SHOW>/);
      if (showMatch) {
        const filesToShow = JSON.parse(showMatch[1]);
        let showContent = "";
        for (const fileToShow of filesToShow) {
          const fullPath = path.resolve(dir, fileToShow);
          if (await fs.stat(fullPath).then(stat => stat.isDirectory())) {
            const dirContent = await fs.readdir(fullPath);
            showContent += `<DIR path="${fullPath}">\n${dirContent.join('\n')}\n</DIR>\n`;
          } else {
            const content = await fs.readFile(fullPath, 'utf-8');
            showContent += `<FILE path="${fullPath}">\n${content}\n</FILE>\n`;
          }
        }
        aiInput = showContent;
      }
    } 
    // Handle AI's refactoring result
    else if (aiOutput.includes("<RESULT>")) {
      const resultMatch = aiOutput.match(/<RESULT>([\s\S]*?)<\/RESULT>/);
      if (resultMatch) {
        const newContent = resultMatch[1];
        await fs.writeFile(file, newContent.trim(), 'utf-8');
        console.log("\nFile refactored successfully.");
        
        // If --check flag is present, perform type check on the refactored file
        if (check) {
          const checkResult = await typeCheck(file);
          if (checkResult) {
            aiInput = `<FILE path="${file}" current>\n${newContent.trim()}\n</FILE>\n\n<REQUEST>\nFix this file.\n</REQUEST>\n\n<CHECK>\n${checkResult}\n</CHECK>`;
            continue;
          }
        }
        break;
      }
    }
  }
}

// Function to perform type checking based on file extension
async function typeCheck(file) {
  const ext = path.extname(file);
  let cmd;
  switch (ext) {
    case '.agda':
      cmd = `agda-check ${file}`;
      break;
    case '.kind2':
      cmd = `kind2 check ${file}`;
      break;
    case '.c':
      cmd = `gcc -fsyntax-only ${file}`;
      break;
    case '.ts':
      cmd = `tsc --noEmit ${file}`;
      break;
    case '.hs':
      cmd = `ghc -fno-code ${file}`;
      break;
    default:
      return null;
  }
  
  try {
    var result = await execAsync(cmd);
    return result.stderr || result.stdout;
  } catch (error) {
    return error.stderr;
  }
}

// Run the main function and handle any errors
main().catch(console.error);
