#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { chat, MODELS } from './Chat.mjs';
import kind_clean from "./kind_clean.mjs";

// Included examples
const examples = [
  "Base/Bool/Bool",
  "Base/Bool/and",
  "Base/Bool/if",
  "Base/Maybe/Maybe",
  "Base/Nat/Nat",
  "Base/Nat/add",
  "Base/Nat/half",
  "Base/Nat/eq",
  "Base/List/List",
  "Base/List/head",
  "Base/List/fold",
  "Base/Bits/Bits",
  "Base/Bits/xor",
  "Base/Bits/eq",
  "Base/BinTree/BinTree",
  "Base/BinTree/count",
];

// Find the 'kindbook' or 'agdabook' directory
async function findBookDir(currentDir) {
  while (!['kindbook', 'agdabook'].includes(path.basename(currentDir))) {
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error('kindbook or agdabook directory not found');
    }
    currentDir = parentDir;
  }
  return path.dirname(currentDir);
}

// Loads an example from the 'kindbook' or 'agdabook'.
async function load_example(name, ext) {
  var bookType = ext === '.kind' ? 'kind' : 'agda';
  var parentDir = await findBookDir(process.cwd());
  var filePath = fullPath(path.join(parentDir, `${bookType}book`, `${name}${ext}`));
  console.log("loading", filePath);
  try {
    var content = await fs.readFile(filePath, 'utf-8');
    if (ext === ".kind") {
      content = kind_clean(content);
    }
    return content;
  } catch (error) {
    console.error(`Error loading ${filePath}:`, error.message);
    return '';
  }
}

// System prompt
const SYSTEM_PROMPT = `
You are an expert Agda <-> Kind compiler. Your task is to translate Agda to/from Kind.

Follow these rules:

- Preserve the source algorithm form and structure as closely as possible.
- Represent Agda's 'Char' as a Kind 'U32', and Agda's 'String' as a Kind '(List U32)'.
- Always use holes ('_') for type parameters, since these can be inferred.
- Do not compile infix operators (like '+') to Kind. Just skip them completely.
- Always use kebab-case on Kind, just as in Agda. Do not use snake_case.
- Remove the 'Base/' directory in Kind (ex: 'Base/Nat/' => 'Nat/').

Avoid the following common errors:

- In Kind, do not start names with '_'. That parses as a hole.

About Kind:

Kind is a minimal proof language. Below are some idiomatic Kind examples.

${(await Promise.all(examples.map(async (example) => `
# ${example}.agda

\`\`\`agda
${(await load_example(example, '.agda')).trim()}
\`\`\`

# ${example}.kind

\`\`\`kind
${(await load_example(example, '.kind')).trim()}
\`\`\`
`))).join('\n')}

The examples above demonstrate the most idiomatic Kind style. When encountering
code that deviates from this style, update it to conform to these conventions.

Note that, sometimes, a draft will be provided. When that is the case, review it
for errors and oversights that violate the guides, and provide a final version.
Now, generate/update the last file marked as (missing) or (draft).
Answer in the EXACT following format:

# Path/to/file.xyz

\`\`\`lang
<updated_file_here>
\`\`\`

DONE.
`.trim();

//console.log(SYSTEM_PROMPT);

async function getDeps(file) {
  const ext = path.extname(file);
  let command = '';

  if (ext === '.agda') {
    command = `agda-deps ${file} --recursive`;
  } else if (ext === '.kind') {
    command = `kind-deps ${file} --recursive`;
  } else {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  try {
    const output = execSync(command, { encoding: 'utf-8' });
    return output.trim().split('\n').filter(x => x !== "");
  } catch (error) {
    console.error(`Error getting dependencies for ${file}:`, error.message);
    return [];
  }
}

function fullPath(filePath) {
  var fullPath = path.resolve(filePath);
  if (fullPath.endsWith(".kind")) {
    return fullPath.replace("/agdabook/","/kindbook/").replace("/Base/","/");
  }
  if (fullPath.endsWith(".agda")) {
    return fullPath.replace("/kindbook/","/agdabook/");
  }
}

async function readFileContent(filePath) {
  try {
    return await fs.readFile(fullPath(filePath), 'utf-8');
  } catch (error) {
    return '(missing)';
  }
}

function parseResponse(response) {
  const files = [];
  const lines = response.split('\n');
  let currentFile = null;
  let currentCode = '';
  let inCodeBlock = false;
  let currentLanguage = '';

  for (const line of lines) {
    if (line.startsWith('# ')) {
      if (currentFile) {
        files.push({ path: currentFile, code: currentCode.trim(), language: currentLanguage });
      }
      currentFile = line.slice(2).trim();
      currentCode = '';
      inCodeBlock = false;
    } else if (line.startsWith('```kind')) {
      inCodeBlock = true;
      currentLanguage = 'kind';
    } else if (line.startsWith('```agda')) {
      inCodeBlock = true;
      currentLanguage = 'agda';
    } else if (line.startsWith('```') && inCodeBlock) {
      inCodeBlock = false;
    } else if (inCodeBlock) {
      currentCode += line + '\n';
    }
  }

  if (currentFile) {
    files.push({ path: currentFile, code: currentCode.trim(), language: currentLanguage });
  }

  return files;
}

async function main() {
  if (process.argv.length < 3) {
    console.log("Usage: agda2kind <Path/To/File.[agda|kind]> [<model>]");
    process.exit(1);
  }

  const inputFile = process.argv[2];
  const model = process.argv[3] || 'c'; // Default to Claude if no model is specified

  if (!MODELS[model]) {
    console.log(`Invalid model. Available models: ${Object.keys(MODELS).join(', ')}`);
    process.exit(1);
  }

  const deps = (await getDeps(inputFile)).filter(x => x.slice(0,5) != "Agda/");
  let context = '';
  const missingDeps = [];

  for (const dep of deps) {
    const sourceExt = path.extname(inputFile);
    const targetExt = sourceExt === '.agda' ? '.kind' : '.agda';
    const sourceFile = dep;
    const targetFile = dep.replace(/\.[^.]+$/, targetExt);

    const sourceContent = await readFileContent(sourceFile);
    const targetContent = await readFileContent(targetFile);

    //console.log(dep, !!sourceContent, !!targetContent);

    if (sourceContent === '(missing)') {
      missingDeps.push(sourceFile);
    } else if (targetContent === '(missing)') {
      missingDeps.push(targetFile);
    } else {
      const sourceLanguage = sourceExt === '.agda' ? 'agda' : 'kind';
      const targetLanguage = targetExt === '.agda' ? 'agda' : 'kind';
      context += `# ${sourceFile}\n\n\`\`\`${sourceLanguage}\n${sourceContent}\n\`\`\`\n\n`;
      context += `# ${targetFile}\n\n\`\`\`${targetLanguage}\n${targetContent}\n\`\`\`\n\n`;
    }
  }

  if (missingDeps.length > 0) {
    console.error("ERROR: Missing dependencies. Generate these files first:");
    missingDeps.forEach(dep => console.error(`- ${fullPath(dep)}`));
    process.exit(1);
  }

  const mainFileContent = await readFileContent(inputFile);
  const mainExt = path.extname(inputFile);
  const mainLanguage = mainExt === '.agda' ? 'agda' : 'kind';
  context += `# ${inputFile}\n\n\`\`\`${mainLanguage}\n${mainFileContent}\n\`\`\`\n\n`;

  // Add the corresponding file for the input file as a draft if it exists, otherwise as (missing)
  const otherInputExt = mainExt === '.agda' ? '.kind' : '.agda';
  const otherInputFile = inputFile.replace(/\.[^.]+$/, otherInputExt);
  const otherInputLanguage = otherInputExt === '.agda' ? 'agda' : 'kind';
  const otherInputContent = await readFileContent(otherInputFile);
  
  if (otherInputContent !== '(missing)') {
    context += `# ${otherInputFile} (draft)\n\n\`\`\`${otherInputLanguage}\n${otherInputContent}\n\`\`\`\n\n`;
  } else {
    context += `# ${otherInputFile} (missing)\n\n\`\`\`${otherInputLanguage}\n...\n\`\`\`\n\n`;
  }

  const ask = chat(model);
  const prompt = `${context}\n\nGenerate or update the file marked as (missing) or (draft) now:`;

  // Generate and save the compiled output
  const response = await ask(prompt, { system: SYSTEM_PROMPT, model, system_cacheable: true });
  console.log("\n");

  const files = parseResponse(response);

  for (const file of files) {
    if (path.extname(file.path) === otherInputExt) {
      const dirPath = path.dirname(file.path);
      await fs.mkdir(dirPath, { recursive: true });
      await fs.writeFile(fullPath(file.path), file.code);
      console.log(`Saved: ${fullPath(file.path)}`);
    }
  }
  
  // Save the final prompt to a log file
  const logDir = path.join(process.env.HOME || process.env.USERPROFILE, '.ai', 'agda2kind_history');
  await fs.mkdir(logDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const logFile = path.join(logDir, `${timestamp}_${model}.log`);
  await fs.writeFile(logFile, prompt);
  console.log(`Saved prompt log: ${logFile}`);
}

main().catch(console.error);
