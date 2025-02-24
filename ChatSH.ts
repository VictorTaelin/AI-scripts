#!/usr/bin/env bun

import { GenAI, tokenCount, MODELS } from './GenAI';
import { RepoManager } from './RepoManager';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Execute a shell command and return its output or error message
async function executeCommand(script: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(script);
    return stdout + stderr;
  } catch (error) {
    return (error as Error).message;
  }
}

// Generate system prompt without redundancy
function getSystemPrompt(repo: RepoManager, shownChunks: Record<string, boolean>): string {
  const basePrompt = `
This conversation is running inside a terminal session.

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

I will show you the outputs of every command you run.`.trim();

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

- \`<SHOW id=XYZ/>\`: Expands a chunk.
- \`<HIDE id=XYZ/>\`: Shortens a chunk.
- \`<EDIT id=XYZ/>\`: Removes a chunk.
- \`<EDIT id=XYZ>new_content</EDIT>\`: Replaces a chunk's contents.

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

// Main application logic
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
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  function log(message: string) {
    logStream.write(message + '\n');
  }

  log(`Welcome to ChatSH!\nModel: ${MODELS[model]}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[1mλ ' // Bold prompt
  });

  rl.prompt();

  rl.on('line', async (line) => {
    process.stdout.write("\x1b[0m");
    line = line.trim();
    if (line === '?') {
      const currentWorkContext = repo.view(
        Object.fromEntries(
          Object.entries(shownChunks).filter(([_, value]) => value === true)
        ) as Record<string, true>
      );
      const systemPromptTokenCount = tokenCount(getSystemPrompt(repo, shownChunks));
      const totalChatTokenCount = history.reduce((sum, msg) => sum + tokenCount(msg), 0);
      const totalMessages = history.length;

      console.log(currentWorkContext);
      console.log('\x1b[33m%s\x1b[0m', `msg_number: ${totalMessages}`);
      console.log('\x1b[33m%s\x1b[0m', `msg_tokens: ${totalChatTokenCount}`);
      console.log('\x1b[33m%s\x1b[0m', `sys_tokens: ${systemPromptTokenCount}`);
      console.log('\x1b[33m%s\x1b[0m', `tot_tokens: ${systemPromptTokenCount + totalChatTokenCount}`);

      log(`Current work context:\n${currentWorkContext}`);
      log(`Stats: msg_number=${totalMessages}, msg_tokens=${totalChatTokenCount}, sys_tokens=${systemPromptTokenCount}, tot_tokens=${systemPromptTokenCount + totalChatTokenCount}`);
    } else if (line.startsWith('!')) {
      const cmd = line.slice(1).trim();
      const output = await executeCommand(cmd);
      console.log(output); // Print output to console
      log(`User executed command: ${cmd}\nOutput:\n${output}`);
      userCommandOutputs.push(`!${cmd}\n\`\`\`sh\n${output}\n\`\`\``);
    } else {
      const fullMessage = [
        ...aiCommandOutputs.map(output => `\`\`\`sh\n${output}\n\`\`\``),
        ...userCommandOutputs,
        line
      ].join('\n');
      log(`User: ${fullMessage}`);
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
          log(`Skipped command:\n${script}`);
        }
      }
      userCommandOutputs = [];
    }
    rl.prompt();
  });
}

main();
