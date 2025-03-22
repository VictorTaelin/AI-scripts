#!/usr/bin/env bun

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as process from 'process';
import { GenAI, MODELS, tokenCount } from './GenAI';

// Define the AskOptions interface based on GenAI.ts documentation
interface AskOptions {
  system?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  system_cacheable?: boolean;
  reasoning_effort?: string;
}

// Constants
const SYSTEM: string = `You're a code completion assistant.`;
const FILL: string = "{:FILL_HERE:}";
const TASK: string = `### TASK: complete the ${FILL} part of the file above. Write ONLY the needed text to replace ${FILL} by the correct completion, including correct spacing and indentation. Include the answer inside a <COMPLETION></COMPLETION> tag.`;

// Main async function
async function main(): Promise<void> {
  // Command-line arguments with types
  const file: string = process.argv[2];
  const mini: string | undefined = process.argv[3];
  const model: string = process.argv[4] || 'c';

  // Check if file is provided
  if (!file) {
    console.log('Usage: holefill <file> [<shortened_file>] [<model_name>]');
    console.log('');
    console.log("This will complete a HOLE, written as '.?.', in <file>, using the AI.");
    console.log('A shortened file can be used to omit irrelevant parts.');
    process.exit(1);
  }

  // Initialize the AI chat instance using GenAI
  const ai = await GenAI(model);

  // Read file contents
  let file_code: string = await fs.readFile(file, 'utf-8');
  let mini_code: string = mini ? await fs.readFile(mini, 'utf-8') : file_code;

  // Process imports by replacing import lines with file contents in order
  const lines = mini_code.split('\n');
  const newLines: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\/\/\.\/(.*?)\/\/$/);
    if (match) {
      const import_path = path.resolve(path.dirname(file), match[1]);
      try {
        const import_text = await fs.readFile(import_path, 'utf-8');
        newLines.push(import_text);
      } catch (e) {
        console.log('import_file:', line, 'ERROR');
        process.exit(1);
      }
    } else {
      newLines.push(line);
    }
  }
  mini_code = newLines.join('\n');

  // Write updated mini_code to mini file if provided
  if (mini) {
    await fs.writeFile(mini, mini_code, 'utf-8');
  }

  // Prepare prompt
  const tokens: number = tokenCount(mini_code);
  const source: string = mini_code.replace('.?.', FILL);
  const prompt: string = source + '\n\n' + TASK;

  // Log prompt for debugging
  await fs.mkdir(path.join(os.homedir(), '.ai'), { recursive: true });
  await fs.writeFile(path.join(os.homedir(), '.ai', '.holefill'), `${SYSTEM}\n###\n${prompt}`, 'utf-8');

  // Display token count and model info
  console.log('token_count:', tokens);
  console.log('model_label:', MODELS[model] || model);

  // Check for hole existence
  if (mini_code.indexOf('.?.') === -1) {
    console.log('No hole found.');
    process.exit(1);
  }

  // Send prompt to AI
  const options: AskOptions = {
    system: SYSTEM,
    //max_tokens: 8192,
  };
  const replyResult = await ai.ask(prompt, options);
  let reply: string;
  if (typeof replyResult === 'string') {
    reply = replyResult;
  } else {
    reply = replyResult.messages.map((m: any) => m.content).join("\n");
  }

  // Process AI response
  reply = reply.indexOf('<COMPLETION>') === -1 ? '<COMPLETION>' + reply : reply;
  reply = reply.indexOf('</COMPLETION>') === -1 ? reply + '</COMPLETION>' : reply;

  const matches = [...reply.matchAll(/<COMPLETION>([\s\S]*?)<\/COMPLETION>/g)];
  if (matches.length) {
    const fill: string = matches[matches.length - 1][1].replace(/\$/g, '$$$$').replace(/^\n+|\n+$/g, '');
    file_code = file_code.replace('.?.', fill);
  } else {
    console.error("Error: Could not find <COMPLETION> tags in the AI's response.");
    process.exit(1);
  }

  // Write updated file
  await fs.writeFile(file, file_code, 'utf-8');

  // Save prompt history
  await savePromptHistory(SYSTEM, prompt, reply, MODELS[model] || model);
}

// Helper function to save prompt history
async function savePromptHistory(
  system: string,
  prompt: string,
  reply: string,
  model: string
): Promise<void> {
  const timestamp: string = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath: string = path.join(os.homedir(), '.ai', 'prompt_history', `${timestamp}_${model}.log`);
  const logContent: string = `SYSTEM:\n${system}\n\nPROMPT:\n${prompt}\n\nREPLY:\n${reply}\n\n`;
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, logContent, 'utf-8');
}

// Execute main function
main().catch(console.error);
