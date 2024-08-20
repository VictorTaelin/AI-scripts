#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

function extract_dependencies(file_path, visited = new Set()) {
  if (visited.has(file_path)) {
    return new Map();
  }
  visited.add(file_path);

  try {
    const content = fs.readFileSync(file_path, 'utf8');
    const source_file = ts.createSourceFile(
      file_path,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const dependencies = new Map();

    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const module_specifier = node.moduleSpecifier.text;
        const import_clause = node.importClause;
        if (import_clause) {
          if (import_clause.name) {
            dependencies.set(module_specifier, import_clause.name.text);
          } else if (import_clause.namedBindings) {
            if (ts.isNamedImports(import_clause.namedBindings)) {
              const imports = import_clause.namedBindings.elements.map(e => e.name.text);
              dependencies.set(module_specifier, `{${imports.join(', ')}}`);
            } else if (ts.isNamespaceImport(import_clause.namedBindings)) {
              dependencies.set(module_specifier, `* as ${import_clause.namedBindings.name.text}`);
            }
          }
        } else {
          dependencies.set(module_specifier, '');
        }

        // Recursively extract dependencies from the imported file
        const imported_file_path = resolve_import(file_path, module_specifier);
        if (imported_file_path) {
          const nested_dependencies = extract_dependencies(imported_file_path, visited);
          for (const [nested_source, nested_imported] of nested_dependencies) {
            if (!dependencies.has(nested_source)) {
              dependencies.set(nested_source, nested_imported);
            }
          }
        }
      } else if (ts.isImportEqualsDeclaration(node)) {
        if (ts.isExternalModuleReference(node.moduleReference)) {
          const module_specifier = node.moduleReference.expression.text;
          dependencies.set(module_specifier, node.name.text);
        }
      } else if (ts.isCallExpression(node) && node.expression.text === 'require') {
        if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
          const module_specifier = node.arguments[0].text;
          dependencies.set(module_specifier, '');
        }
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
          const module_specifier = node.arguments[0].text;
          dependencies.set(module_specifier, '');
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(source_file);

    return dependencies;
  } catch (error) {
    console.error(`Error processing file: ${error.message}`);
    return new Map();
  }
}

function resolve_import(current_file, import_path) {
  if (import_path.startsWith('.')) {
    const resolved_path = path.resolve(path.dirname(current_file), import_path);
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
    for (const ext of extensions) {
      const full_path = resolved_path + ext;
      if (fs.existsSync(full_path)) {
        return full_path;
      }
    }
  }
  return null;
}

function fix_file_path(filepath) {
  if (!filepath) {
    console.error(`Usage: ts-deps <file.ts>`);
    process.exit(1);
  }
  // check if is a ts file | adds .ts if its a definition
  let [file, extension] = filepath.split('.');
  if (extension) {
    // if is not a .ts file, exit
    if (extension != "ts") {
      console.error("File should be a typescript file or no extension def.");
      process.exit(1);
    } else {
      return filepath;
    }
  } else {
    // adds extension to definition
    return filepath + ".ts";
  }
}

function clean_imported_output(imported) {
  return (imported.replace("}", "")).replace("{", "");
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: ts-deps <file.ts>');
    process.exit(1);
  }

  const file_path = args[0];
  const fixed_file_path = fix_file_path(file_path);
  const dependencies = extract_dependencies(fixed_file_path);

  if (dependencies.size > 0) {
    for (const [source, imported] of dependencies) {
      const out_imported = clean_imported_output(imported);
      console.log(`${source}/{${out_imported}}`);
    }
  } else {
    console.log('No dependencies found.');
  }
}

main();
