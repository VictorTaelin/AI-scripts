#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';

function getDependencies(filePath, recursive = false) {
  try {
    const command = recursive ? `kind rdeps ${filePath}` : `kind deps ${filePath}`;
    const output = execSync(command, { encoding: 'utf-8' });
    return output.trim().split('\n').map(dep => `${dep}.kind`);
  } catch (error) {
    console.error(`Error executing 'kind ${recursive ? 'rdeps' : 'deps'}': ${error.message}`);
    return [];
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: kind-deps.mjs <file> [-r|--recursive]');
    process.exit(1);
  }

  const filePath = args[0];
  const recursive = args.includes('-r') || args.includes('--recursive');

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const dependencies = getDependencies(filePath, recursive);
  dependencies.forEach(dep => console.log(dep));
}

main();

