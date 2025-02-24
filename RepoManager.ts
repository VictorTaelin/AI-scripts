import fs from 'fs/promises';
import path from 'path';
import ignore from 'ignore';

// Define common file extensions for programming languages and text files (no hidden files here)
const commonExtensions = [
  'js', 'ts', 'jsx', 'tsx', // JavaScript/TypeScript
  'py', // Python
  'hs', // Haskell
  'kind', // Kind
  'bend', // Bend
  'hvm', 'hvml', 'hvms', // HVM
  'java', // Java
  'c', 'cpp', 'h', 'hpp', // C/C++
  'cs', // C#
  'rb', // Ruby
  'go', // Go
  'rs', // Rust
  'php', // PHP
  'swift', // Swift
  'kt', // Kotlin
  'scala', // Scala
  'html', 'htm', 'css', // HTML/CSS
  'sh', 'bash', // Shell scripts
  'sql', // SQL
  'md', // Markdown
  'yaml', 'yml', // YAML
  'json', // JSON
  'xml', // XML
  'properties', // Properties files
  'ini', // INI files
  'toml', // TOML files
  'txt', // Plain text
  'conf', 'cfg', 'env', // Configuration files
];

// Define specific file names that are important in repositories (including some hidden ones explicitly)
const specificFiles = [
  'LICENSE',
  'README',
  'CHANGELOG',
  'TODO',
  'Dockerfile',
  'Makefile',
  '.gitignore',
  '.dockerignore',
  '.env',
  '.editorconfig',
];

// Define huge directories to exclude by default
const hugeDirectories = [
  'node_modules', 'dist', 'build', 'vendor', 'coverage', // JavaScript/Node.js, PHP
  'dist-newstyle', // Haskell
  '__pycache__', '.venv', 'venv', 'env', '.eggs', 'egg-info', // Python
  'target', 'out', '.gradle', '.m2', // Java
  'bin', 'pkg', '.bundle', // Go, Ruby
  'obj', '.cache', 'deps', 'lib', 'public', // C/C++, Clojure, Scala, static sites
  'artifacts', 'tmp', 'temp', // General build/temp
];

// Escape dots in specific file names for regex (e.g., '.gitignore' -> '\\.gitignore')
const escapedSpecificFiles = specificFiles.map(f => f.replace(/\./g, '\\.'));

// Improved default include regexes:
// 1. Include files with common extensions in any directory (hidden filtering will be handled by defaultExclude)
const defaultInclude = [
  new RegExp(`^.*\\.(${commonExtensions.join('|')})$`),
  // 2. Include specific files like 'README' or '.gitignore', hidden or not
  new RegExp(`(.*\\/)?(${escapedSpecificFiles.join('|')})$`),
];

// Default exclude regexes for hidden files and huge directories
const defaultExclude = [
  // Exclude all hidden files and directories (e.g., '.git', '.hidden.txt')
  new RegExp(`(^|\\/)\\.[^/]+(/.*|$)`),
  // Exclude large directories like 'node_modules' and their contents
  new RegExp(`(^|\\/)(${hugeDirectories.join('|')})\\/.*`),
];

/** Converts a 12-character ID string to a number for calculations. */
function idToNumber(id: string): number {
  return parseInt(id, 10);
}

/** Converts a number to a 12-character padded ID string. */
function numberToId(num: number): string {
  return num.toString().padStart(12, '0');
}

/** Recursively lists all files in a directory, filtering based on ignore patterns and regexes. */
async function listFiles(
  dir: string,
  ig: ignore.Ignore,
  rootPath: string,
  include: RegExp[] | undefined,
  exclude: RegExp[]
): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(rootPath, fullPath);
    if (ig.ignores(relativePath)) continue;
    if (entry.isDirectory()) {
      const subFiles = await listFiles(fullPath, ig, rootPath, include, exclude);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      if (include !== undefined) {
        if (include.length === 0) continue;
        if (!include.some(regex => regex.test(relativePath))) continue;
      }
      if (exclude.some(regex => regex.test(relativePath))) continue;
      files.push(fullPath);
    }
  }
  return files;
}

/** Shortens a chunk for summary display. */
export function shortenChunk(chunk: string): string {
  const lines = chunk.split('\n');
  if (lines[0] === '--show--' || lines[0] === '//show//') {
    return lines.slice(1).join('\n');
  }
  const isComment = (line: string) => {
    const trimmed = line.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('--') || trimmed.startsWith('#');
  };
  const firstLine = lines[0];
  if (isComment(firstLine)) {
    const firstNonComment = lines.find(line => !isComment(line));
    return firstNonComment ? `${firstLine}\n${firstNonComment}...` : `${firstLine}...`;
  }
  return `${firstLine}...`;
}

/** Manages a repository's chunks in memory with stable, padded IDs. */
export class RepoManager {
  private rootPath: string;
  private chunks: Map<string, { path: string; content: string }>;
  private nextId: number;

  private constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.chunks = new Map();
    this.nextId = 0;
  }

  static async load(
    rootPath: string,
    options: { exclude?: RegExp[]; include?: RegExp[] } = {}
  ): Promise<RepoManager> {
    const repo = new RepoManager(rootPath);
    await repo._load(options);
    return repo;
  }

  private async _load(options: { exclude?: RegExp[]; include?: RegExp[] }) {
    const ig = ignore();
    const cshignorePath = path.join(this.rootPath, '.cshignore');
    try {
      const cshignoreContent = await fs.readFile(cshignorePath, 'utf8');
      ig.add(cshignoreContent);
    } catch (err) {
      // Ignore missing .cshignore
    }

    // Use user-provided include if supplied; otherwise, use defaultInclude
    const include = options.include !== undefined ? options.include : defaultInclude;
    // Use user-provided exclude if supplied; otherwise, use defaultExclude
    const exclude = options.exclude !== undefined ? options.exclude : defaultExclude;
    const files = await listFiles(this.rootPath, ig, this.rootPath, include, exclude);
    files.sort();

    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      const rawChunks = content.split(/\n\s*\n/);
      const trimmedChunks = rawChunks
        .map(chunk => chunk.replace(/^\n+|\n+$/g, ''))
        .filter(chunk => chunk.length > 0);

      for (const chunkContent of trimmedChunks) {
        const id = numberToId(this.nextId);
        this.chunks.set(id, { path: file, content: chunkContent });
        this.nextId += 1000000;
      }
    }
  }

  view(shownChunks: { [id: string]: true }): string {
    const fileChunks: { [path: string]: { id: string; content: string }[] } = {};
    for (const [id, chunk] of this.chunks) {
      fileChunks[chunk.path] = fileChunks[chunk.path] || [];
      fileChunks[chunk.path].push({ id, content: chunk.content });
    }

    // Find the smallest ID for each file
    const fileMinIds: { path: string; minId: number }[] = [];
    for (const path in fileChunks) {
      const ids = fileChunks[path].map(chunk => idToNumber(chunk.id));
      const minId = Math.min(...ids);
      fileMinIds.push({ path, minId });
    }

    // Sort files by their smallest chunk ID
    fileMinIds.sort((a, b) => a.minId - b.minId);

    let result = '';
    for (const file of fileMinIds) {
      const filePath = file.path;
      result += `[${filePath}]\n`;
      const chunksInFile = fileChunks[filePath].sort((a, b) => idToNumber(a.id) - idToNumber(b.id));
      for (const chunk of chunksInFile) {
        const displayContent = shownChunks[chunk.id] ? chunk.content : shortenChunk(chunk.content);
        result += `${chunk.id}:\n${displayContent}\n`;
      }
    }
    return result.trim();
  }

  async edit(edits: { [id: string]: string }) {
    for (const id in edits) {
      if (!this.chunks.has(id)) {
        console.warn(`Chunk ${id} does not exist.`);
        continue;
      }
      const newContent = edits[id].replace(/^\n+|\n+$/g, ''); // Trim leading/trailing newlines
      if (newContent === '') {
        this.chunks.delete(id);
      } else {
        const newBlocks = newContent
          .split(/\n\s*\n/)
          .map(block => block.replace(/^\n+|\n+$/g, '')) // Trim each block
          .filter(block => block.length > 0);
        const originalChunk = this.chunks.get(id)!;
        const path = originalChunk.path;

        if (newBlocks.length === 1) {
          this.chunks.set(id, { path, content: newBlocks[0] });
        } else if (newBlocks.length > 1) {
          const allIds = Array.from(this.chunks.keys()).sort((a, b) => idToNumber(a) - idToNumber(b));
          const index = allIds.indexOf(id);
          const nextIdStr = index < allIds.length - 1 ? allIds[index + 1] : null;
          const base = idToNumber(id);
          const nextId = nextIdStr ? idToNumber(nextIdStr) : base + 1000000;
          const space = nextId - base;
          const n = newBlocks.length;
          const step = Math.floor(space / n);

          if (step < 1) {
            throw new Error(`Not enough space to split chunk ${id} into ${n} blocks.`);
          }

          const newIds: string[] = [];
          for (let i = 0; i < n; i++) {
            const newIdNum = base + i * step;
            const newIdStr = numberToId(newIdNum);
            if (this.chunks.has(newIdStr) && newIdStr !== id) {
              throw new Error(`ID collision at ${newIdStr} while splitting chunk ${id}.`);
            }
            newIds.push(newIdStr);
          }

          this.chunks.delete(id);
          for (let i = 0; i < n; i++) {
            this.chunks.set(newIds[i], { path, content: newBlocks[i] });
          }
        }
      }
    }
    await this.save();
  }

  async addFile(relativePath: string, content: string): Promise<void> {
    const fullPath = path.join(this.rootPath, relativePath);
    try {
      await fs.access(fullPath);
      throw new Error(`File ${relativePath} already exists.`);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException; // Type assertion to handle Node.js errors
      if (error.code !== 'ENOENT') {
        throw err;
      }
    }
    const dirname = path.dirname(fullPath);
    await fs.mkdir(dirname, { recursive: true });
    const rawChunks = content.split(/\n\s*\n/);
    const trimmedChunks = rawChunks
      .map(chunk => chunk.replace(/^\n+|\n+$/g, ''))
      .filter(chunk => chunk.length > 0);
    for (const chunkContent of trimmedChunks) {
      const id = numberToId(this.nextId);
      this.chunks.set(id, { path: fullPath, content: chunkContent });
      this.nextId += 1000000;
    }
    await this.save();
  }

  async save() {
    const fileChunks: { [path: string]: { id: string; content: string }[] } = {};
    for (const [id, chunk] of this.chunks) {
      fileChunks[chunk.path] = fileChunks[chunk.path] || [];
      fileChunks[chunk.path].push({ id, content: chunk.content });
    }

    for (const filePath in fileChunks) {
      const chunksInFile = fileChunks[filePath].sort((a, b) => idToNumber(a.id) - idToNumber(b.id));
      const content = chunksInFile.map(chunk => chunk.content).join('\n\n') + '\n';
      await fs.writeFile(filePath, content);
    }
  }

  async refresh(options: { exclude?: RegExp[]; include?: RegExp[] } = {}) {
    const ig = ignore();
    const cshignorePath = path.join(this.rootPath, '.cshignore');
    try {
      const cshignoreContent = await fs.readFile(cshignorePath, 'utf8');
      ig.add(cshignoreContent);
    } catch (err) {
      // Ignore missing .cshignore
    }
    const include = options.include !== undefined ? options.include : defaultInclude;
    const exclude = options.exclude !== undefined ? options.exclude : defaultExclude;
    const files = await listFiles(this.rootPath, ig, this.rootPath, include, exclude);
    files.sort();

    // Gather already tracked file paths from the current chunks
    const trackedPaths = new Set<string>();
    for (const chunk of this.chunks.values()) {
      trackedPaths.add(chunk.path);
    }

    // Add any new files that are not in the tracked paths
    for (const file of files) {
      if (!trackedPaths.has(file)) {
        const content = await fs.readFile(file, 'utf8');
        const rawChunks = content.split(/\n\s*\n/);
        const trimmedChunks = rawChunks
          .map(chunk => chunk.replace(/^\n+|\n+$/g, ''))
          .filter(chunk => chunk.length > 0);
        for (const chunkContent of trimmedChunks) {
          const id = numberToId(this.nextId);
          this.chunks.set(id, { path: file, content: chunkContent });
          this.nextId += 1000000;
        }
      }
    }
    await this.save();
  }
}
