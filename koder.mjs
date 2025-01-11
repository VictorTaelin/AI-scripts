#!/usr/bin/env node

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import process from "process";
import { chat, MODELS, tokenCount } from './Chat.mjs';
import { exec } from 'child_process';
import { promisify } from 'util';
import kind_clean from "./kind_clean.mjs";

const execAsync = promisify(exec);

const DEPS_MODEL = "claude-3-5-sonnet-20240620"; // default model for dependency guessing
const CODE_MODEL = "claude-3-5-sonnet-20240620"; // default model for coding

//const DEPS_MODEL = "g"; // default model for dependency guessing
//const CODE_MODEL = "g"; // default model for coding

// Define a structured object for the system definitions
const system = {
  ts: {
    koder: await fs.readFile(new URL('./koder/ts_koder.txt', import.meta.url), 'utf-8').then(content => content.trim()),
    guess: await fs.readFile(new URL('./koder/ts_guess.txt', import.meta.url), 'utf-8').then(content => content.trim()),
    clean: x => x,
    deps: name => "ts-deps " + name + " --recursive",
  },
  agda: {
    koder: await fs.readFile(new URL('./koder/agda_koder_2.txt', import.meta.url), 'utf-8').then(content => content.trim()),
    guess: await fs.readFile(new URL('./koder/agda_guess.txt', import.meta.url), 'utf-8').then(content => content.trim()),
    clean: x => x,
    deps: name => "agda-deps " + name + " --recursive",
  },
  kind: {
    koder: await fs.readFile(new URL('./koder/kind_koder_2.txt', import.meta.url), 'utf-8').then(content => content.trim()),
    guess: await fs.readFile(new URL('./koder/kind_guess.txt', import.meta.url), 'utf-8').then(content => content.trim()),
    clean: kind_clean,
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
      return stdout.trim().split('\n').map(dep => dep.trim() + "." + ext);
    } catch (error) {
      //console.error(`Error getting real dependencies: ${error.message}`);
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
    //'<CONTEXT>',
    //context,
    //'</CONTEXT>',
    '<REQUEST>',
    request,
    '</REQUEST>'
  ].join('\n').trim();

  const ask = chat(DEPS_MODEL);
  const res = await ask(aiInput, { system: system[ext].guess, model: DEPS_MODEL, system_cacheable: true });
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

  // Load the local ".koder" file
  let koder = "";
  try { koder = await fs.readFile('./.koder', 'utf-8'); } catch (e) {};

  // Initialize the chat function with the specified model
  let ask = chat(model);

  // Get directory and file information
  let dir = process.cwd();
  let fileContent;
  try {
    fileContent = system[ext].clean(await fs.readFile(file, 'utf-8'));
  } catch (e) {
    fileContent = "";
  }

  // If the request is empty, replace it by a default request.
  if (request.trim() === '') {
    request = ["Implement or update the TARGET file."].join('\n');
  }

  // If the file is empty, ask the AI to fill with an initial template
  if (fileContent.trim() === '') {
    fileContent = ["(empty file)"].join('\n');
  }

  // Get preducted dependencies
  var pred = await predictDependencies(file, ext, koder, fileContent, request);
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
        content = system[ext].clean(await fs.readFile(pathToTry, 'utf-8'));
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

  //console.log(pred);
  //console.log(deps);
  //console.log(depFiles);
  //process.exit();

  // Prepare AI input
  let aiInput = [
    ...depFiles,
    `<FILE path="${file}" TARGET>`,
    fileContent,
    '</FILE>',
    '<CONTEXT>',
    koder,
    '</CONTEXT>',
    '<REQUEST>',
    request,
    '</REQUEST>'
  ].join('\n').trim();

  // Write a .prompt file with the system + aiInput strings
  await fs.mkdir(path.join(os.homedir(), '.ai'), { recursive: true });
  await fs.writeFile(path.join(os.homedir(), '.ai', '.koder'), system[ext].koder + '\n\n' + aiInput, 'utf-8');

  // Call the AI model
  let res = await ask(aiInput, { system: system[ext].koder, model, system_cacheable: true });
  console.log("\n");

  // Extract all FILE tags from AI output
  let fileMatches = res.matchAll(/<FILE path="([^"]+)">([\s\S]*?)<\/FILE>/g);
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

      // Create necessary directories for the target file
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });

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
