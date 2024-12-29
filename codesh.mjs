#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { chat } from './Chat.mjs';
import { exec } from 'child_process';
import os from 'os';

const MODEL = "C";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const START_TIME = Date.now();

const SYSTEM = `You are a coding agent.

TASK:

Complete a coding GOAL.

INSTRUCTIONS:

1. Read the goal carefully.
2. Read the codebase carefully. 
3. Read the issued commands.
4. Issue the NEXT command in the chain:
  - If creating a new file, issue '/create'.
  - If more context would help, issue '/open'.
  - If ready to edit code chunks, issue '/edit', '/splice', '/insert' or '/append'.
  - If goal is reached, issue '/done'.

CODEBASE:

The user will show you a 'chunked codebase', where a chunk is defined as a
consecutive sequence of non-empty lines. They may also shorten chunks by using
'...' to omit some parts. For example, this file:

\`\`\`
def foo(x, y):
  x = x * 2
  y = y * 2
  return x + y

def bar(n):
  for i in range(n):
    print(i)

def ping():
  print("pong")
\`\`\`

Might be shown as:

\`\`\`
-0:
def foo(x, y):
...
-1:
def bar(n):
...
+2:
def ping():
  print("pong")
...
\`\`\`

That is, there are 3 chunks. "-0:" and "-1:" are shortened. "+2:" is expanded.

COMMANDS:

Creates a file:
/create foo.js
\`\`\`
initial code
\`\`\`

Expands shortened chunks:
/open 1 2 3

Inserts before a chunk:
/insert 2
\`\`\`
code
\`\`\`

Appends after a chunk:
/append 2
\`\`\`
code
\`\`\`

Replaces a single chunk:
/edit 2
\`\`\`
code
\`\`\`

Replaces a range of chunks:
/splice 2-5
\`\`\`
code
\`\`\`

Halts:
/done

EXAMPLE:

goal: refactor the stringifier to use unicode, and to include the Ref constructor
/open 1 2 3 5 7
/open 20 21 22 23
/open 42 47 49
/splice 20-23
\`\`\`
showTerm :: Term -> String

showTerm (Lam nam bod) = "λ" ++ nam ++ ". " ++ showTerm bod

showTerm (App fun arg) = "(" ++ showTerm fun ++ " " ++ showTerm arg ++ ")"

showTerm (Var idx) = "#" ++ show idx

showTerm (Ref nam) = "@" ++ nam
\`\`\`
/done

(remember to separate chunks with empty lines in your code block)
(example: the splice above removes 4 chunks and introduces 5 chunks)

IMPORTANT:

- Expand ALL related chunks before editing any code; study the codebase.
- DO NOT ADD EXPLANATORY TEXT BEFORE/AFTER THE COMMAND.
- OTHERWISE, IT WILL FAIL TO PARSE.`;

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
function shortenChunk(chunk) {
  const lines = chunk.split('\n');
  const firstComment = lines.find(line => 
    line.trim().startsWith('//') || 
    line.trim().startsWith('--') || 
    line.trim().startsWith('#'));
  const firstNonComment = lines.find(line => 
    !line.trim().startsWith('//') && 
    !line.trim().startsWith('--') && 
    !line.trim().startsWith('#'));
  
  let result = [];
  if (firstComment) result.push(firstComment + '...');
  if (firstNonComment) result.push(firstNonComment + '...');
  if (!firstComment && !firstNonComment) return lines[0] + '...';
  return result.join('\n');
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
  const files = await loadFiles('.');
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
    await fs.writeFile(filePath, chunks.join('\n\n').trim());
  }
}

// Generate summarized context
function summarizeContext(context, shownChunks) {
  let result = '';
  let currentFile = '';
  
  for (const item of context) {
    if (item.path !== currentFile) {
      result += `\n${item.path}:\n`;
      currentFile = item.path;
    }
    result += shownChunks[item.id] ? `+${item.id}:\n` : `-${item.id}:\n`;
    result += shownChunks[item.id] ? item.chunk : shortenChunk(item.chunk);
    result += '\n';
  }
  
  return result.trim();
}

// Format conversation log
function formatLog(log) {
  return log.join('\n').trim();
}

// Save conversation to history file
async function saveConversation(prompt) {
  const historyDir = path.join(os.homedir(), '.ai', 'codesh_history');
  await fs.mkdir(historyDir, { recursive: true });
  const historyFile = path.join(historyDir, START_TIME.toString());
  await fs.writeFile(historyFile, `PROMPT:\n${prompt}`);
}

// Helper function to handle chunk modifications
function modifyChunks(context, index, newChunks, mode) {
  let start, end;
  
  if (typeof index === 'string' && index.includes('-')) {
    [start, end] = index.split('-').map(Number);
  } else {
    start = end = Number(index);
  }
  
  const filePath = context[start].path;
  const newEntries = newChunks.map((chunk, i) => ({
    chunk,
    path: filePath,
    id: mode === 'insert' ? start + i : start + i + (mode === 'append' ? 1 : 0)
  }));

  switch (mode) {
    case 'splice':
      context.splice(start, end - start + 1, ...newEntries);
      break;
    case 'edit':
      context.splice(start, 1, ...newEntries);
      break;
    case 'insert':
      context.splice(start, 0, ...newEntries);
      break;
    case 'append':
      context.splice(start + 1, 0, ...newEntries);
      break;
  }

  // Update IDs for subsequent chunks
  for (let i = start + newChunks.length; i < context.length; i++) {
    context[i].id = i;
  }

  return newEntries.map(entry => entry.id);
}

// Execute AI command
async function executeCommand(command, context, shownChunks) {
  // Extract just the command portion (everything from first / onwards)
  const cleanCommand = command.slice(command.indexOf('/'));
  
  if (cleanCommand.startsWith('/create')) {
    const match = cleanCommand.match(/\/create\s+([^\n]+)\n```([\s\S]+?)```/);
    if (!match) return false;
    
    const [_, filePath, content] = match;
    const sanitizedPath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    await fs.writeFile(sanitizedPath, content);

    for (const key in shownChunks) {
      delete shownChunks[key];
    }
    context = await loadContext();
    const fileChunks = context.filter(item => item.path === sanitizedPath);
    for (const item of fileChunks) {
      shownChunks[item.id] = true;
    }

    return true;
  }
  
  if (cleanCommand.startsWith('/delete')) {
    const match = cleanCommand.match(/\/delete\s+([^\n]+)/);
    if (!match) return false;
    
    const [_, filePath] = match;
    const sanitizedPath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    await fs.unlink(sanitizedPath);
    return true;
  }
  
  if (cleanCommand.startsWith('/open')) {
    const match = cleanCommand.match(/\/open\s+([0-9\s]+)/);
    if (!match) return false;
    
    const chunks = match[1].trim().split(/\s+/).map(Number);
    for (const i of chunks) {
      shownChunks[i] = true;
    }
    return true;
  }
  
  if (cleanCommand.startsWith('/splice')) {
    const match = cleanCommand.match(/\/splice\s+(\d+)-(\d+)\n```([\s\S]+?)```/);
    if (!match) return false;
    
    const [_, start, end, newCode] = match;
    const newChunks = getChunks(newCode);
    
    const newIds = modifyChunks(context, `${start}-${end}`, newChunks, 'splice');
    newIds.forEach(id => shownChunks[id] = true);

    return true;
  }

  if (cleanCommand.startsWith('/edit')) {
    const match = cleanCommand.match(/\/edit\s+(\d+)\n```([\s\S]+?)```/);
    if (!match) return false;

    const [_, index, newCode] = match;
    const chunkIndex = parseInt(index);
    const newChunks = getChunks(newCode);
    
    const newIds = modifyChunks(context, chunkIndex, newChunks, 'edit');
    newIds.forEach(id => shownChunks[id] = true);

    return true;
  }

  if (cleanCommand.startsWith('/insert')) {
    const match = cleanCommand.match(/\/insert\s+(\d+)\n```([\s\S]+?)```/);
    if (!match) return false;

    const [_, index, newCode] = match;
    const chunkIndex = parseInt(index);
    const newChunks = getChunks(newCode);
    
    const newIds = modifyChunks(context, chunkIndex, newChunks, 'insert');
    newIds.forEach(id => shownChunks[id] = true);

    return true;
  }

  if (cleanCommand.startsWith('/append')) {
    const match = cleanCommand.match(/\/append\s+(\d+)\n```([\s\S]+?)```/);
    if (!match) return false;

    const [_, index, newCode] = match;
    const chunkIndex = parseInt(index);
    const newChunks = getChunks(newCode);
    
    const newIds = modifyChunks(context, chunkIndex, newChunks, 'append');
    newIds.forEach(id => shownChunks[id] = true);

    return true;
  }
  
  return false;
}

async function handleAIInteraction(goal, log, shownChunks, interrupted) {
  let working = true;
  
  while (working && !interrupted) {
    const context = await loadContext();
    const contextSummary = summarizeContext(context, shownChunks);
    const logSummary = formatLog(log);
    
    const message = `The current goal is:

${goal}

I've issued the following commands:

${logSummary||"(none)"}

Resulting in the current codebase state:

${contextSummary||"(empty)"}

If the goal isn't complete, issue the next command in the chain.`;
    
    var response = await chat(MODEL)(message, { system: SYSTEM });
    var response = response.slice(response.indexOf('/')).trim();
    if (response.includes('```')) {
      const parts = response.split('```');
      response = parts[0] + '```' + parts[1] + '```';
    }
    
    log.push(response.split('\n')[0]);
    console.log("");
    
    await saveConversation(SYSTEM + '\n\n' + message);
    
    if (response.includes('/done')) {
      working = false;
      await saveContext(context);
      for (const key in shownChunks) {
        delete shownChunks[key];
      }
    } else {
      const success = await executeCommand(response, context, shownChunks);
      if (success) {
        await saveContext(context);
      } else {
        console.log("ERROR: Invalid command format");
        working = false;
        for (const key in shownChunks) {
          delete shownChunks[key];
        }
      }
    }
  }
  
  return interrupted;
}

// Handle user commands
async function handleUserCommand(line, shownChunks, log) {
  if (line.startsWith('!')) {
    return new Promise((resolve) => {
      exec(line.slice(1), (error, stdout, stderr) => {
        console.log(stdout);
        console.error(stderr);
        resolve();
      });
    });
  } else if (line.startsWith('?')) {
    const context = await loadContext();
    console.log(summarizeContext(context, shownChunks));
  }
}

// Main loop
async function main() {
  let shownChunks = {};
  let interrupted = false;
  let log = [];
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const askQuestion = async () => {
    rl.question('λ ', async (line) => {
      try {
        if (line.length > 0) {
          if (line.startsWith('!') || line.startsWith('?')) {
            await handleUserCommand(line, shownChunks, log);
          } else {
            interrupted = await handleAIInteraction(line, log, shownChunks, interrupted);
          }
        }
        askQuestion();
      } catch (error) {
        console.error('Error:', error);
        askQuestion();
      }
    });
  };
  
  process.on('SIGINT', () => {
    console.log('\nInterrupted by user');
    interrupted = true;
  });
  
  askQuestion();
}

main().catch(console.error);




















