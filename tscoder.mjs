#!/usr/bin/env node

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import process from "process";
import { chat, MODELS, tokenCount } from './Chat.mjs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const ts_guide = await fs.readFile(new URL('./TS_GUIDE_AI.md', import.meta.url), 'utf-8');

// System prompt for the AI model, defining its role and behavior
// TODO add tsCoder and DepsPrediction text
const system_TsCoder = `
You are TsCoder, a TypeScript language coding assistant.

# USER INPUT

You will receive:

1. A target <FILE/> in the TypeScript language. That's the code you must update.

2. The user's change <REQUEST/>. You must perform that change on the target file.

3. Some additional context (files, dirs) that could be helpful.

# TSCODER OUTPUT

You, TsCoder, must answer with a single <RESULT/> tag, which must include the user's file, except *modified* to fulfill the user's request, and nothing else.

# GUIDE FOR REFACTORING

1. Make ONLY the changes necessary to correctly fullfill the user's REQUEST.
2. Do NOT fix, remove, complete or alter any parts unrelated to the REQUEST.
3. Preserve the same indentation and style of the target FILE.
4. Consulte TypeScript guide to emit syntactically correct code.
5. Be precise and careful in your modifications.

${ts_guide}

# TSCODER EXAMPLE

Below is a complete example of how TsCoder should interact with the user.

## User:

<FILE path="/Users/v/vic/dev/ts/book/Nat/_.ts">
`.trim();
const system_DepsPredictor = "".trim();

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
  let cmd = `tsc ${file}`;
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
  // TODO enhance default request
  if (request.trim() === '') {
    request = [
      "Update this file.",
      "- If it is empty, implement an initial template.",
      "- If it has holes, fill them, up to \"one layer\".",
      "- If it has no holes, fully complete it, as much as possible."
    ].join('\n');
  }

  // If the file is empty, ask the AI to fill with an initial template
  // TODO: add default def for ts template
  if (fileContent.trim() === '') {
    fileContent = [
      "",
    ].join('\n');
  }

  // Extract the definition name from the file path
  // TODO: probably change here to use smth other than book/
  let defName = file.split('/book/')[1].replace('.ts', '');

  // Collect direct and indirect dependencies
  let deps;
  try {
    // this assumes the ts-deps command from here is installed
    let { stdout } = await execAsync(`ts-deps ${defName}`);
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
    let path0 = path.join(dir, '..', `${dep}.ts`);
    // TODO: _.ts not needed probably?
    let path1 = path.join(dir, '..', `${dep}/_.ts`); 
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
  let aiOutput = await ask(aiInput, { system: system_TsCoder, model });
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

