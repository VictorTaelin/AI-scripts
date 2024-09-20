#!/usr/bin/env node

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import process from "process";
import { chat, MODELS, tokenCount } from './Chat.mjs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const DEPS_MODEL  = "claude-3-5-sonnet-20240620"; // default model for dependency guessing
const DRAFT_MODEL = "claude-3-5-sonnet-20240620"; // default model for drafting
const CODE_MODEL  = "claude-3-5-sonnet-20240620"; // default model for coding

// Define a structured object for the system definitions
const system = {
  ts: {
    koder: await fs.readFile(new URL('./koder/ts_koder.txt', import.meta.url), 'utf-8').then(content => content.trim()),
    guess: await fs.readFile(new URL('./koder/ts_guess.txt', import.meta.url), 'utf-8').then(content => content.trim()),
    deps: name => "ts-deps " + name,
  },
  agda: {
    koder: await fs.readFile(new URL('./koder/agda_koder.txt', import.meta.url), 'utf-8').then(content => content.trim()),
    guess: await fs.readFile(new URL('./koder/agda_guess.txt', import.meta.url), 'utf-8').then(content => content.trim()),
    deps: name => "agda-deps " + name,
  },
  kind: {
    koder: await fs.readFile(new URL('./koder/kind_koder.txt', import.meta.url), 'utf-8').then(content => content.trim()),
    guess: await fs.readFile(new URL('./koder/kind_guess.txt', import.meta.url), 'utf-8').then(content => content.trim()),
    deps: name => "kind deps " + name,
  },
};

// Function to get real dependencies
async function realDependencies(file, ext) {
  if (system[ext] && system[ext].deps) {
    try {
      const { stdout } = await execAsync(system[ext].deps(file));
      if (stdout == "") {
        return [];
      }
      return stdout.trim().split('\n').map(dep => {
        // Convert file path to module name
        const moduleName = dep
          .replace(new RegExp(`\\.${ext}$`), '') // Remove file extension
          .split('/') // Split path into components
          .join('.'); // Join components with dots
        return moduleName + "." + ext; // Add extension back
      });
    } catch (error) {
      console.error(`Error getting real dependencies: ${error.message}`);
      return [];
    }
  }
  return [];
}

// Function to predict dependencies
async function predictDependencies(file, ext, context, fileContent, request) {
  // Function to get all Typescript files recursively
  async function getAllFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await getAllFiles(res);
        return subFiles.length > 0 ? { name: entry.name, children: subFiles } : null;
      } else if (entry.name.endsWith("."+ext)) {
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

  const allFiles = (await getAllFiles("./")).filter(file => !file.name.includes('.backup') && !file.name.includes('node_modules'));
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
  const res = await ask(aiInput, { system: system[ext].guess, model: DEPS_MODEL, system_cacheable: true });
  console.log("\n");

  const dependenciesMatch = res.match(/<DEPENDENCIES>([\s\S]*)<\/DEPENDENCIES>/);
  if (!dependenciesMatch) {
    console.error("Error: AI output does not contain a valid DEPENDENCIES tag.");
    return [];
  }

  return dependenciesMatch[1].trim().split('\n').map(dep => dep.trim());
}

// Function to extract FILE tags from AI output
function extractFileTags(output) {
  const fileMatches = output.matchAll(/<FILE path="([^"]+)">([\s\S]*?)<\/FILE>/g);
  return Array.from(fileMatches, match => ({path: match[1], content: match[2].trim()}));
}

// Main function to handle the refactoring process
async function main() {
  // Check for correct usage and parse command-line arguments
  if (process.argv.length < 3) {
    console.log("Usage: koder <file> <request> [<model>]");
    process.exit(1);
  }

  let file = process.argv[2];
  let request = process.argv[3] || "";
  let model = process.argv[4] || CODE_MODEL;
  let ext = path.extname(file).slice(1);

  // Load the local ".context" file
  let context = "";
  try { context = await fs.readFile('./.context', 'utf-8'); } catch (e) {};

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

  // Get predicted dependencies
  var pred = await predictDependencies(file, ext, context, fileContent, request);
  var pred = pred.map(dep => dep.replace(/\/_$/, ''));

  // Get real dependencies
  var real = await realDependencies(file, ext);

  // Combine predicted and actual dependencies, removing duplicates
  var deps = [...new Set([...pred, ...real])];

  // Read dependency files
  let depFiles = await Promise.all(deps.map(async (dep) => {
    let depPath, content;
    let path0 = path.join(dir, `${dep}`);
    let path1 = path.join(dir, `${dep.replace(new RegExp(`\\.${ext}$`), '')}/_.${ext}`); 
    for (const pathToTry of [path0, path1]) {
      try {
        content = await fs.readFile(pathToTry, 'utf-8');
        depPath = pathToTry;
        break;
      } catch (err) {}
    }
    if (!content) {
      return "";
    } else {
      return `<FILE path="${depPath}">\n${content}\n</FILE>`;
    }
  }));

  // Prepare AI input
  let aiInput = [
    ...depFiles,
    `<FILE path="${file}" TARGET>`,
    fileContent,
    '</FILE>',
    '<CONTEXT>',
    context,
    '</CONTEXT>',
    '<REQUEST>',
    request,
    '</REQUEST>'
  ].join('\n').trim();

  // Write a .prompt file with the system + aiInput strings
  await fs.mkdir(path.join(os.homedir(), '.ai'), { recursive: true });
  await fs.writeFile(path.join(os.homedir(), '.ai', '.koder'), system[ext].koder + '\n\n' + aiInput, 'utf-8');

  // Call the AI model for the draft
  let draftAsk = chat(DRAFT_MODEL);
  let draftRes = await draftAsk(aiInput, { system: system[ext].koder, model: DRAFT_MODEL, system_cacheable: true });
  console.log("\nDraft generated.\n");

  // Extract FILE tags from draft output
  let draftFiles = extractFileTags(draftRes);

  // Prepare input for final version
  let finalInput = aiInput + '\n\nDRAFT:\n' + draftRes + '\n\nPlease review the draft above and provide a final version, correcting any errors or oversights:';

  // Call the AI model for the final version
  let finalRes = await ask(finalInput, { system: system[ext].koder, model, system_cacheable: true });
  console.log("\nFinal version generated.\n");

  // Extract all FILE tags from final AI output
  let filesToWrite = extractFileTags(finalRes);

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
      // Create backup directory if it doesn't exist
      const backupDir = path.join(os.homedir(), '.ai', '.backup');
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
