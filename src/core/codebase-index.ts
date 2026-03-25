// KCode - Codebase Index
// Builds and queries a persistent index of project files for fast lookup

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { homedir } from "node:os";
import { getDb } from "./db";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface SymbolDef {
  name: string;
  line: number; // 1-based line number
  kind: "function" | "class" | "const" | "type" | "interface" | "enum" | "variable" | "method" | "struct" | "trait" | "other";
}

export interface IndexEntry {
  path: string;
  relativePath: string;
  ext: string;
  size: number;
  exports: string[];
  imports: string[];
  definitions: SymbolDef[];
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
  ".kcode", ".vscode", ".idea", "coverage", "data",
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
    // Safety: don't index home directory, root, or non-project dirs
    const home = homedir();
    if (this.cwd === home || this.cwd === "/" || this.cwd === "/tmp") {
      log.info("indexer", `Skipping index — "${this.cwd}" is not a project directory`);
      this.indexed = true;
      return 0;
    }

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
        const definitions = this.extractDefinitions(content, ext);
        const exports = definitions.map((d) => d.name);
        const imports = this.extractImports(content, ext);

        this.entries.push({
          path: fullPath,
          relativePath: relative(this.cwd, fullPath),
          ext,
          size: stat.size,
          exports,
          imports,
          definitions,
          modifiedAt: stat.mtimeMs,
        });
      } catch {
        // Skip unreadable files
      }
    }
  }

  private extractDefinitions(content: string, ext: string): SymbolDef[] {
    const defs: SymbolDef[] = [];

    // Pre-build line offset table: lineStarts[i] = char offset where line i+1 begins
    const lineStarts = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === "\n") lineStarts.push(i + 1);
    }
    // Binary search for the 1-based line number at a given char offset
    const offsetToLine = (offset: number): number => {
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
      }
      return lo + 1; // 1-based
    };

    const kindMap: Record<string, SymbolDef["kind"]> = {
      function: "function", class: "class", const: "const", let: "variable",
      var: "variable", type: "type", interface: "interface", enum: "enum",
      fn: "function", struct: "struct", trait: "trait", def: "function",
    };

    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      const re = /export\s+(?:default\s+)?(?:(function|class|const|let|var|type|interface|enum))\s+(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        defs.push({ name: m[2], line: offsetToLine(m.index), kind: kindMap[m[1]] ?? "other" });
      }
    } else if (ext === ".py") {
      const re = /^(def|class)\s+(\w+)/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        defs.push({ name: m[2], line: offsetToLine(m.index), kind: m[1] === "class" ? "class" : "function" });
      }
    } else if (ext === ".go") {
      const re = /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?([A-Z]\w*)/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        defs.push({ name: m[1], line: offsetToLine(m.index), kind: "function" });
      }
    } else if (ext === ".rs") {
      const re = /pub\s+(fn|struct|enum|trait|type)\s+(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        defs.push({ name: m[2], line: offsetToLine(m.index), kind: kindMap[m[1]] ?? "other" });
      }
    }

    return defs;
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
        definitions TEXT DEFAULT '[]',
        modified_at REAL NOT NULL,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      // Add definitions column if missing (migration for existing DBs)
      try {
        db.exec(`ALTER TABLE codebase_index ADD COLUMN definitions TEXT DEFAULT '[]'`);
      } catch { /* column already exists */ }

      const stmt = db.prepare(
        `INSERT OR REPLACE INTO codebase_index (path, relative_path, ext, size, exports, imports, definitions, modified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      db.exec("BEGIN");
      // Clear old entries for this project
      db.run(`DELETE FROM codebase_index WHERE path LIKE ?`, [`${this.cwd}%`]);
      for (const e of this.entries) {
        stmt.run(e.path, e.relativePath, e.ext, e.size, JSON.stringify(e.exports), JSON.stringify(e.imports), JSON.stringify(e.definitions), e.modifiedAt);
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back or no transaction */ }
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
        `SELECT path, relative_path, ext, size, exports, imports, definitions, modified_at
         FROM codebase_index WHERE path LIKE ? ORDER BY relative_path`,
      ).all(`${this.cwd}%`) as Array<{ path: string; relative_path: string; ext: string; size: number; exports: string; imports: string; definitions: string | null; modified_at: string }>;

      if (!rows || rows.length === 0) return false;

      this.entries = rows.map((r) => ({
        path: r.path,
        relativePath: r.relative_path,
        ext: r.ext,
        size: r.size,
        exports: JSON.parse(r.exports),
        imports: JSON.parse(r.imports),
        definitions: r.definitions ? JSON.parse(r.definitions) : [],
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
   * Find the definition of a symbol with file path and line number.
   */
  findDefinition(symbol: string): Array<{ path: string; relativePath: string; line: number; kind: SymbolDef["kind"] }> {
    if (!this.indexed) {
      if (!this.loadFromDb()) this.build();
    }

    const sym = symbol.toLowerCase();
    const results: Array<{ path: string; relativePath: string; line: number; kind: SymbolDef["kind"] }> = [];

    for (const entry of this.entries) {
      for (const def of entry.definitions) {
        if (def.name.toLowerCase() === sym) {
          results.push({
            path: entry.path,
            relativePath: entry.relativePath,
            line: def.line,
            kind: def.kind,
          });
        }
      }
    }

    return results;
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
      const defs = f.definitions.length > 0
        ? ` — ${f.definitions.slice(0, 5).map((d) => `${d.name}:${d.line}`).join(", ")}`
        : f.exports.length > 0
          ? ` — exports: ${f.exports.slice(0, 5).join(", ")}`
          : "";
      lines.push(`- \`${f.relativePath}\` (${f.size} bytes)${defs}`);
    }

    lines.push("");
    lines.push("Consider reading these files if they are relevant to the current task.");

    return lines.join("\n");
  }

  /**
   * Format relevant files with actual code snippets around matched definitions.
   * Returns richer context than formatRelevantContext() by including source code.
   * Used for enhanced smart context injection.
   */
  formatRelevantSnippets(query: string, maxTotalLines = 60): string | null {
    const relevant = this.getRelevantFiles(query, 3);
    if (relevant.length === 0) return null;

    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const sections: string[] = ["# Relevant Code Context (auto-detected)"];
    let totalLines = 0;
    const linesPerFile = Math.floor(maxTotalLines / Math.max(relevant.length, 1));

    for (const f of relevant) {
      if (totalLines >= maxTotalLines) break;

      // Find definitions matching query words
      const matchingDefs = f.definitions.filter((d) =>
        words.some((w) => d.name.toLowerCase().includes(w)),
      );

      if (matchingDefs.length === 0 && f.definitions.length === 0) {
        // No definitions — just list the file
        sections.push(`\n## ${f.relativePath}`);
        sections.push(`(${f.size} bytes, exports: ${f.exports.slice(0, 5).join(", ") || "none"})`);
        totalLines += 2;
        continue;
      }

      // Read actual file content for snippets
      let fileContent: string;
      try {
        fileContent = readFileSync(f.path, "utf-8");
      } catch {
        continue;
      }

      const fileLines = fileContent.split("\n");
      sections.push(`\n## ${f.relativePath}`);
      totalLines += 1;

      // Show snippets around matching definitions (or first few defs if no match)
      const defsToShow = matchingDefs.length > 0
        ? matchingDefs.slice(0, 3)
        : f.definitions.slice(0, 2);

      for (const def of defsToShow) {
        if (totalLines >= maxTotalLines) break;

        const startLine = Math.max(0, def.line - 1); // 0-based
        const snippetLen = Math.min(8, linesPerFile, maxTotalLines - totalLines);
        const endLine = Math.min(fileLines.length, startLine + snippetLen);

        const snippet = fileLines.slice(startLine, endLine)
          .map((l, i) => `${startLine + i + 1}│ ${l}`)
          .join("\n");

        sections.push(`\`${def.kind} ${def.name}\` (line ${def.line}):`);
        sections.push("```");
        sections.push(snippet);
        sections.push("```");
        totalLines += (endLine - startLine) + 3;
      }
    }

    return totalLines > 3 ? sections.join("\n") : null;
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
