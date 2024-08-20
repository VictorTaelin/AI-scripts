#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Extracts dependencies from a TypeScript file.
 * - filePath: string - Path to the TypeScript file
 * - visited: Set<string> - Set of already visited files
 * = Set<string> - Set of dependency file paths
 */
function extractDependencies(filePath, visited = new Set()) {
  if (visited.has(filePath)) {
    return new Set();
  }
  visited.add(filePath);

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const dependencies = new Set();
    visitNodes(sourceFile, filePath, dependencies, visited);
    return dependencies;
  } catch (error) {
    console.error(`Error processing file: ${error.message}`);
    return new Set();
  }
}

/**
 * Visits nodes in the AST to extract dependencies.
 * - node: ts.Node - The current node in the AST
 * - filePath: string - Path to the current file
 * - dependencies: Set<string> - Set to store dependencies
 * - visited: Set<string> - Set of already visited files
 */
function visitNodes(node, filePath, dependencies, visited) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    handleImportExportDeclaration(node, filePath, dependencies, visited);
  } else if (ts.isImportEqualsDeclaration(node)) {
    handleImportEqualsDeclaration(node, filePath, dependencies);
  } else if (ts.isCallExpression(node)) {
    handleCallExpression(node, filePath, dependencies);
  }

  ts.forEachChild(node, child => visitNodes(child, filePath, dependencies, visited));
}

/**
 * Handles import and export declarations.
 * - node: ts.ImportDeclaration | ts.ExportDeclaration - The import or export node
 * - filePath: string - Path to the current file
 * - dependencies: Set<string> - Set to store dependencies
 * - visited: Set<string> - Set of already visited files
 */
function handleImportExportDeclaration(node, filePath, dependencies, visited) {
  const moduleSpecifier = node.moduleSpecifier?.text;
  if (moduleSpecifier) {
    const resolvedPath = resolveImport(filePath, moduleSpecifier);
    if (resolvedPath) {
      dependencies.add(resolvedPath);
      const nestedDependencies = extractDependencies(resolvedPath, visited);
      nestedDependencies.forEach(dep => dependencies.add(dep));
    }
  }
}

/**
 * Handles import equals declarations.
 * - node: ts.ImportEqualsDeclaration - The import equals node
 * - filePath: string - Path to the current file
 * - dependencies: Set<string> - Set to store dependencies
 */
function handleImportEqualsDeclaration(node, filePath, dependencies) {
  if (ts.isExternalModuleReference(node.moduleReference)) {
    const moduleSpecifier = node.moduleReference.expression.text;
    const resolvedPath = resolveImport(filePath, moduleSpecifier);
    if (resolvedPath) {
      dependencies.add(resolvedPath);
    }
  }
}

/**
 * Handles call expressions (require or dynamic import).
 * - node: ts.CallExpression - The call expression node
 * - filePath: string - Path to the current file
 * - dependencies: Set<string> - Set to store dependencies
 */
function handleCallExpression(node, filePath, dependencies) {
  if ((node.expression.text === 'require' || 
       node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
      node.arguments.length > 0 && 
      ts.isStringLiteral(node.arguments[0])) {
    const moduleSpecifier = node.arguments[0].text;
    const resolvedPath = resolveImport(filePath, moduleSpecifier);
    if (resolvedPath) {
      dependencies.add(resolvedPath);
    }
  }
}

/**
 * Resolves an import path to an absolute file path.
 * - currentFile: string - Path to the current file
 * - importPath: string - The import path to resolve
 * = string | null - Resolved absolute path or null if not found
 */
function resolveImport(currentFile, importPath) {
  if (path.isAbsolute(importPath)) {
    return importPath;
  }
  
  const resolvedPath = path.resolve(path.dirname(currentFile), importPath);
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
  
  for (const ext of extensions) {
    const fullPath = resolvedPath + ext;
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  // If no file with extension is found, check if it's a directory with an index file
  for (const ext of extensions) {
    const indexPath = path.join(resolvedPath, `index${ext}`);
    if (fs.existsSync(indexPath)) {
      return indexPath;
    }
  }

  //console.warn(`Could not resolve import: ${importPath}`);
  return null;
}

/**
 * Validates and normalizes the input file path.
 * - filepath: string - The input file path
 * = string - Validated and normalized file path
 */
function validateFilePath(filepath) {
  if (!filepath) {
    console.error(`Usage: ts-deps <file.ts>`);
    process.exit(1);
  }
  
  let [file, extension] = filepath.split('.');
  if (extension) {
    if (extension !== "ts") {
      console.error("File should be a TypeScript file or have no extension.");
      process.exit(1);
    }
    return filepath;
  } else {
    return `${filepath}.ts`;
  }
}

/**
 * Main function to run the script.
 */
function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: ts-deps <file.ts>');
    process.exit(1);
  }

  const filePath = args[0];
  const validatedFilePath = validateFilePath(filePath);
  const dependencies = extractDependencies(validatedFilePath);

  if (dependencies.size > 0) {
    dependencies.forEach(dep => {
      console.log(dep);
    });
  }
}

main();
