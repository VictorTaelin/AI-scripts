#!/usr/bin/env node

// This script analyzes Agda files to extract and list their dependencies.
// It takes a single Agda file as input and outputs a list of all its dependencies.

// Functionality:
// 1. Parses the input Agda file and extracts import statements.
// 2. Recursively processes imported modules to build a complete dependency tree.
// 3. Handles both 'import' and 'open import' statements.
// 4. Resolves file paths for imported modules.
// 5. Outputs a list of unique dependencies (excluding the input file itself).

// Circular Dependencies:
// - The script does check for circular dependencies by maintaining a 'visited' set.
// - It prevents infinite recursion by not revisiting already processed files.
// - However, it does not explicitly report or handle circular dependencies in any special way.

// Indirect Imports:
// - The script does handle indirect imports.
// - If module A imports B, and B imports C, the script will include C in A's dependencies.
// - This is achieved through recursive processing of each imported module.

// Supported Agda Import Syntax:
// 1. Single-line imports:
//    - import ModuleName
//    - open import ModuleName
// 2. Multi-line imports (with parentheses):
//    - import ModuleName
//      (submodule1; submodule2)
// 3. Qualified imports:
//    - import Data.List as List
// 4. Imports with 'using' clause:
//    - import ModuleName using (definition1; definition2)

// Limitations:
// - The script may not handle all possible Agda import syntaxes or edge cases.
// - It does not differentiate between public and private imports.
// - It does not handle conditional imports or other advanced Agda module system features.

import fs from 'fs';
import path from 'path';

function extract_dependencies(file_path, visited = new Set(), all_dependencies = new Map()) {
  const absolute_path = path.resolve(file_path);
  
  if (visited.has(absolute_path)) {
    return all_dependencies;
  }
  visited.add(absolute_path);

  try {
    const content = fs.readFileSync(absolute_path, 'utf8');
    const lines = content.split('\n');
    process_lines(lines, absolute_path, visited, all_dependencies);
    return all_dependencies;
  } catch (error) {
    console.error(`Error processing file: ${error.message}`);
    return all_dependencies;
  }
}

function process_lines(lines, file_path, visited, all_dependencies) {
  let multiline_import = '';
  for (const line of lines) {
    if (multiline_import) {
      multiline_import += ' ' + line.trim();
      if (line.includes(')')) {
        handle_import_line(multiline_import, file_path, visited, all_dependencies);
        multiline_import = '';
      }
    } else if (is_import_line(line)) {
      if (line.includes('(') && !line.includes(')')) {
        multiline_import = line.trim();
      } else {
        handle_import_line(line, file_path, visited, all_dependencies);
      }
    } else if (is_open_line(line)) {
      handle_open_line(line, file_path, visited, all_dependencies);
    }
  }
}

function is_import_line(line) {
  return /^(open\s+import|import)\s+/.test(line);
}

function is_open_line(line) {
  return /^open\s+/.test(line);
}

function handle_import_line(line, file_path, visited, all_dependencies) {
  const module_name = extract_module_name(line);
  const imported_file_path = resolve_import(file_path, module_name);
  if (imported_file_path) {
    all_dependencies.set(imported_file_path, []);
    extract_dependencies(imported_file_path, visited, all_dependencies);
  } else {
    all_dependencies.set(module_name, []);
  }
}

function handle_open_line(line, file_path, visited, all_dependencies) {
  const module_name = extract_module_name(line);
  const imported_file_path = resolve_import(file_path, module_name);
  if (imported_file_path) {
    all_dependencies.set(imported_file_path, []);
    extract_dependencies(imported_file_path, visited, all_dependencies);
  }
}

function extract_module_name(line) {
  const parts = line.trim().split(/\s+/);
  let module_name = parts[parts.indexOf('import') + 1];
  // Remove everything after 'using' keyword
  const using_index = module_name.indexOf('using');
  if (using_index !== -1) {
    module_name = module_name.slice(0, using_index).trim();
  }
  return module_name;
}

function resolve_import(current_file, module_name) {
  const dir = path.dirname(current_file);
  const possible_paths = [
    path.join(dir, `${module_name}.agda`),
    path.join(dir, ...module_name.split('.')) + '.agda',
    path.join(dir, module_name.replace(/\./g, '/') + '.agda'),
    path.join(path.dirname(dir), ...module_name.split('.')) + '.agda',
    path.join(path.dirname(dir), module_name.replace(/\./g, '/') + '.agda')
  ];

  for (const file_path of possible_paths) {
    if (fs.existsSync(file_path)) {
      return path.resolve(file_path);
    }
  }

  return null;
}

function fix_file_path(filepath) {
  if (!filepath) {
    console.error(`Usage: agda-deps <file.agda>`);
    process.exit(1);
  }
  let extension = filepath.slice(-5);
  if (extension[0] === '.') {
    if (extension !== ".agda") {
      console.error("File should be an Agda file or no extension def.");
      process.exit(1);
    } else {
      return filepath;
    }
  } else {
    return filepath + ".agda";
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: agda-deps <file.agda>');
    process.exit(1);
  }

  const file_path = args[0];
  const fixed_file_path = fix_file_path(file_path);
  const dependencies = extract_dependencies(fixed_file_path);

  if (dependencies.size > 0) {
    for (const [source, _] of dependencies) {
      if (source !== path.resolve(fixed_file_path)) {
        if (source.endsWith('.agda')) {
          console.log(source.slice(0, -5));
        } else {
          console.log(source);
        }
      }
    }
  } else {
    // print nothing so the coder script handles it correctly
  }
}

main();
