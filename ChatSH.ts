#!/usr/bin/env bun

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { Command } from 'commander';
import { GenAI, resolveModelSpec } from './GenAI';
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
 * Generates the system prompt for the AI.
 * @returns The formatted system prompt.
 */
function getSystemPrompt(): string {
  return `
This conversation is running inside a terminal session, on ${os.platform()} ${os.release()}.

To better assist the user, you can run bash commands on this computer.

To run a bash command, include a script in your answer, inside <RUN/> tags:

<RUN>
shell_script_here
</RUN>

For example, to create a file, you can write:

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

Note: only include bash commands when explicitly asked. Example:
- "save a demo JS file": use a RUN command to save it to disk
- "show a demo JS function": use normal code blocks, no RUN
- "what colors apples have?": just answer conversationally

IMPORTANT: Be CONCISE and DIRECT in your answers.
Do not add any information beyond what has been explicitly asked.
`.trim();
}

/**
 * Main application logic, handling user input and AI interactions.
 */
async function main() {
  const program = new Command();
  program
    .argument('<model>', 'Model shortcode')
    .parse(process.argv);

  const [model] = program.args;
  const resolvedSpec = resolveModelSpec(model);
  const resolvedModelName = `${resolvedSpec.vendor}:${resolvedSpec.model}:${resolvedSpec.thinking}`;
  const ai = await GenAI(model);

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

  const welcomeMessage = `\x1b[1mWelcome to ChatSH!\x1b[0m\nModel: ${resolvedModelName}`;
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

    if (line.startsWith('!')) {
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

      var response;
      try {
        response = await ai.ask(fullMessage, { system: getSystemPrompt(), stream: true }) as string;
      } catch (e) {
        response = "<error>";
      }

      log(response);
      history.push(response);

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
    rl.prompt();
  });
}

main();
