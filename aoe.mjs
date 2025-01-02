#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { chat, MODELS } from './Chat.mjs';
import { exec } from 'child_process';
import os from 'os';

// UTILS
// -----

// Get model arguments from command line
const args = process.argv.slice(2);
const query = args[0];
const PICKER_MODEL = args[1] || "d";
const EDITOR_MODEL = args[2] || "c";

console.log(`Picker-Model: ${MODELS[PICKER_MODEL]}`);
console.log(`Editor-Model: ${MODELS[EDITOR_MODEL]}`);

const GROUP_SIZE = 2; // Configurable group size
const PARALLEL = true; // Should we call the picker in parallel?
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const START_TIME = Date.now();

// Read the .aoe.json file if it exists
let config;
try {
  const configContent = await fs.readFile(path.join(process.cwd(), 'aoe.json'), 'utf8');
  config = JSON.parse(configContent);
} catch (err) {
  // If no config file or invalid JSON, proceed with default behavior
  config = {path: "."};
}

// Trim function that preserves leading spaces
function trimmer(str) {
  return str.replace(/^\n+|\n+$/g, '');
}

// Split content into chunks (sequences of non-empty lines)
function getChunks(content) {
  return content
    .split(/\n\s*\n/)
    .map(chunk => trimmer(chunk))
    .filter(chunk => chunk.length > 0);
}

// Summarize a chunk by showing its first comment and first non-comment line
function shortenChunk(chunk, aggressive) {
  const lines = chunk.split('\n');
  if (lines[0] === '--show--' || lines[0] === '//show//') {
    return lines.slice(1).join('\n');
  }
  if (!aggressive) {
    const firstLine = lines[0];
    const isFirstLineComment
      =  firstLine.trim().startsWith('//')
      || firstLine.trim().startsWith('--')
      || firstLine.trim().startsWith('#');
    if (isFirstLineComment) {
      const firstNonComment = lines.find(line => 
        !line.trim().startsWith('//') && 
        !line.trim().startsWith('--') && 
        !line.trim().startsWith('#'));
      if (firstNonComment) {
        return `${firstLine}\n${firstNonComment}...`;
      }
      return `${firstLine}...`;
    } else {
      return `${firstLine}...`;
    }
  }
  return "";
}

function longChunk(chunk) {
  const lines = chunk.split('\n');
  if (lines[0] === '--show--' || lines[0] === '//show//') {
    return lines.slice(1).join('\n');
  } else {
    return lines.join("\n");
  }
}

// Main function to load all code files recursively
async function loadFiles(dir) {
  const files = await fs.readdir(dir);
  let results = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      results = results.concat(await loadFiles(filePath));
    } else {
      const ext = path.extname(file);
      if (['.py','.hs','.js','.ts','.kind','.hvml','.c'].includes(ext)) {
        const content = await fs.readFile(filePath, 'utf8');
        results.push({ path: filePath, content });
      }
    }
  }
  return results;
}

// Load context from files
async function loadContext() {
  const basePath = config.path || '.';
  const files = await loadFiles(basePath);
  let context = [];
  let chunkId = 0;
  for (const file of files) {
    const chunks = getChunks(file.content);
    for (const chunk of chunks) {
      context.push({chunk, path: file.path, id: chunkId++});
    }
  }
  return context;
}

// Save context back to files
async function saveContext(context) {
  const fileMap = {};
  for (const item of context) {
    if (!fileMap[item.path]) fileMap[item.path] = [];
    fileMap[item.path].push(item.chunk);
  }
  for (const [filePath, chunks] of Object.entries(fileMap)) {
    await fs.writeFile(filePath, chunks.join('\n\n') + '\n');
  }
}


// Generate shortened context
function shortenContext(context, shownChunks, aggressive, xml) {
  let result = '';
  let currentFile = '';
  for (const item of context) {
    var body = shownChunks[item.id] ? item.chunk : shortenChunk(item.chunk, aggressive);
    if (body !== "") {
      if (item.path !== currentFile) {
        result += `\n${item.path}:\n`;
        currentFile = item.path;
      }
      if (xml) {
        result += `<block id=${item.id}>\n`;
      }
      result += `${body}\n`;
      if (xml) {
        result += `</block>\n`;
      }
    }
  }
  return result.trim();
}

// Format conversation log
function formatLog(log) {
  return log.join('\n').trim();
}

const context = await loadContext();

//console.log(shortenContext(context, {}, false, false));
//process.exit();

// TODO: load and save the context, then exit
//await saveContext(context);
//process.exit();

// TASK: complete this file, as follows:
// - get the user query from argv (ex: `./foo.js "user query here"`)
// - for each chunk in the context:
//   - create a summarized context with that chunk shown (all other shortened)
//   - call Analyst, sending the query + that context, to ask:
//     1. does this chunk need to be edited to fulfill the request? 
//     2. which other 32 chunks should be expanded to give additional context when editing that chunk?
//   - response must be a valid, parseable JSON:
//     {"edit": true, "relevant": [17, 19, 32, 50, 51, ...]}
//     {"edit": false, "relevant": []}
//   - create a proper system prompt to help Analyst answer the query correctly
// - use Promise.all to gather all responses from the loop above
// - for each chunk that has to be edited:
//   - create a summarized context with that chunk plus the other chunks shown
//   - call Editor, sending the query + that context, to ask it to edit the chunk
//   - it must response with just the code that has to be inserted to replace the chunk, and nothing else 
// - use Promise.all to gather all responses from the loop above
// - replace each edited chunk by the chunks provided by each Editor call
// - save the final context back to the filesystem

// Get user query from command line
if (!query) {
  console.error('Please provide a query as argument');
  process.exit(1);
}

// System prompts
const PICKER_SYSTEM = (codebase, chunks, query) =>
`You're an advanced software analyst, specialized in predicting when a refactor will affect a specific block of code.

For example, consider the following refactor:

<refactor>
represent vectors as [x,y] instead of {x,y}
</refactor>

Then, given the following target blocks:

<target>
<block id=2>
// Vector Library
</block>
<block id=3>
funciton neg(v) {
  return {x: -v.x, y: -v.y};
}
</block>
<block id=4>
function dot(a, b) {
  return sum(mul(a, b));
}
</block>
<block id=5>
function add(a, b) {
</block>
<block id=6>
  return {x: a.x + b.x, y: a.y + b.y};
</block>
<block id=7>
}
</block>
<block id=8>
// Example: len({x:3,y:4}) == 5
function len(v) {
  return Math.sqrt(dot(v));
}
</block>
</target>

Your goal is to answer the following question:

> After the refactor is completed, which of the target blocks will have been changed?

Start by answering the question for each block:

- Block 2: The refactor will affect the Vector library, but that block is just a title comment, which isn't directly affected. No.
- Block 3: That block constructs a vector using the old format, which must be updated. Yes.
- Block 4: That block uses vectors, but the refactor doesn't affect it code directly. No.
- Block 5: The add function will be affected by this refactor, but that block contains only the function declaration, which isn't directly affected. No.
- Block 6: That block constructs a vector using the old format, which must be updated. Yes.
- Block 7: That block just closes the add function with a '}', which isn't affected by the refactor. No.
- Block 8: The len function isn't directly affected by this refactor, but this block has a comment that must be adjusted. Yes.

Then, complete your goal by writing with a JSON object mapping block ids to a boolean prediction.

In this example, the final answer should be:

{"changed":{"2":false,"3":true,"4":false,"5":false,"6":true,"7":false,"8":true}}

Don't use spaces or newlines inside the JSON.

Pay extra attention to the fact that the answer must only be 'true' when the block's actual text content needs to change.
Even if a block uses concepts related to the refactor, it should be marked as 'false' unless its literal code requires modification.`;

const PICKER_MESSAGE = (codebase, chunks, query) =>
`Before we start, let me give you some helpful context. We're working on the following codebase:

<codebase>
${codebase}
</codebase>

(Note: many parts have been omitted.)

The proposed refactor is:

<refactor>
${query}
</refactor>

We're refactoring the following target code blocks:

<target>
${chunks.map((item, index) =>
`<block id=${item.id}>
${longChunk(item.chunk)}
</block>`).join('\n')}
</target>

Now, answer the following question:

> After the refactor is completed, which of the target blocks will have been changed?

Start by answering that question individually for each block. Be concise.

Then, write your final answer, as a JSON object mapping block IDs to boolean predictions.

Do it now.`;

// Process chunks using the Picker to determine which need editing
const processChunks = async (chunks) => {
  const shownChunks = {};
  chunks.forEach(c => shownChunks[c.id] = true);
  const codebase = shortenContext(context, shownChunks, true, false);
  const message = PICKER_MESSAGE(codebase, chunks, query);
  const system = PICKER_SYSTEM(codebase, chunks, query);
  const response = await chat(PICKER_MODEL)(message, { system, system_cacheable: true, stream: false });

  //console.log("#SYSTEM:");
  //console.log(system);
  //console.log("#MESSAGE:");
  //console.log(message);
  //console.log("#RESPONSE:");
  //console.log(response);
  //process.exit();
  
  let editDecisions;
  try {
    const jsonMatch = response.match(/\{"changed":[^]*\}/);
    if (!jsonMatch) {
      console.error("No valid JSON found in response:");
      console.log(response);
      return {};
    }
    editDecisions = JSON.parse(jsonMatch[0]).changed;
  } catch (error) {
    console.error("Failed to parse JSON response:", error);
    return {};
  }

  //// Print results for each chunk in the group
  //console.log("-----------------------");
  //chunks.forEach(chunk => {
    //console.log(`#CHUNK ${chunk.id}`);
    //console.log(chunk.chunk);
  //});
  //console.log("#RESPONSE");
  //console.log(response);
  //// Print classification for each chunk
  //chunks.forEach(chunk => {
    //const validLambdas = (chunk.chunk.match(/(?<!--)λ(?!-)/g) || []).length;
    //const shouldEdit = validLambdas > 0;
    //const aiSaysEdit = editDecisions[chunk.id];
    //let classification = [];
    //if (aiSaysEdit && !shouldEdit) classification.push("#FP");
    //if (aiSaysEdit && shouldEdit) classification.push("#TP");
    //if (!aiSaysEdit && shouldEdit) classification.push("#FN");
    //if (!aiSaysEdit && !shouldEdit) classification.push("#TN");
    //console.log(`Block ${chunk.id}: ${classification.join(" ")}`);
  //});

  // Print selected blocks
  chunks.forEach(chunk => {
    if (editDecisions[chunk.id]) {
      console.log("#" + chunk.id + ": " + shortenChunk(chunk.chunk).split("\n")[0].trim() + "...");
    }
  });

  return chunks.reduce((acc, item) => {
    acc[item.id] = {
      chunk: item,
      edit: editDecisions[item.id] || false,
      relevant: []
    };
    return acc;
  }, {});
};

console.log("# Selecting chunks to be edited...");

// Create chunk groups
const chunkGroups = [];
for (let i = 0; i < context.length; i += GROUP_SIZE) {
  chunkGroups.push(context.slice(i, i + GROUP_SIZE));
}

// Process chunks either in parallel or sequentially based on PARALLEL flag
const chunkPicks = PARALLEL
  ? await Promise.all(chunkGroups.map(processChunks))
  : await chunkGroups.reduce(async (p,g) => [...await p, await processChunks(g)], Promise.resolve([]));

const flattenedChunkPicks = Object.assign({}, ...(Array.isArray(chunkPicks) ? chunkPicks : [chunkPicks]));

// Rate the AI's output
//const rateResults = () => {
  //let falsePositives = 0;
  //let truePositives = 0;
  //let realPositives = 0;
  
  //for (const [id, result] of Object.entries(flattenedChunkPicks)) {
    //// Count lambdas that are not followed by a hyphen in this chunk
    //const chunk = result.chunk.chunk;
    //const validLambdas = (chunk.match(/(?<!--)λ(?!-)/g) || []).length;
    
    //// Track real positives (chunks that actually contain valid lambdas)
    //if (validLambdas > 0) {
      //realPositives++;
    //}
    
    //if (result.edit) {
      //if (validLambdas > 0) {
        //truePositives++;
      //} else {
        //falsePositives++;
      //}
    //}
  //}
  
  //console.log("\nRating Results:");
  //console.log(`True Positives: ${truePositives}`);
  //console.log(`False Positives: ${falsePositives}`);
  //console.log(`Real Positives: ${realPositives}`);
//};
//rateResults();
//process.exit();

// TASK: the picker is now working with great accuracy. great job.
// let's now create the editor.
// unlike the picker, the editor will NOT be called in parallel.
// instead, it will be called only once.
// we will give the following to the editor:
// 1. the shortened codebase (non aggressively)
// 2. the target chunks that it must edit (from the previous classifier)
// 3. the refactor that has to be made
// the system prompt and message shuold be very simple and concise.
// we'll then ask it to refactor the code blocks.
// it must output the results in xml blocks, just like the input.
// we'll then parse these results, update the respective chunks, and save to disk.
// your goal is to FULLY complete this script with the editor functionality.
// do it now:

// System prompt for the Editor
const EDITOR_SYSTEM =
`You're an advanced coding agent, specialized in refactoring blocks of code.

For example, consider the following refactor:

<refactor>
represent vectors as [x,y] instead of {x,y}
</refactor>

Then, given the following target blocks:

<target>
<block id=2>
// Vector Library
</block>
<block id=3>
funciton neg(v) {
  return {x: -v.x, y: -v.y};
}
</block>
<block id=4>
function dot(a, b) {
  return sum(mul(a, b));
}
</block>
<block id=5>
function add(a, b) {
</block>
<block id=6>
  return {x: a.x + b.x, y: a.y + b.y};
</block>
<block id=7>
}
</block>
<block id=8>
// Example: len({x:3,y:4}) == 5
function len(v) {
  return Math.sqrt(dot(v));
}
</block>
</target>

Your must ask yourself the following question:

> Which of the target blocks must be changed to perform this refactor?

Start by answering the question for each block:

- Block 2: The refactor will affect the Vector library, but that's just a title comment, that isn't directly affected. No.
- Block 3: That block constructs a vector using the old format, which must be updated. Yes.
- Block 4: That block uses vectors, but the refactor doesn't affect it code directly. No.
- Block 5: The add function will be affected by this refactor, but that block contains only the function declaration, which isn't directly affected. No.
- Block 6: That block constructs a vector using the old format, which must be updated. Yes.
- Block 7: That block just closes the add function with a '}', which isn't affected by the refactor. No.
- Block 8: The len function isn't directly affected by this refactor, but this block has a comment that must be adjusted. Yes.

Then, complete your goal by writing the updated version of each block that requires change, in the following format:

<block id=3>
funciton neg(v) {
  return [-v.x, -v.y];
}
</block>
<block id=4>
function dot(a, b) {
  return sum(mul(a, b));
}
</block>
<block id=6>
  return [a.x + b.x, a.y + b.y];
</block>
<block id=8>
// Example: len([3,4]) == 5
function len(v) {
  return Math.sqrt(dot(v));
}
</block>`;

// Message for the Editor
const EDITOR_MESSAGE = (codebase, chunksToEdit, query) =>
`For context, here's a shortened version of our codebase:

${codebase}

Your task is to perform the following refactoring:

<refactor>
${query}
</refactor>

Below are the target code blocks you need to consider:

<target>
${chunksToEdit.map(chunk => `
<block id=${chunk.id}>
${chunk.chunk}
</block>`).join('\n')}
</target>

Now, provide the updated version of each block that requires changes, using this format:

<block id=X>
... refactored code here ...
</block>

IMPORTANT:
Only make changes directly related to the specified refactor.
Do not fix or alter any code unless it's necessary to complete the refactoring task.

Please proceed with the refactoring now.
`;

// Function to edit chunks
async function editChunks(chunksToEdit) {
  const shownChunks = {};
  const codebase = shortenContext(context, shownChunks, false, false);
  const message = EDITOR_MESSAGE(codebase, chunksToEdit, query);
  console.log("# Editing the selected blocks...");
  //console.log("-------------------");
  //console.log("#SYSTEM");
  //console.log(EDITOR_SYSTEM);
  //console.log("#MESSAGE");
  //console.log(message);
  //console.log("#RESPONSE");
  const response = await chat(EDITOR_MODEL)(message, { system: EDITOR_SYSTEM, system_cacheable: true, stream: true });

  // Parse the response and extract refactored blocks
  const blockRegex = /<block id=(\d+)>([\s\S]*?)<\/block>/g;
  let match;
  const refactoredChunks = {};

  while ((match = blockRegex.exec(response)) !== null) {
    const [, id, content] = match;
    refactoredChunks[id] = content.trim();
  }

  return refactoredChunks;
}

// Get chunks that need editing
const chunksToEdit = Object.values(flattenedChunkPicks)
  .filter(result => result.edit)
  .map(result => result.chunk);

// Edit the chunks
const refactoredChunks = await editChunks(chunksToEdit);

// Update the context with refactored chunks
context.forEach(item => {
  if (refactoredChunks[item.id]) {
    item.chunk = refactoredChunks[item.id];
  }
});

// Save the updated context back to files
await saveContext(context);

console.log("Refactoring completed and saved to files.");
console.log(`Total execution time: ${(Date.now() - START_TIME) / 1000} seconds`);
