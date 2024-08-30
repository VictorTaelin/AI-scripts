#!/usr/bin/env node

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
  for (const line of lines) {
    if (is_import_line(line)) {
      handle_import_line(line, file_path, visited, all_dependencies);
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
  return parts[parts.length - 1];
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
        console.log(source);
      }
    }
  } else {
    console.log('No dependencies found.');
  }
}

main();
