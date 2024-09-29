#!/usr/bin/env node

import readline from 'readline';
import { exec } from 'child_process';
import { promisify } from 'util';
import { chat, MODELS } from './Chat.mjs';

const execAsync = promisify(exec);

// Default model if not specified
const DEFAULT_MODEL = "c";  
// Get model from environment variable or use default
const MODEL = process.argv[2] || DEFAULT_MODEL;

console.log(`Welcome to ChatSH. Model: ${MODELS[MODEL]||MODEL}\n`);

// System prompt to set the assistant's behavior
const SYSTEM_PROMPT = `You are ChatSH, an AI language model that specializes in assisting users with tasks on their system using shell commands, AND chatting or answering open-ended questions via the terminal.

# CHATSH GUIDE:

- If the USER asks you to perform a SYSTEM TASK, ChatSH must answer with a SHELL SCRIPT to perform the task.

- If the USER asks an open-ended question, ChatSH must answer with a friendly, concise, factual response.

# EXAMPLE 1: CHATTING AND PERFORMING SYSTEM COMMANDS

<USER>
Show me local files.
</USER>

<ChatSH>
\`\`\`sh
ls
\`\`\`
</ChatSH>

<SYSTEM>
example.gif example.tst example_dir/
</SYSTEM>

<USER>
Is there any text file?
</USER>

<ChatSH>
Yes, there is a file named example.txt in the current directory
</ChatSH>

<USER>
Show me the contents of example.txt.
</USER>

<ChatSH>
\`\`\`sh
cat example.txt
\`\`\`
</ChatSH>

<SYSTEM>
Na matemática, um grupo é um conjunto de elementos associados a uma operação que combina dois elementos quaisquer para formar um terceiro. Para se qualificar como grupo o conjunto e a operação devem satisfazer algumas condições chamadas axiomas de grupo: associatividade, elemento neutro e elementos inversos.
</SYSTEM>

<USER>
Can you translate the first sentence to English?
</USER>

<ChatSH>
In mathematics, a group is a set of elements associated with an operation that combines any two elements to form a third element.
</ChatSH>

<USER>
What is the monster group?
</USER>

<ChatSH>
The monster group is the largest sporadic simple group, with order approximately 8×10^53.
</ChatSH>

<USER>
What is a simple group?
</USER>

<ChatSH>
A simple group is a nontrivial group that contains no proper nontrivial normal subgroups.
</ChatSH>

<USER>
Move the text file to that dir.
</USER>

<ChatSH>
\`\`\`sh
mv example.txt example_dir/
\`\`\`
</ChatSH>

# EXAMPLE 2: ASSISTING WITH CODING TASKS

<USER>
Fix main.ts
</USER>

<ChatSH>
\`\`\`sh
cat main.ts
tsc --noEmit main.ts
\`\`\`
</ChatSH>

<SYSTEM>
import List from './list';
import map from './map';

const n_1_2: List<number> = { $: "cons", head: 1, tail: { $: "cons", head: 2, tail: { $: "nil" }}};
const n_2_4: List<number> = map(n_1_2, x => x * 2);

console.log(JSON.stringify(n_2_4));

map.ts:7:22 - error TS2345: Argument of type '(val: T) => U' is not assignable to parameter of type 'List<unknown>'.

7       let tail = map(fun, list.tail);
                       ~~~
</SYSTEM>

<ChatSH>
\`\`\`sh
ls
\`\`\`
</ChatSH>

<SYSTEM>
list.ts main.ts map.ts
</SYSTEM>

<ChatSH>
\`\`\`sh
cat map.ts
\`\`\`
</ChatSH>

<SYSTEM>
import List from './list';

function map<T, U>(list: List<T>, fun: (val: T) => U): List<U> {
  switch (list.$) {
    case "cons":
      let head = fun(list.head);
      let tail = map(fun, list.tail);
      return { $: "cons", head, tail };
    case "nil":
      return { $: "nil" };
  }
}

export default map;
</SYSTEM>

<ChatSH>
\`\`\`sh
cat > map.ts << EOL
import List from './list';

function map<T, U>(list: List<T>, fun: (val: T) => U): List<U> {
  switch (list.$) {
    case "cons":
      let head = fun(list.head);
      let tail = map(list.tail, fun);
      return { $: "cons", head, tail };
    case "nil":
      return { $: "nil" };
  }
}

export default map;
EOL
tsc --noEmit map.ts
\`\`\`
</ChatSH>

<SYSTEM>

</SYSTEM>

<ChatSH>
Done.
</ChatSH>

## NOTES:

- In COMMAND MODE, answer with SH BLOCKS.

- In TEXT MODE, answer with normal text.

- Be concise, objective, correct and factual.

- Do not attempt to install new tools; assume they're available.

- Do not include the <ChatSH> tags in your answer.

- REMEMBER: you are NOT limited to system tasks or shell commands. You must answer ANY question or request by the user.

- The system shell in use is: ${await get_shell()}.`;

// Create readline interface for user input/output
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true  
});

// Create a stateful asker
const ask = chat(MODEL);

// Utility function to prompt the user for input
async function prompt(query) {
  return new Promise(resolve => {
    rl.question(query, resolve);  
  });
}

// If there are words after the 'chatsh', set them as the initialUserMessage
var initialUserMessage = process.argv.slice(3).join(' ');

import fs from 'fs';
import path from 'path';
import os from 'os';

const HISTORY_DIR = path.join(os.homedir(), '.ai', 'chatsh_history');

// Ensure the history directory exists
if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

// Generate a unique filename for this conversation
const conversationFile = path.join(HISTORY_DIR, `conversation_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);

// Function to append message to the conversation file
function appendToHistory(role, message) {
  const formattedMessage = `<${role}>\n${message}\n</${role}>\n\n`;
  fs.appendFileSync(conversationFile, formattedMessage);
}

// Main interaction loop
async function main() {
  let lastOutput = "";

  if (MODEL === "o" || MODEL === "om") {
    console.log("NOTE: disabling system prompt.");
  }

  while (true) {
    let userMessage;
    if (initialUserMessage) {
      userMessage = initialUserMessage;
      initialUserMessage = null;
    } else {
      process.stdout.write('\x1b[1m');  // blue color
      userMessage = await prompt('λ ');
      process.stdout.write('\x1b[0m'); // reset color
    }
    
    try {
      const fullMessage = userMessage.trim() !== ''
        ? `<SYSTEM>\n${lastOutput.trim()}\n</SYSTEM>\n<USER>\n${userMessage}\n</USER>\n`
        : `<SYSTEM>\n${lastOutput.trim()}\n</SYSTEM>`;

      appendToHistory('USER', userMessage);

      // FIXME: we're disabling o1's system message
      let assistantMessage;
      if (MODEL === "o" || MODEL === "om") {
        assistantMessage = await ask(fullMessage, { system: undefined, model: MODEL, max_tokens: 8192, system_cacheable: true });  
      } else {
        assistantMessage = await ask(fullMessage, { system: SYSTEM_PROMPT, model: MODEL, max_tokens: 8192, system_cacheable: true });  
      }
      console.log(); 
      
      appendToHistory('ChatSH', assistantMessage);

      const codes = extractCodes(assistantMessage);
      lastOutput = "";

      for (var code of codes) {
        console.log("::::::::::::::::");
        console.log(code);
        console.log("::::::::::::::::");
      }

      if (codes.length > 0) {
        const combinedCode = codes.join('\n');
        console.log("\x1b[31mPress enter to execute, or 'N' to cancel.\x1b[0m");
        const answer = await prompt('');
        // Delete the warning above from the terminal
        process.stdout.moveCursor(0, -2);
        process.stdout.clearLine(2);
        if (answer.toLowerCase() === 'n') {
          console.log('Execution skipped.');
          lastOutput = "Command skipped.\n";
        } else {
          try {
            // TODO: write combinedCode to .tmp.sh
            //fs.writeFileSync('.tmp.sh', combinedCode);
            const {stdout, stderr} = await execAsync(combinedCode);
            const output = `${stdout.trim()}${stderr.trim()}`;
            console.log('\x1b[2m' + output.trim() + '\x1b[0m');
            lastOutput = output;
            appendToHistory('SYSTEM', output);
          } catch(error) {
            const output = `${error.stdout?.trim()||''}${error.stderr?.trim()||''}`;
            console.log('\x1b[2m' + output.trim() + '\x1b[0m');
            lastOutput = output;
            appendToHistory('SYSTEM', output);
          }
        }
      }
    } catch(error) {
      console.error(`Error: ${error.message}`);
      appendToHistory('ERROR', error.message);
    }
  }
}

// Utility function to extract all code blocks from the assistant's message
function extractCodes(text) {
  const regex = /```sh([\s\S]*?)```/g;
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[1].replace(/\$/g, '$$').trim());
  }
  return matches;
}

async function get_shell() {
  const shellInfo = (await execAsync('uname -a && $SHELL --version')).stdout.trim();
  return shellInfo;
}

main();
