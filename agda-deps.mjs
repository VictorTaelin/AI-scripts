#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

// TODO: enhance testing and check corner cases

// This script extracts Agda file imports, similarly to the ts-deps script.
// It checks imports in the following agda syntax:
// open import Module.Something -> Module.Something/{*}
//


/**
 * Extracts dependencies from an Agda file and its imported modules.
 * @param {string} file_path - Path to the Agda file.
 * @param {Set} visited - Set of already visited file paths.
 * @param {Map} all_dependencies - Map to store all dependencies.
 * @returns {Map} Map of all dependencies.
 */
function extract_dependencies(file_path, visited = new Set(), all_dependencies = new Map()) {
  if (visited.has(file_path)) {
    return all_dependencies;
  }
  visited.add(file_path);

  try {
    const content = fs.readFileSync(file_path, 'utf8');
    const lines = content.split('\n');
    process_lines(lines, file_path, visited, all_dependencies);
    return all_dependencies;
  } catch (error) {
    console.error(`Error processing file: ${error.message}`);
    return all_dependencies;
  }
}

/**
 * Processes lines of an Agda file to extract dependencies.
 * @param {string[]} lines - Array of lines from the Agda file.
 * @param {string} file_path - Path to the current Agda file.
 * @param {Set} visited - Set of already visited file paths.
 * @param {Map} all_dependencies - Map to store all dependencies.
 */
function process_lines(lines, file_path, visited, all_dependencies) {
  let current_import = null;
  let using_list = [];
  let in_multi_line_import = false;

  for (const line of lines) {
    if (is_import_line(line)) {
      handle_import_line(line, current_import, using_list, all_dependencies, file_path, visited);
      [current_import, using_list, in_multi_line_import] = update_import_state(line);
    } else if (in_multi_line_import) {
      [using_list, in_multi_line_import] = handle_multi_line_import(line, using_list);
      if (!in_multi_line_import) {
        update_dependencies(all_dependencies, current_import, using_list);
        current_import = null;
        using_list = [];
      }
    } else if (is_open_line(line)) {
      handle_open_line(line, all_dependencies);
    } else if (current_import && !line.trim()) {
      update_dependencies(all_dependencies, current_import, using_list);
      current_import = null;
      using_list = [];
    }
  }

  if (current_import) {
    update_dependencies(all_dependencies, current_import, using_list);
  }
}

/**
 * Checks if a line is an import statement.
 * @param {string} line - A line from the Agda file.
 * @returns {boolean} True if the line is an import statement, false otherwise.
 */
function is_import_line(line) {
  return /^(open\s+import|import)\s+/.test(line);
}

/**
 * Handles an import line, updating dependencies and recursively checking imported modules.
 * @param {string} line - The import line.
 * @param {string} current_import - The current import being processed.
 * @param {string[]} using_list - List of items being used from the import.
 * @param {Map} all_dependencies - Map to store all dependencies.
 * @param {string} file_path - Path to the current Agda file.
 * @param {Set} visited - Set of already visited file paths.
 */
function handle_import_line(line, current_import, using_list, all_dependencies, file_path, visited) {
  if (current_import) {
    update_dependencies(all_dependencies, current_import, using_list);
  }

  const [module_name, as_name] = extract_module_name(line);
  if (as_name) {
    update_dependencies(all_dependencies, module_name, ['== ' + as_name]);
  }

  const imported_file_path = resolve_import(file_path, module_name);
  if (imported_file_path) {
    extract_dependencies(imported_file_path, visited, all_dependencies);
  }
}

/**
 * Extracts the module name and potential 'as' name from an import line.
 * @param {string} line - The import line.
 * @returns {string[]} An array containing the module name and potential 'as' name.
 */
function extract_module_name(line) {
  const module_part = line.split(/\s+using/)[0].trim().split(/\s+/).slice(1).join(' ');
  const as_match = module_part.match(/(.+)\s+as\s+(.+)/);
  return as_match ? [as_match[1], as_match[2]] : [module_part, null];
}

/**
 * Updates the import state based on the current line.
 * @param {string} line - The current line being processed.
 * @returns {Array} An array containing the new current_import, using_list, and in_multi_line_import state.
 */
function update_import_state(line) {
  const module_name = extract_module_name(line)[0];
  const using_match = line.match(/using\s*\((.*?)\)/);
  const using_list = using_match ? using_match[1].split(/\s*;\s*/) : [];
  const in_multi_line_import = line.trim().endsWith('using (');
  return [module_name, using_list, in_multi_line_import];
}

/**
 * Handles a multi-line import statement.
 * @param {string} line - The current line being processed.
 * @param {string[]} using_list - The current list of items being used.
 * @returns {Array} An array containing the updated using_list and in_multi_line_import state.
 */
function handle_multi_line_import(line, using_list) {
  const items = line.trim().replace(/^\(|\)$/g, '').split(/\s*;\s*/);
  const new_using_list = using_list.concat(items.filter(item => item !== ''));
  const in_multi_line_import = !line.trim().endsWith(')');
  return [new_using_list, in_multi_line_import];
}

/**
 * Checks if a line is an 'open' statement.
 * @param {string} line - A line from the Agda file.
 * @returns {boolean} True if the line is an 'open' statement, false otherwise.
 */
function is_open_line(line) {
  return line.trim().startsWith('open');
}

/**
 * Handles an 'open' line, updating dependencies accordingly.
 * @param {string} line - The 'open' line.
 * @param {Map} all_dependencies - Map to store all dependencies.
 */
function handle_open_line(line, all_dependencies) {
  const open_match = line.match(/^open\s+(\S+)(?:\s+using\s*\((.*?)\))?/);
  if (open_match) {
    const module_name = open_match[1];
    const open_using_list = open_match[2] ? open_match[2].split(/\s*;\s*/) : ['*'];
    update_dependencies(all_dependencies, module_name, open_using_list);
  }
}

/**
 * Updates the dependencies map with new information.
 * @param {Map} all_dependencies - Map to store all dependencies.
 * @param {string} module_name - Name of the module being imported.
 * @param {string[]} using_list - List of items being used from the import.
 */
function update_dependencies(all_dependencies, module_name, using_list) {
  const current_list = all_dependencies.get(module_name) || [];
  const new_list = [...new Set([...current_list, ...using_list])];
  all_dependencies.set(module_name, new_list);
}

/**
 * Resolves the file path for an imported module.
 * @param {string} current_file - Path to the current Agda file.
 * @param {string} module_name - Name of the module being imported.
 * @returns {string|null} Resolved file path or null if not found.
 */
function resolve_import(current_file, module_name) {
  const dir = path.dirname(current_file);
  const file_name = module_name.split(".")[1];
  const possible_paths = [
    path.join(dir, `${module_name}.agda`),
    path.join(dir, ...module_name.split('.')) + '.agda',
    path.join(dir, (file_name ? file_name : "")) + '.agda'
  ];

  for (const file_path of possible_paths) {
    if (fs.existsSync(file_path)) {
      return file_path;
    }
  }

  return null;
}

/**
 * Fixes the file path by adding the .agda extension if missing.
 * @param {string} filepath - The input file path.
 * @returns {string} The fixed file path.
 */
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
    for (const [source, imported] of dependencies) {
      let imported_fixed = imported.length > 0 ? imported.join(', ') : "*";
      console.log(`${source}/{${imported_fixed}}`);
    }
  } else {
    console.log('No dependencies found.');
  }
}

main();
