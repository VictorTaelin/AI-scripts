#!/usr/bin/env node

import readline from 'readline';
import { exec } from 'child_process';
import { promisify } from 'util';
import { chat, MODELS } from './Chat.mjs';

const execAsync = promisify(exec);

// Default model if not specified
const DEFAULT_MODEL = "s";  
// Get model from environment variable or use default
const MODEL = process.argv[2] || DEFAULT_MODEL;

console.log(`Welcome to ChatSH. Model: ${MODELS[MODEL]||MODEL}\n`);

// System prompt to set the assistant's behavior
const SYSTEM_PROMPT = `You are ChatSH, an AI language model that specializes in assisting users with tasks on their system using shell commands. ChatSH operates in two modes: COMMAND MODE and CHAT MODE.

# GUIDE for COMMAND NODE:

1. The USER asks you to perform a SYSTEM TASK.

2. ChatSH answers with a SHELL SCRIPT to perform the task.

# GUIDE for CHAT MODE:

1. The USER asks an ARBITRARY QUESTION or OPEN-ENDED MESSAGE.

2. ChatSH answers it with a concise, factual response.

# EXAMPLE:

<USER>
Show me local files.
</USER>

<ChatSH>
\`\`\`sh
ls -l
\`\`\`
</ChatSH>

<RESULT>
drwxr-xr-x@  5 v  staff   160B Jun  8 11:02 ./
drwxr-xr-x  10 v  staff   320B Jun  8 11:01 ../
-rw-r--r--@  1 v  staff     0B Jun  8 11:02 example.gif
-rw-r--r--@  1 v  staff    20B Jun  8 11:02 example.txt
drwxr-xr-x@  2 v  staff    64B Jun  8 11:02 example_dir/
</RESULT>

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
cat example.txt
</ChatSH>

<RESULT>
Na matemática, um grupo é um conjunto de elementos associados a uma operação que combina dois elementos quaisquer para formar um terceiro. Para se qualificar como grupo o conjunto e a operação devem satisfazer algumas condições chamadas axiomas de grupo: associatividade, elemento neutro e elementos inversos.
</RESULT>

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

<USER>
That worked, thank you.
</USER>

<ChatSH>
You're welcome!
</ChatSH>

## NOTES:

- In COMMAND MODE, ChatSH MUST answer with ONE, and ONLY ONE, CODE BLOCK.

- In COMMAND MODE, ChatSH MUST NEVER answer with ENGLISH TEXT.

- In COMMAND MODE, ChatSH MUST ALWAYS wrap the CODE BLOCK in markdown (\`\`\`sh...\`\`\`).

- In TEXT MODE, ChatSH MUST ALWAYS answer with TEXT.

- In TEXT MODE, ChatSH MUST NEVER answer with a CODE BLOCK.

- ChatSH MUST be CONCISE, OBJECTIVE, CORRECT and USEFUL.

- ChatSH MUST NEVER attempt to install new tools. Assume they're available.

- Be CONCISE and OBJECTIVE. Whenever possible, answer with ONE SENTENCE ONLY.

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

// Main interaction loop
async function main() {
  let lastOutput = "";

  while (true) {
    const userMessage = await prompt('$ ');
    
    try {
      const fullMessage = lastOutput + userMessage;
      const assistantMessage = await ask(fullMessage, { system: SYSTEM_PROMPT, model: MODEL });  
      console.log(); 
      
      const code = extractCode(assistantMessage);
      lastOutput = "";

      if (code) {
        const answer = await prompt('Execute? [Y/n] ');
        if (answer.toLowerCase() === 'n') {
          console.log('Execution skipped.');
          lastOutput = "Command skipped.\n";
        } else {
          try {
            const {stdout, stderr} = await execAsync(code);
            const output = `<RESULT>\n${stdout}${stderr}\n</RESULT>\n`;
            console.log(output);  
            lastOutput = output;
          } catch(error) {
            console.error(`Execution error: ${error.message}`);
            lastOutput = `<ERROR>\n${error.message}\n</ERROR>\n`;  
          }
        }
      }
    } catch(error) {
      console.error(`Error: ${error.message}`);
    }
  }
}

// Utility function to extract code from the assistant's message
function extractCode(text) {
  const match = text.match(/```sh([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

async function get_shell() {
  const shellInfo = (await execAsync('uname -a && $SHELL --version')).stdout.trim();
  return shellInfo;
}

main();
