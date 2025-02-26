#!/usr/bin/env bun

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { Command } from 'commander';
import { GenAI, tokenCount, MODELS } from './GenAI';
import { RepoManager } from './RepoManager';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Executes a shell command and returns its output or an error message.
 * @param script The shell script to execute.
 * @returns The command output or error message.
 */
async function executeCommand(script: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(script);
    return stdout + stderr;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Generates the system prompt for the AI, including context management instructions.
 * @param repo The repository manager instance.
 * @param shownChunks Record of chunks to show or hide.
 * @returns The formatted system prompt.
 */

function getSystemPrompt(repo: RepoManager, shownChunks: Record<string, boolean>): string {
  const basePrompt = `
This conversation is running inside a terminal session, on ${os.platform()} ${os.release()}.

To better assist me, I'll let you run bash commands on my computer.

To do so, include, anywhere in your answer, a bash script, as follows:

<RUN>
shell_script_here
</RUN>

For example, to create a new file, you can write:

<RUN>
cat > hello.ts << EOL
console.log("Hello, world!")
EOL
</RUN>

And to run it, you can write:

<RUN>
bun hello.ts
</RUN>

I will show you the outputs of every command you run.

Keep your answers brief and to the point.
Don't include unsolicited details.
`.trim();

  const workContext = repo.view(
    Object.fromEntries(
      Object.entries(shownChunks).filter(([_, value]) => value === true)
    ) as Record<string, true>
  );

  if (workContext.trim() === '') {
    return basePrompt;
  }

  const contextInstructions = `
Below is a shortened context of the files I'm working on.

You can issue the following context management commands:

- <SHOW id=XYZ/>: Expands a chunk.
- <HIDE id=XYZ/>: Shortens a chunk.
- <EDIT id=XYZ/>: Removes a chunk.
- <EDIT id=XYZ>new_content</EDIT>: Replaces a chunk's contents.

Include these commands anywhere in your answer, and I'll execute them.

For example, to show chunk id 000005000000, write:

<SHOW id=000005000000/>

The work context is:

${workContext}

Notes:
- Chunks are labelled with a 12-number id.
- Use that chunk id when issuing commands.
- Some chunks were shortened with a '...'.
- Expand relevant chunks before refactors.
- When issuing SHOW commands, don't issue other commands.
- Instead, wait for the next turn for it to take effect.
  `.trim();

  return `${basePrompt}\n\n${contextInstructions}`.trim();
}

/**
 * Parses a block ID from a '?' command input.
 * - Empty input after '?' returns null (show full context).
 * - 12-digit input returns as-is (full ID).
 * - Numeric input is multiplied by 1,000,000 and padded to 12 digits (partial ID).
 * - Invalid input returns undefined (error).
 * @param input The user's input string (e.g., '?', '?123', '?123456789012').
 * @returns Parsed block ID, null, or undefined.
 */
function parseBlockId(input: string): string | null | undefined {
  const trimmed = input.replace('?', '').trim();
  if (trimmed === '') {
    return null; // Show full context
  }
  if (/^\d{12}$/.test(trimmed)) {
    return trimmed; // Full ID
  }
  const num = parseFloat(trimmed);
  if (!isNaN(num)) {
    const idNum = Math.floor(num * 1000000);
    return idNum.toString().padStart(12, '0');
  }
  return undefined; // Invalid input
}

/**
 * Extracts the content of a specific block from the full context.
 * @param fullContext The complete context string.
 * @param blockId The 12-digit block ID to extract.
 * @returns The block content or an error message if not found.
 */
function extractBlockContent(fullContext: string, blockId: string): string {
  const blockPattern = new RegExp(`^${blockId}:\\s*\\n[\\s\\S]*?(?=^\\d{12}:|\\z)`, 'm');
  const match = fullContext.match(blockPattern);
  return match ? match[0].trim() : `Block ID ${blockId} not found.`;
}

/**
 * Main application logic, handling user input and AI interactions.
 */
async function main() {
  const program = new Command();
  program
    .argument('<model>', 'Model shortcode')
    .argument('[path]', 'Repository path', '.')
    .option('-i, --include <patterns>', 'Include patterns', '')
    .option('-e, --exclude <patterns>', 'Exclude patterns', '')
    .parse(process.argv);

  const [model, repoPath = '.'] = program.args;

  const includePatterns = program.opts().include
    ? program.opts().include.split(',').map((p: string) => new RegExp(p))
    : undefined;
  const excludePatterns = program.opts().exclude
    ? program.opts().exclude.split(',').map((p: string) => new RegExp(p))
    : undefined;

  const repo = await RepoManager.load(repoPath, { include: includePatterns, exclude: excludePatterns });
  const ai = await GenAI(model);

  const shownChunks: Record<string, boolean> = {};
  let aiCommandOutputs: string[] = [];
  let userCommandOutputs: string[] = [];
  const history: string[] = [];

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const logDir = path.join(homeDir, '.ai', 'chatsh3_history');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const logFile = path.join(logDir, `conversation_${timestamp}.txt`);

  function log(message: string) {
    fs.appendFileSync(logFile, message + '\n', 'utf8');
  }

  const welcomeMessage = `\x1b[1mWelcome to ChatSH!\x1b[0m\nModel: ${MODELS[model]}`;
  console.log(welcomeMessage);
  log(welcomeMessage);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[1mλ ' // Bold prompt
  });

  rl.prompt();

  rl.on('line', async (line) => {
    process.stdout.write("\x1b[0m");
    line = line.trim();
    if (line.startsWith('?')) {
      const blockId = parseBlockId(line);
      if (blockId === undefined) {
        console.log('Invalid block ID. Please enter a valid number or exactly 12 digits.');
        log(`λ ${line}\nInvalid block ID. Please enter a valid number or exactly 12 digits.`);
      } else {
        const fullContext = repo.view(
          Object.fromEntries(
            Object.entries(shownChunks).filter(([_, value]) => value === true)
          ) as Record<string, true>
        );
        let displayContext: string;
        if (blockId === null) {
          displayContext = fullContext;
        } else {
          displayContext = extractBlockContent(fullContext, blockId);
        }
        console.log(displayContext);

        const systemPromptTokenCount = tokenCount(getSystemPrompt(repo, shownChunks));
        const totalChatTokenCount = history.reduce((sum, msg) => sum + tokenCount(msg), 0);
        const totalMessages = history.length;

        console.log('\x1b[33m%s\x1b[0m', `msg_number: ${totalMessages}`);
        console.log('\x1b[33m%s\x1b[0m', `msg_tokens: ${totalChatTokenCount}`);
        console.log('\x1b[33m%s\x1b[0m', `sys_tokens: ${systemPromptTokenCount}`);
        console.log('\x1b[33m%s\x1b[0m', `tot_tokens: ${systemPromptTokenCount + totalChatTokenCount}`);

        log(`λ ${line}`);
        log(displayContext);
        log(`\x1b[33mmsg_number: ${totalMessages}\x1b[0m`);
        log(`\x1b[33mmsg_tokens: ${totalChatTokenCount}\x1b[0m`);
        log(`\x1b[33msys_tokens: ${systemPromptTokenCount}\x1b[0m`);
        log(`\x1b[33mtot_tokens: ${systemPromptTokenCount + totalChatTokenCount}\x1b[0m`);
      }
    } else if (line.startsWith('!')) {
      const cmd = line.slice(1).trim();
      const output = await executeCommand(cmd);
      console.log(output); // Print output to console
      log(`λ !${cmd}`);
      log(output);
      userCommandOutputs.push(`!${cmd}\n\\sh\n${output}\n\\\``);
    } else {
      const fullMessage = [
        ...aiCommandOutputs.map(output => `\\sh\n${output}\n\\\``),
        ...userCommandOutputs,
        line
      ].join('\n');
      log(`λ ${fullMessage}`);
      history.push(fullMessage);

      const response = await ai.ask(fullMessage, { system: getSystemPrompt(repo, shownChunks), stream: true }) as string;

      log(response);
      history.push(response);

      // Parse AI response for commands using response
      const showMatches = [...response.matchAll(/<SHOW id=([0-9]{12})\/>/g)];
      for (const match of showMatches) {
        const id = match[1];
        shownChunks[id] = true;
      }

      const hideMatches = [...response.matchAll(/<HIDE id=([0-9]{12})\/>/g)];
      for (const match of hideMatches) {
        const id = match[1];
        delete shownChunks[id];
      }

      const editMatches = [...response.matchAll(/<EDIT id=([0-9]{12})>(.*?)<\/EDIT>|<EDIT id=([0-9]{12})\/>/gs)];
      const edits: Record<string, string> = {};
      for (const match of editMatches) {
        if (match[1] && match[2] !== undefined) {
          edits[match[1]] = match[2];
        } else if (match[3]) {
          edits[match[3]] = '';
        }
      }
      if (Object.keys(edits).length > 0) {
        await repo.edit(edits);
      }

      const runMatches = [...response.matchAll(/<RUN>(.*?)<\/RUN>/gs)];
      aiCommandOutputs = [];
      for (const match of runMatches) {
        const script = match[1].trim();
        const permission = await new Promise<string>((resolve) => {
          rl.question('\x1b[31mExecute this command? [Y/N] \x1b[0m', (answer) => {
            resolve(answer.trim().toUpperCase());
          });
        });
        if (permission === 'Y' || permission === '') {
          const output = await executeCommand(script);
          console.log('\x1b[2m%s\x1b[0m', output.trim()); // Print output in dim color
          aiCommandOutputs.push(output);
          log(`Executed command:\n${script}\nOutput:\n${output}`);
        } else {
          console.log('\x1b[33mCommand skipped.\x1b[0m');
          aiCommandOutputs.push("(skipped)");
          log(`Skipped command:\n${script}`);
        }
      }
      userCommandOutputs = [];
    }
    repo.refresh({ include: includePatterns, exclude: excludePatterns });
    rl.prompt();
  });
}

main();
