// KCode - Project Indexer
// Builds a lightweight in-memory index of project files for faster searches and context

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface IndexedFile {
  path: string;
  relativePath: string;
  extension: string;
  sizeBytes: number;
  lineCount: number;
  /** First 5 lines of the file (for quick preview) */
  preview: string;
  /** Symbols extracted from the file (functions, classes, exports) */
  symbols: string[];
}

export interface ProjectIndex {
  rootDir: string;
  files: IndexedFile[];
  totalFiles: number;
  totalLines: number;
  byExtension: Record<string, number>;
  indexedAt: number;
}

// ─── Constants ──────────────────────────────────────────────────

const MAX_FILES = 5000;
const MAX_FILE_SIZE = 512 * 1024; // 512KB max per file for indexing
const PREVIEW_LINES = 5;

// Directories to always skip
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "dist", "build", "out", ".next", ".nuxt",
  "__pycache__", ".pytest_cache", ".mypy_cache",
  "vendor", "venv", ".venv", "env",
  "coverage", ".coverage", ".nyc_output",
  ".cache", ".parcel-cache", ".turbo",
  "target", // Rust/Java
]);

// File extensions to index
const INDEXABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".c", ".cpp", ".h", ".hpp", ".cs",
  ".swift", ".m", ".mm",
  ".sh", ".bash", ".zsh", ".fish",
  ".json", ".yaml", ".yml", ".toml",
  ".md", ".txt", ".rst",
  ".html", ".css", ".scss", ".less",
  ".sql", ".graphql", ".gql",
  ".proto", ".dockerfile",
  ".lua", ".vim", ".el",
]);

// Symbol extraction patterns by language group
const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
    /(?:export\s+)?class\s+(\w+)/g,
    /(?:export\s+)?interface\s+(\w+)/g,
    /(?:export\s+)?type\s+(\w+)\s*=/g,
    /(?:export\s+)?const\s+(\w+)\s*=/g,
    /(?:export\s+)?enum\s+(\w+)/g,
  ],
  python: [
    /^(?:async\s+)?def\s+(\w+)/gm,
    /^class\s+(\w+)/gm,
  ],
  go: [
    /^func\s+(?:\([^)]+\)\s+)?(\w+)/gm,
    /^type\s+(\w+)\s+(?:struct|interface)/gm,
  ],
  rust: [
    /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm,
    /^(?:pub\s+)?struct\s+(\w+)/gm,
    /^(?:pub\s+)?enum\s+(\w+)/gm,
    /^(?:pub\s+)?trait\s+(\w+)/gm,
  ],
  java: [
    /(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?class\s+(\w+)/g,
    /(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+)+(\w+)\s*\(/g,
    /interface\s+(\w+)/g,
  ],
};

// Map extensions to language groups
const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "typescript", ".jsx": "typescript",
  ".mjs": "typescript", ".cjs": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java", ".kt": "java",
};

// ─── Indexer ────────────────────────────────────────────────────

export class ProjectIndexer {
  private index: ProjectIndex | null = null;

  /**
   * Build an index of the project starting from rootDir.
   * Returns the index and caches it in memory.
   */
  buildIndex(rootDir: string): ProjectIndex {
    const startTime = Date.now();
    const files: IndexedFile[] = [];
    const byExtension: Record<string, number> = {};
    let totalLines = 0;

    this.walkDir(rootDir, rootDir, files, byExtension);

    totalLines = files.reduce((sum, f) => sum + f.lineCount, 0);

    this.index = {
      rootDir,
      files,
      totalFiles: files.length,
      totalLines,
      byExtension,
      indexedAt: Date.now(),
    };

    const elapsed = Date.now() - startTime;
    log.info("indexer", `Indexed ${files.length} files (${totalLines} lines) in ${elapsed}ms`);

    return this.index;
  }

  /**
   * Get the cached index, or null if not yet built.
   */
  getIndex(): ProjectIndex | null {
    return this.index;
  }

  /**
   * Search indexed files by symbol name (fuzzy).
   */
  searchSymbols(query: string): IndexedFile[] {
    if (!this.index) return [];
    const lower = query.toLowerCase();
    return this.index.files.filter((f) =>
      f.symbols.some((s) => s.toLowerCase().includes(lower)),
    );
  }

  /**
   * Search indexed files by path (fuzzy).
   */
  searchFiles(query: string): IndexedFile[] {
    if (!this.index) return [];
    const lower = query.toLowerCase();
    return this.index.files.filter((f) =>
      f.relativePath.toLowerCase().includes(lower),
    );
  }

  /**
   * Get a summary of the project structure for context.
   */
  getSummary(): string {
    if (!this.index) return "Project not indexed yet.";

    const lines: string[] = [];
    lines.push(`Project: ${this.index.rootDir}`);
    lines.push(`Files: ${this.index.totalFiles}, Lines: ${this.index.totalLines}`);
    lines.push("");

    // Top extensions by count
    const sortedExts = Object.entries(this.index.byExtension)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    lines.push("File types:");
    for (const [ext, count] of sortedExts) {
      lines.push(`  ${ext}: ${count}`);
    }

    return lines.join("\n");
  }

  /**
   * Format the full index as a tree string.
   */
  formatTree(maxDepth: number = 3): string {
    if (!this.index) return "Project not indexed yet.";

    // Group files by directory
    const dirs = new Map<string, string[]>();
    for (const file of this.index.files) {
      const parts = file.relativePath.split("/");
      const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir)!.push(parts[parts.length - 1]!);
    }

    const lines: string[] = [];
    const sortedDirs = [...dirs.keys()].sort();

    for (const dir of sortedDirs) {
      const depth = dir === "." ? 0 : dir.split("/").length;
      if (depth > maxDepth) continue;

      const indent = "  ".repeat(depth);
      const files = dirs.get(dir)!;
      lines.push(`${indent}${dir === "." ? this.index.rootDir : dir}/`);

      if (depth < maxDepth) {
        for (const file of files.sort()) {
          lines.push(`${indent}  ${file}`);
        }
      } else if (files.length > 0) {
        lines.push(`${indent}  ... ${files.length} files`);
      }
    }

    return lines.join("\n");
  }

  // ─── Private ─────────────────────────────────────────────────

  private walkDir(
    dir: string,
    rootDir: string,
    files: IndexedFile[],
    byExtension: Record<string, number>,
  ): void {
    if (files.length >= MAX_FILES) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        this.walkDir(join(dir, entry.name), rootDir, files, byExtension);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!INDEXABLE_EXTENSIONS.has(ext)) continue;

        const fullPath = join(dir, entry.name);
        const indexed = this.indexFile(fullPath, rootDir, ext);
        if (indexed) {
          files.push(indexed);
          byExtension[ext] = (byExtension[ext] || 0) + 1;
        }
      }
    }
  }

  private indexFile(filePath: string, rootDir: string, ext: string): IndexedFile | null {
    try {
      const stat = statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) return null;

      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      return {
        path: filePath,
        relativePath: relative(rootDir, filePath),
        extension: ext,
        sizeBytes: stat.size,
        lineCount: lines.length,
        preview: lines.slice(0, PREVIEW_LINES).join("\n"),
        symbols: this.extractSymbols(content, ext),
      };
    } catch {
      return null;
    }
  }

  private extractSymbols(content: string, ext: string): string[] {
    const lang = EXT_TO_LANG[ext];
    if (!lang) return [];

    const patterns = SYMBOL_PATTERNS[lang];
    if (!patterns) return [];

    const symbols = new Set<string>();

    for (const pattern of patterns) {
      // Reset lastIndex for global regexps
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1] && match[1].length > 1) {
          symbols.add(match[1]);
        }
      }
    }

    return [...symbols];
  }
}
