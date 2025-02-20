#!/usr/bin/env -S node --no-warnings --no-deprecation

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { chat, MODELS, tokenCount } from './Chat.mjs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const MODEL = process.argv[2] || "c";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true  
});
const prompt = (query) => new Promise(resolve => rl.question(query, resolve));

// STATE
const shownPaths = new Set();
let lastOutput = "";

// PROMPT
const buildSystemPrompt = () => {
  const contextData = {};
  for (const p of shownPaths) {
    try {
      const absPath = path.resolve(p);
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) {
        contextData[absPath] = fs.readdirSync(absPath).join('\n');
      } else if (stat.isFile()) {
        contextData[absPath] = fs.readFileSync(absPath, 'utf-8');
      }
    } catch (error) {
      console.error(`Error reading path '${p}': ${error.message}`);
    }
  }

  return `You are ChatSH, an AI assistant that helps the user with system tasks using shell commands and answers questions via the terminal.

# Instructions:

- When the user asks you to perform a task, reply with sequence of XML Commands ("command mode").
- When the user asks an open-ended question, answer with plain text only ("chat mode"). Be concise.

# Available XML Commands:

1. To show a file or directory on CONTEXT:

<SHOW path="/Path/to/file/or/dir"/>

Always use this command when the user asks to "view", "read", "cat", "show", "display" (etc.) a file.
Write one line for EACH file you want to show.

2. To hide a file or directory from CONTEXT:

<HIDE path="/Path/to/file/or/dir"/>

Use this command to hide irrelevant files bloating the context.

3. To write or overwrite a file:

<WRITE path="...">
(contents)
</WRITE>

Always use this command when the user asks to "write", "create", "modify", "edit", "replace", "refactor" (etc.) a file.
When modifying an existing file, rewrite it fully, without omitting parts.

4. To remove a file or directory:

<REMOVE path="/Path/to/file/or/dir"/>

Use this command when the user asks to "delete", "remove", "erase" (etc.) a file or directory.

5. To perform any other task:

<RUN>
(shell script with arbitrary commands, EXCEPT for file editing and displaying commands such as 'cat', 'touch', and similar)
</RUN>

# Examples:

::: USER
list files with 'cat' in their name

::: CHATSH
<RUN>
find . -name "*cat*"
</RUN>

::: SYSTEM
./cat_pictures.html
./catalog_items.py
./catch_exceptions.java
./category_theory.txt
./caterpillar_dance.js

::: USER
cat the cute ones

::: CHATSH
<SHOW path="./cat_pictures.html"/>
<SHOW path="./caterpillar_dance.js"/>

::: USER
create 3 files with some random fruit

::: CHATSH
<WRITE path="file_0.txt">
apple
</WRITE>
<WRITE path="file_1.txt">
banana
</WRITE>
<WRITE path="file_2.txt">
strawberry
</WRITE>

::: USER
remove file_1.txt

::: CHATSH
<REMOVE path="file_1.txt"/>

# Avoid these common errors:

- Do NOT use <RUN/> to EDIT files. Always use <WRITE/> for that.
- Do NOT use <RUN/> to VIEW files. Always use <SHOW/> for that.
- Do NOT use <RUN/> to REMOVE files. Always use <REMOVE/> for that.
- Do NOT add any explanatory text or comments before or after XML commands.
- Do NOT output anything other XML Commands to complete a task on "command mode".
- We will EDIT your response to omit <WRITE/> tags, but you should NEVER omit them yourself.

# Context:

${((Object.entries(contextData).map(([p, content]) => `<FILE path="${p}">\n${content.trim()}\n</FILE>`).join('\n\n')) || "(none)").trim()}

(use <SHOW/> and <HIDE/> to change)

# Task:

Now, you must answer the last user message. Remember:

- If the user asked an open-ended question, answer with a short and concise reply ("chat mode").

- If the user asked you to perform XML Commands, answer with just a list of commands ("command mode"):

<CMD_0/>
<CMD_1/>
...
<CMD_N/>

REMEMBER: do NOT include explanatory text before or after XML Commands.
`.trim();
};

const HISTORY_DIR = path.join(os.homedir(), '.ai', 'chatsh2_history');
if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

const conversationFile = path.join(HISTORY_DIR, `conversation_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);

const appendToHistory = (role, message) => {
  const formattedMessage = `::: ${role}\n${message}\n\n`;
  fs.appendFileSync(conversationFile, formattedMessage);
};

const executeUserCommand = async (input) => {
  input = input.trim();

  if (input.startsWith('!')) {
    const command = input.slice(1);
    try {
      const { stdout, stderr } = await execAsync(command);
      var currOutput = `\$ ${command}\n${stdout.trim()}\n${stderr.trim()}`.trim()
      lastOutput = (lastOutput + (lastOutput ? '\n' : '') + currOutput).trim();
      console.log('\x1b[34m%s\x1b[0m', currOutput);  // Blue color for system outputs
      appendToHistory('SYSTEM', currOutput);
    } catch (error) {
      console.error(`Error executing command: ${error.message}`);
      lastOutput = error.message;
      appendToHistory('ERROR', error.message);
    }
    return true;
  } else if (input.startsWith('+')) {
    const pathToAdd = input.slice(1).trim();
    shownPaths.add(pathToAdd);
    return true;
  } else if (input.startsWith('-')) {
    const pathToRemove = input.slice(1).trim();
    shownPaths.delete(pathToRemove);
    return true;
  } else if (input === '?') {
    showStats();
    return true;
  }
  return false;
};

const parseAICommands = (text) => {
  const commands = [];
  const regex = /<([A-Z]+)([^>]*)>([\s\S]*?)<\/\1>|<([A-Z]+)([^>]*)\/>/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const [, tag, attrs, content, selfClosingTag, selfClosingAttrs] = match;
    const parsedAttrs = (attrs || selfClosingAttrs || '').trim().split(/\s+/).reduce((acc, attr) => {
      const [key, value] = attr.split('=');
      if (key && value) {
        acc[key] = value.replace(/^"|"$/g, '');
      }
      return acc;
    }, {});

    commands.push({
      tag: tag || selfClosingTag,
      attrs: parsedAttrs,
      content: content || null
    });
  }
  return commands;
};

const confirmAction = async (message) => {
  console.log(`\x1b[31m${message} [Y/N]\x1b[0m`);
  const answer = await prompt('');
  process.stdout.moveCursor(0, -2);
  process.stdout.clearLine(2);
  return answer.toLowerCase() !== 'n';
};

const executeCommand = async (command) => {
  try {
    const { stdout, stderr } = await execAsync(command);
    const output = `${stdout.trim()}\n${stderr.trim()}`.trim();
    if (output !== "") console.log('\x1b[34m%s\x1b[0m', output);  // Blue color for system outputs
    appendToHistory('SYSTEM', output);
    lastOutput += (lastOutput ? '\n' : '') + output;
  } catch (error) {
    console.error(`Error executing command: ${error.message}`);
    appendToHistory('ERROR', `Error executing command: ${error.message}`);
    lastOutput += (lastOutput ? '\n' : '') + error.message;
  }
};

const processAIResponse = async (response) => {
  const commands = parseAICommands(response);

  if (commands.length > 0) {
    const confirmMessage = `Execute ${commands.length} command${commands.length > 1 ? 's' : ''}?`;
    if (await confirmAction(confirmMessage)) {
      for (const { tag, attrs, content } of commands) {
        switch (tag) {
          case 'WRITE': {
            if (attrs.path && content != null) {
              attrs.path = path.resolve(attrs.path);
              fs.writeFileSync(attrs.path, content.trim());
              shownPaths.add(attrs.path);
            } else {
              appendToHistory('ERROR', 'Invalid WRITE command');
            }
            break;
          }
          case 'RUN': {
            if (content != null) {
              await executeCommand(content);
            } else {
              appendToHistory('ERROR', 'Invalid RUN command');
            }
            break;
          }
          case 'SHOW': {
            if (attrs.path) {
              attrs.path = path.resolve(attrs.path);
              shownPaths.add(attrs.path);
              try {
                const stat = fs.statSync(attrs.path);
                if (stat.isDirectory()) {
                  const files = fs.readdirSync(attrs.path);
                  console.log('\x1b[34m%s\x1b[0m', files.join('\n'));  // Blue color for system outputs
                } else if (stat.isFile()) {
                  const content = fs.readFileSync(attrs.path, 'utf-8');
                  console.log('\x1b[34m%s\x1b[0m', content.trim());  // Blue color for system outputs
                }
              } catch (error) {
                console.error(`Error reading path ${attrs.path}: ${error.message}`);
                appendToHistory('ERROR', `Error reading path ${attrs.path}: ${error.message}`);
              }
            } else {
              appendToHistory('ERROR', 'Invalid SHOW command');
            }
            break;
          }
          case 'HIDE': {
            if (attrs.path) {
              attrs.path = path.resolve(attrs.path);
              shownPaths.delete(attrs.path);
            } else {
              appendToHistory('ERROR', 'Invalid HIDE command');
            }
            break;
          }
          case 'REMOVE': {
            if (attrs.path) {
              attrs.path = path.resolve(attrs.path);
              try {
                fs.rmSync(attrs.path, { recursive: true, force: true });
                console.log(`Removed: ${attrs.path}`);
                appendToHistory('SYSTEM', `Removed: ${attrs.path}`);
                shownPaths.delete(attrs.path);
              } catch (error) {
                console.error(`Error removing ${attrs.path}: ${error.message}`);
                appendToHistory('ERROR', `Error removing ${attrs.path}: ${error.message}`);
              }
            } else {
              appendToHistory('ERROR', 'Invalid REMOVE command');
            }
            break;
          }
          default: {
            console.error(`Unknown command: ${tag}`);
          }
        }
      }
    } else {
      console.log('Action skipped.');
      appendToHistory('SYSTEM', 'Action skipped.');
      lastOutput += (lastOutput ? '\n' : '') + 'Action skipped.';
    }
  }

  console.log("");
};

const showStats = async () => {
  const chatData = await ask(null, {});
  const totalMessages = chatData.messages.length;
  const systemPrompt = buildSystemPrompt();
  const systemPromptTokenCount = tokenCount(systemPrompt);
  
  const allMessages = chatData.messages.map(msg => msg.content).join(' ');
  const totalChatTokenCount = tokenCount(allMessages);

  console.log('\x1b[33m%s\x1b[0m', `seen_paths:`);
  shownPaths.forEach(path => {
    console.log('\x1b[33m%s\x1b[0m', `  - ${path}`);
  });
  console.log('\x1b[33m%s\x1b[0m', `msg_number: ${totalMessages}`);
  console.log('\x1b[33m%s\x1b[0m', `msg_tokens: ${totalChatTokenCount}`);
  console.log('\x1b[33m%s\x1b[0m', `sys_tokens: ${systemPromptTokenCount}`);
  console.log('\x1b[33m%s\x1b[0m', `tot_tokens: ${systemPromptTokenCount + totalChatTokenCount}`);
  console.log('');
};


const shortenAIResponse = (text) => {
  return text.replace(/<WRITE[\s\S]*?<\/WRITE>/g, '(omitted)');
};

const ask = chat(MODEL);

const loadFunctionCall = (command) => {
  const localPath = `./${command}.csh`;
  const cshPath = `./CSH/${command}.csh`;
  
  if (fs.existsSync(localPath)) {
    return fs.readFileSync(localPath, 'utf-8');
  } else if (fs.existsSync(cshPath)) {
    return fs.readFileSync(cshPath, 'utf-8');
  }
  
  return null;
};

const main = async () => {
  console.log(`Welcome to ChatSH. Model: ${MODELS[MODEL]||MODEL}\n`);

  // Check for direct call
  if (process.argv.length > 3) {
    const directMessage = process.argv.slice(3).join(' ');
    await processUserInput(directMessage);
    process.exit(0);
  }

  while (true) {
    process.stdout.write('\x1b[1m');  // Start bold
    const userInput = await prompt('λ ');
    process.stdout.write('\x1b[0m');  // End bold

    if (userInput.trim() === "") {
      continue;
    }

    await processUserInput(userInput);
  }
};

const processUserInput = async (userInput) => {
  appendToHistory('USER', userInput);

  if (await executeUserCommand(userInput)) {
    return;
  }

  let fullMessage = userInput;
  if (lastOutput) {
    fullMessage = `\`\`\`sh\n${lastOutput.trim()}\n\`\`\`\n\n${userInput}`;
    lastOutput = "";
  }

  const systemPrompt = buildSystemPrompt();

  try {
    let extend = null;
    if (userInput.startsWith('/')) {
      const [command, ...rest] = userInput.slice(1).split(' ');
      const functionContent = loadFunctionCall(command);
      if (functionContent) {
        extend = msg => functionContent + "\n" + msg;
        fullMessage = rest.join(' ');
      }
    }

    const assistantMessage = await ask(fullMessage, {
      system: systemPrompt,
      model: MODEL,
      max_tokens: 8192,
      system_cacheable: true,
      shorten: shortenAIResponse,
      extend: extend
    });
    console.log("");
    appendToHistory('CHATSH', assistantMessage);

    const logFile = path.join(HISTORY_DIR, 'chatsh2.log.txt');
    const sysFile = path.join(HISTORY_DIR, 'chatsh2.sys.txt');
    const msgFile = path.join(HISTORY_DIR, 'chatsh2.msg.txt');
    fs.appendFileSync(logFile, fullMessage + '\n##########################################\n');
    fs.writeFileSync(sysFile, systemPrompt);
    fs.writeFileSync(msgFile, JSON.stringify(await ask(null, {}), null, 2));

    await processAIResponse(assistantMessage);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    appendToHistory('ERROR', error.message);
  }
};

main();

