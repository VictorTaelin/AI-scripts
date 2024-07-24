#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

function extractDependencies(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const dependencies = [];

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith('import')) {
        break;
      }

      const match = trimmedLine.match(/import\s+(?:{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/);
      if (match) {
        const [, namedImports, defaultImport, modulePath] = match;
        if (namedImports) {
          const importList = namedImports.split(',').map(i => i.trim());
          dependencies.push(`${modulePath}/{${importList.join(', ')}}`);
        } else if (defaultImport) {
          dependencies.push(`${modulePath}/{${defaultImport}}`);
        }
      }
    }

    return dependencies;
  } catch (error) {
    console.error(`Error reading file: ${error.message}`);
    return [];
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node ts-deps.mjs <file.ts>');
    process.exit(1);
  }

  const filePath = args[0];
  const dependencies = extractDependencies(filePath);

  if (dependencies.length > 0) {
    dependencies.forEach(dep => console.log(`${dep}`));
  } else {
    console.log('No dependencies found.');
  }
}

main();
