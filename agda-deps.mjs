#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

function extractImports(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const imports = [];

  for (const line of lines) {
    if (line.trim().startsWith('--')) continue; // Skip comments
    const match = line.match(/^\s*(open\s+)?(import)\s+([A-Za-z0-9_.]+)/);
    if (match) {
      imports.push(match[3]);
    }
  }

  return imports;
}

function resolveImportPath(importName) {
  const parts = importName.split('.');
  const possiblePath = path.join(process.cwd(), ...parts) + '.agda';
  return fs.existsSync(possiblePath) ? possiblePath : null;
}

function getDependencies(filePath, recursive = false, visited = new Set()) {
  const absolutePath = path.resolve(filePath);
  if (visited.has(absolutePath)) return [];

  visited.add(absolutePath);
  const imports = extractImports(absolutePath);
  
  let dependencies = imports
    .map(resolveImportPath)
    .filter(Boolean);

  if (recursive) {
    for (const dep of dependencies) {
      dependencies = dependencies.concat(getDependencies(dep, true, visited));
    }
  }

  return [...new Set(dependencies)];
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: agda-deps <file.agda> [-r|--recursive]');
    process.exit(1);
  }

  const filePath = args[0];
  const recursive = args.includes('-r') || args.includes('--recursive');

  try {
    const dependencies = getDependencies(filePath, recursive);
    dependencies.forEach(dep => console.log(path.relative(process.cwd(), dep)));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
