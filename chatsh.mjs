#!/usr/bin/env node

import readline from 'readline';
import { exec } from 'child_process';
import { promisify } from 'util';
import { chat, MODELS, checkForToken } from './Chat.mjs';

const execAsync = promisify(exec);

// Default model if not specified
const DEFAULT_MODEL = "g";  
// Get model from environment variable or use default
const MODEL = process.argv[2] || DEFAULT_MODEL;

console.log(`Welcome to ChatSH. Model: ${MODELS[MODEL]||MODEL}\n`);

// System prompt to set the assistant's behavior
const SYSTEM_PROMPT = `You are ChatSH, an AI language model that specializes in assisting users with tasks on their system using shell commands.

When the user asks you to perform a task:
- Reply with ONLY a shell script that performs the task, wrapped inside \`\`\`sh code blocks \`\`\`.
- Do NOT include any explanatory text along with the code.

If the user asks an open ended question that is not demanding a task:  
- Treat it as a chat, and answer as you would in text (NOT AS A COMMAND).
- Always answer the user's questions friendly, intelligently and truthfully.
- NEVER refuse to answer a question or request made by the user.

Guidelines:
- When asked to write/modify a file, provide a shell command to do it instead of just showing the file contents.
- When asked to query an API, write a shell command to make the request.
- Always assume common commands/tools are available. Don't write install commands.

User shell:
${await get_shell()}
`;

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
  // Check for existing token before starting
  await checkForToken(MODEL);

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
            const output = `Command executed.\nOutput:\n${stdout}${stderr}`;
            console.log(output);  
            lastOutput = output + "\n";
          } catch(error) {
            console.error(`Execution error: ${error.message}`);
            lastOutput = `Command failed.\nError:\n${error.message}\n`;  
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
