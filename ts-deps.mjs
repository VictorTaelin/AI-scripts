#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

function extractDependencies(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const dependencies = new Map();

    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier.text;
        const importClause = node.importClause;
        if (importClause) {
          if (importClause.name) {
            dependencies.set(moduleSpecifier, importClause.name.text);
          } else if (importClause.namedBindings) {
            if (ts.isNamedImports(importClause.namedBindings)) {
              const imports = importClause.namedBindings.elements.map(e => e.name.text);
              dependencies.set(moduleSpecifier, `{${imports.join(', ')}}`);
            } else if (ts.isNamespaceImport(importClause.namedBindings)) {
              dependencies.set(moduleSpecifier, `* as ${importClause.namedBindings.name.text}`);
            }
          }
        } else {
          dependencies.set(moduleSpecifier, '');
        }
      } else if (ts.isImportEqualsDeclaration(node)) {
        if (ts.isExternalModuleReference(node.moduleReference)) {
          const moduleSpecifier = node.moduleReference.expression.text;
          dependencies.set(moduleSpecifier, node.name.text);
        }
      } else if (ts.isCallExpression(node) && node.expression.text === 'require') {
        if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
          const moduleSpecifier = node.arguments[0].text;
          dependencies.set(moduleSpecifier, '');
        }
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
          const moduleSpecifier = node.arguments[0].text;
          dependencies.set(moduleSpecifier, '');
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    return dependencies;
  } catch (error) {
    console.error(`Error processing file: ${error.message}`);
    return new Map();
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node script.js <file.ts>');
    process.exit(1);
  }

  const filePath = args[0];
  const dependencies = extractDependencies(filePath);

  if (dependencies.size > 0) {
    for (const [source, imported] of dependencies) {
      console.log(`${source}/${imported}`);
    }
  } else {
    console.log('No dependencies found.');
  }
}

main();
