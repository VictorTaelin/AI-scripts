//./RepoManager.ts//

# RepoManager

RepoManager is a TypeScript library designed to manage codebases by breaking
files into chunks—blocks of non-empty lines separated by blank lines. Each chunk
gets a unique, stable 12-digit ID, making it easy to view or edit specific parts
of your code and sync changes to disk automatically.

## What It Does

- Splits files into chunks with stable IDs.
- Lets you view or edit chunks selectively.
- Automatically saves changes to the filesystem.
- Filters files with regex patterns.

Here's how to use it:

### Step 1: Load a Repository

Use `RepoManager.load()` to load a directory into memory.

```typescript
import { RepoManager } from 'repomanager';

// Load './my-repo', skipping 'node_modules'
const repo = await RepoManager.load('./my-repo', {
  exclude: [/node_modules/]
});
```

Options:

- `exclude`: Regex to skip files (e.g., node_modules).
- `include`: Regex to include specific files (defaults to all).
- Ignores files listed in .cshignore if it exists.

### Step 2: View the Repository

Use `view()` to see your codebase, expanding specific chunks by ID.

```typescript
console.log(repo.view({ '000000000000': true }));
```

Output format:

```text
[file/path.js]
000000000000:
function hello() {
  console.log("Hello, world!");
}
000001000000:
console.log("Shortened chunk")...
```

Chunks not listed in `shownChunks` are shortened (e.g., first line + ...).

### Step 3: Edit Chunks

Use `edit()` to modify chunks by ID. Changes sync to disk automatically.

Replace a Chunk:

```typescript
await repo.edit({
  '000001000000': `
function add(a, b) {
  return a + b;
}`
});
```

TODO: add below documentation for .refresh

### Step 4: Refresh the Repository

Use `refresh()` to scan for new tracked files not yet in memory. New files are split into chunks and added to the repository.

```typescript
await repo.refresh({
  exclude: [/node_modules/],
  include: [/\.ts$/]  // Only refresh TypeScript files
});
```

Options:

- `exclude`: Regex to skip files during refresh.
- `include`: Regex to specify which files to refresh (defaults to all).
- Respects .cshignore for additional filtering.
