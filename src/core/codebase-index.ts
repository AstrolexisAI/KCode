// KCode - Codebase Index
// Builds and queries a persistent index of project files for fast lookup

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { getDb } from "./db";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface IndexEntry {
  path: string;
  relativePath: string;
  ext: string;
  size: number;
  exports: string[];
  imports: string[];
  modifiedAt: number;
}

// ─── Constants ──────────────────────────────────────────────────

const INDEXABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".swift",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".rb",
  ".vue", ".svelte",
]);

const IGNORE_DIRS = new Set([
  "node_modules", "dist", "build", ".git", "__pycache__",
  "venv", ".next", ".nuxt", "target", "vendor",
  ".kcode", ".vscode", ".idea", "coverage",
]);

const MAX_FILE_SIZE = 100_000; // skip files > 100KB for indexing
const MAX_FILES = 5_000; // cap to prevent runaway on huge repos

// ─── Index Builder ──────────────────────────────────────────────

export class CodebaseIndex {
  private cwd: string;
  private entries: IndexEntry[] = [];
  private indexed = false;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Build or refresh the codebase index.
   * Walks the project tree and extracts exports/imports from source files.
   */
  build(): number {
    const startMs = Date.now();
    this.entries = [];
    this.walkDir(this.cwd, 0);
    this.indexed = true;

    // Persist to SQLite
    this.saveToDb();

    const elapsed = Date.now() - startMs;
    log.info("indexer", `Indexed ${this.entries.length} files in ${elapsed}ms`);
    return this.entries.length;
  }

  private walkDir(dir: string, depth: number): void {
    if (depth > 10 || this.entries.length >= MAX_FILES) return;

    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (this.entries.length >= MAX_FILES) break;

      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !IGNORE_DIRS.has(entry.name)) {
          this.walkDir(join(dir, entry.name), depth + 1);
        }
        continue;
      }

      const ext = extname(entry.name);
      if (!INDEXABLE_EXTENSIONS.has(ext)) continue;

      const fullPath = join(dir, entry.name);
      try {
        const stat = statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;

        const content = readFileSync(fullPath, "utf-8");
        const exports = this.extractExports(content, ext);
        const imports = this.extractImports(content, ext);

        this.entries.push({
          path: fullPath,
          relativePath: relative(this.cwd, fullPath),
          ext,
          size: stat.size,
          exports,
          imports,
          modifiedAt: stat.mtimeMs,
        });
      } catch {
        // Skip unreadable files
      }
    }
  }

  private extractExports(content: string, ext: string): string[] {
    const exports: string[] = [];

    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      // export function/class/const/type/interface
      const re = /export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        exports.push(m[1]);
      }
    } else if (ext === ".py") {
      // def/class at module level
      const re = /^(?:def|class)\s+(\w+)/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        exports.push(m[1]);
      }
    } else if (ext === ".go") {
      // Exported = capitalized
      const re = /^func\s+(\w*\s+)?([A-Z]\w*)/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        exports.push(m[2]);
      }
    } else if (ext === ".rs") {
      const re = /pub\s+(?:fn|struct|enum|trait|type)\s+(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        exports.push(m[1]);
      }
    }

    return exports;
  }

  private extractImports(content: string, ext: string): string[] {
    const imports: string[] = [];

    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      const re = /(?:import|from)\s+["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        imports.push(m[1]);
      }
    } else if (ext === ".py") {
      const re = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        imports.push(m[1] ?? m[2]);
      }
    }

    return imports;
  }

  // ─── Persistence ──────────────────────────────────────────────

  private saveToDb(): void {
    try {
      const db = getDb();
      db.exec(`CREATE TABLE IF NOT EXISTS codebase_index (
        path TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        ext TEXT NOT NULL,
        size INTEGER NOT NULL,
        exports TEXT DEFAULT '[]',
        imports TEXT DEFAULT '[]',
        modified_at REAL NOT NULL,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      const stmt = db.prepare(
        `INSERT OR REPLACE INTO codebase_index (path, relative_path, ext, size, exports, imports, modified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      db.exec("BEGIN");
      // Clear old entries for this project
      db.run(`DELETE FROM codebase_index WHERE path LIKE ?`, [`${this.cwd}%`]);
      for (const e of this.entries) {
        stmt.run(e.path, e.relativePath, e.ext, e.size, JSON.stringify(e.exports), JSON.stringify(e.imports), e.modifiedAt);
      }
      db.exec("COMMIT");
    } catch (err) {
      log.error("indexer", `Failed to save index: ${err}`);
    }
  }

  /**
   * Load index from SQLite (if available and recent).
   * Returns true if a cached index was loaded, false if a rebuild is needed.
   */
  loadFromDb(): boolean {
    try {
      const db = getDb();
      const rows = db.query(
        `SELECT path, relative_path, ext, size, exports, imports, modified_at
         FROM codebase_index WHERE path LIKE ? ORDER BY relative_path`,
      ).all(`${this.cwd}%`) as any[];

      if (!rows || rows.length === 0) return false;

      this.entries = rows.map((r) => ({
        path: r.path,
        relativePath: r.relative_path,
        ext: r.ext,
        size: r.size,
        exports: JSON.parse(r.exports),
        imports: JSON.parse(r.imports),
        modifiedAt: r.modified_at,
      }));
      this.indexed = true;
      return true;
    } catch {
      return false;
    }
  }

  // ─── Queries ──────────────────────────────────────────────────

  /**
   * Search for files by name, path, or exported symbol.
   */
  search(query: string): IndexEntry[] {
    if (!this.indexed) {
      if (!this.loadFromDb()) this.build();
    }

    const q = query.toLowerCase();
    return this.entries.filter((e) => {
      if (e.relativePath.toLowerCase().includes(q)) return true;
      if (e.exports.some((exp) => exp.toLowerCase().includes(q))) return true;
      return false;
    });
  }

  /**
   * Find files that export a specific symbol.
   */
  findExport(symbol: string): IndexEntry[] {
    if (!this.indexed) {
      if (!this.loadFromDb()) this.build();
    }

    const sym = symbol.toLowerCase();
    return this.entries.filter((e) =>
      e.exports.some((exp) => exp.toLowerCase() === sym),
    );
  }

  /**
   * Find files that import from a given module path.
   */
  findImporters(modulePath: string): IndexEntry[] {
    if (!this.indexed) {
      if (!this.loadFromDb()) this.build();
    }

    return this.entries.filter((e) =>
      e.imports.some((imp) => imp.includes(modulePath)),
    );
  }

  /**
   * Get files most relevant to a user query.
   * Scores by filename match, export match, and recency.
   */
  getRelevantFiles(query: string, limit = 5): IndexEntry[] {
    if (!this.indexed) {
      if (!this.loadFromDb()) this.build();
    }

    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (words.length === 0) return [];

    const scored: Array<{ entry: IndexEntry; score: number }> = [];

    for (const entry of this.entries) {
      let score = 0;
      const relLower = entry.relativePath.toLowerCase();
      const exportsLower = entry.exports.map((e) => e.toLowerCase());

      for (const word of words) {
        // Filename match (high value)
        if (relLower.includes(word)) score += 10;
        // Export match (high value)
        if (exportsLower.some((e) => e.includes(word))) score += 8;
        // Extension match
        if (entry.ext.slice(1) === word) score += 2;
      }

      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry);
  }

  /**
   * Get index stats.
   */
  getStats(): { fileCount: number; totalSize: number; exportCount: number; extensions: Record<string, number> } {
    const extensions: Record<string, number> = {};
    let totalSize = 0;
    let exportCount = 0;

    for (const e of this.entries) {
      totalSize += e.size;
      exportCount += e.exports.length;
      extensions[e.ext] = (extensions[e.ext] ?? 0) + 1;
    }

    return { fileCount: this.entries.length, totalSize, exportCount, extensions };
  }

  /**
   * Format relevant files as a brief context injection.
   */
  formatRelevantContext(query: string): string | null {
    const relevant = this.getRelevantFiles(query, 3);
    if (relevant.length === 0) return null;

    const lines: string[] = [
      "# Relevant Files (auto-detected from query)",
      "",
    ];

    for (const f of relevant) {
      const exports = f.exports.length > 0 ? ` — exports: ${f.exports.slice(0, 5).join(", ")}` : "";
      lines.push(`- \`${f.relativePath}\` (${f.size} bytes)${exports}`);
    }

    lines.push("");
    lines.push("Consider reading these files if they are relevant to the current task.");

    return lines.join("\n");
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let _index: CodebaseIndex | null = null;

export function getCodebaseIndex(cwd: string): CodebaseIndex {
  if (!_index || (_index as any).cwd !== cwd) {
    _index = new CodebaseIndex(cwd);
  }
  return _index;
}
