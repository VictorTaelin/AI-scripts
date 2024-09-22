#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

function extractImports(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const importRegex = /from\s+['"](.+?)['"]/g;
  const imports = [];
  let match;

  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  return imports;
}

function resolveImportPath(importPath, currentDir) {
  const fullPath = path.resolve(currentDir, importPath);
  const extensions = ['.ts', '.tsx', '.js', '.jsx'];
  
  for (const ext of extensions) {
    const pathWithExt = fullPath + ext;
    if (fs.existsSync(pathWithExt)) {
      return pathWithExt;
    }
  }

  // If no file with extension found, try as directory with index file
  for (const ext of extensions) {
    const indexPath = path.join(fullPath, `index${ext}`);
    if (fs.existsSync(indexPath)) {
      return indexPath;
    }
  }

  return fullPath; // Return the path even if it doesn't exist
}

function getDependencies(filePath, recursive = false, visited = new Set()) {
  const absolutePath = path.resolve(filePath);
  if (visited.has(absolutePath)) return [];

  visited.add(absolutePath);
  const currentDir = path.dirname(absolutePath);
  const imports = extractImports(absolutePath);
  let dependencies = imports.map(imp => resolveImportPath(imp, currentDir));

  if (recursive) {
    for (const dep of dependencies) {
      if (fs.existsSync(dep)) {
        dependencies = dependencies.concat(getDependencies(dep, true, visited));
      }
    }
  }

  return [...new Set(dependencies)];
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: ts-deps <file.ts> [-r|--recursive]');
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
