// KCode - Intelligent Code Chunker
// Splits source files into semantically meaningful chunks using
// language-aware boundary detection (regex-based, no external parser).

import { createHash } from "node:crypto";
import { basename, relative } from "node:path";
import type { CodeChunk } from "./types";

// ─── Code Chunker ──────────────────────────────────────────────

export class CodeChunker {
  private projectRoot: string;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = projectRoot;
  }

  /** Chunk a file into code segments based on language */
  chunk(filePath: string, content: string, language: string): CodeChunk[] {
    if (!content.trim()) return [];

    switch (language) {
      case "typescript":
      case "javascript":
      case "tsx":
      case "jsx":
        return this.chunkTypeScript(filePath, content, language);
      case "python":
        return this.chunkPython(filePath, content, language);
      case "go":
        return this.chunkGo(filePath, content, language);
      case "rust":
        return this.chunkRust(filePath, content, language);
      default:
        return this.chunkSlidingWindow(filePath, content, language);
    }
  }

  // ─── TypeScript / JavaScript ─────────────────────────────────

  private chunkTypeScript(filePath: string, content: string, language: string): CodeChunk[] {
    const lines = content.split("\n");

    // Small files: single chunk
    if (lines.length < 100) {
      return [this.createWholeFileChunk(filePath, content, language)];
    }

    const chunks: CodeChunk[] = [];
    // Extract imports as a module chunk
    const importLines: string[] = [];
    let importEnd = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*(import\s|\/\/|\/\*|\*|$)/.test(line)) {
        importLines.push(line);
        importEnd = i;
      } else {
        break;
      }
    }
    if (importLines.length > 2) {
      chunks.push(
        this.createChunk(
          filePath,
          importLines.join("\n"),
          language,
          "module",
          "imports",
          1,
          importEnd + 1,
          "",
        ),
      );
    }

    // Detect function/class/interface/type boundaries
    const patterns = [
      // export (async)? function NAME
      /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)/,
      // export (default)? class NAME
      /^(?:export\s+(?:default\s+)?)?class\s+(\w+)/,
      // export const NAME = (async)? (...) =>
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?/,
      // interface NAME {
      /^(?:export\s+)?interface\s+(\w+)/,
      // type NAME =
      /^(?:export\s+)?type\s+(\w+)/,
    ];

    const boundaries: Array<{
      line: number;
      name: string;
      kind: CodeChunk["type"];
      signature: string;
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trimStart();
      for (const pattern of patterns) {
        const m = trimmed.match(pattern);
        if (m) {
          const name = m[1]!;
          let kind: CodeChunk["type"] = "function";
          if (/class\s/.test(trimmed)) kind = "class";
          else if (/interface\s/.test(trimmed)) kind = "block";
          else if (/type\s/.test(trimmed)) kind = "block";
          else if (/const|let|var/.test(trimmed) && !/=>/.test(trimmed) && !/{/.test(trimmed))
            kind = "block";

          boundaries.push({ line: i, name, kind, signature: trimmed.slice(0, 120) });
          break;
        }
      }
    }

    // Build chunks from boundaries
    for (let b = 0; b < boundaries.length; b++) {
      const start = boundaries[b]!.line;
      const nextStart = b + 1 < boundaries.length ? boundaries[b + 1]!.line : lines.length;
      const end = this.findBlockEnd(lines, start, nextStart);

      const chunkContent = lines.slice(start, end).join("\n");
      chunks.push(
        this.createChunk(
          filePath,
          chunkContent,
          language,
          boundaries[b]!.kind,
          boundaries[b]!.name,
          start + 1,
          end,
          boundaries[b]!.signature,
        ),
      );
    }

    // If no boundaries found, use sliding window
    if (boundaries.length === 0) {
      return this.chunkSlidingWindow(filePath, content, language);
    }

    return chunks;
  }

  // ─── Python ──────────────────────────────────────────────────

  private chunkPython(filePath: string, content: string, language: string): CodeChunk[] {
    const lines = content.split("\n");

    if (lines.length < 100) {
      return [this.createWholeFileChunk(filePath, content, language)];
    }

    const chunks: CodeChunk[] = [];
    const boundaries: Array<{
      line: number;
      name: string;
      kind: CodeChunk["type"];
      signature: string;
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const defMatch = line.match(/^(?:async\s+)?def\s+(\w+)/);
      const classMatch = line.match(/^class\s+(\w+)/);

      if (defMatch) {
        boundaries.push({
          line: i,
          name: defMatch[1]!,
          kind: "function",
          signature: line.trimEnd().slice(0, 120),
        });
      } else if (classMatch) {
        boundaries.push({
          line: i,
          name: classMatch[1]!,
          kind: "class",
          signature: line.trimEnd().slice(0, 120),
        });
      }
    }

    for (let b = 0; b < boundaries.length; b++) {
      const start = boundaries[b]!.line;
      const nextStart = b + 1 < boundaries.length ? boundaries[b + 1]!.line : lines.length;

      // Python: find block end by indentation
      let end = start + 1;
      const baseIndent = this.getIndent(lines[start]!);
      for (let j = start + 1; j < nextStart; j++) {
        const line = lines[j]!;
        if (line.trim() === "") {
          end = j + 1;
          continue;
        }
        if (this.getIndent(line) > baseIndent) {
          end = j + 1;
        } else {
          break;
        }
      }

      const chunkContent = lines.slice(start, end).join("\n");
      chunks.push(
        this.createChunk(
          filePath,
          chunkContent,
          language,
          boundaries[b]!.kind,
          boundaries[b]!.name,
          start + 1,
          end,
          boundaries[b]!.signature,
        ),
      );
    }

    if (boundaries.length === 0) {
      return this.chunkSlidingWindow(filePath, content, language);
    }

    return chunks;
  }

  // ─── Go ──────────────────────────────────────────────────────

  private chunkGo(filePath: string, content: string, language: string): CodeChunk[] {
    const lines = content.split("\n");

    if (lines.length < 100) {
      return [this.createWholeFileChunk(filePath, content, language)];
    }

    const chunks: CodeChunk[] = [];
    const boundaries: Array<{
      line: number;
      name: string;
      kind: CodeChunk["type"];
      signature: string;
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const funcMatch = line.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/);
      const typeMatch = line.match(/^type\s+(\w+)\s+(?:struct|interface)/);

      if (funcMatch) {
        boundaries.push({
          line: i,
          name: funcMatch[1]!,
          kind: "function",
          signature: line.trimEnd().slice(0, 120),
        });
      } else if (typeMatch) {
        boundaries.push({
          line: i,
          name: typeMatch[1]!,
          kind: "class",
          signature: line.trimEnd().slice(0, 120),
        });
      }
    }

    for (let b = 0; b < boundaries.length; b++) {
      const start = boundaries[b]!.line;
      const nextStart = b + 1 < boundaries.length ? boundaries[b + 1]!.line : lines.length;
      const end = this.findBlockEnd(lines, start, nextStart);

      const chunkContent = lines.slice(start, end).join("\n");
      chunks.push(
        this.createChunk(
          filePath,
          chunkContent,
          language,
          boundaries[b]!.kind,
          boundaries[b]!.name,
          start + 1,
          end,
          boundaries[b]!.signature,
        ),
      );
    }

    if (boundaries.length === 0) {
      return this.chunkSlidingWindow(filePath, content, language);
    }

    return chunks;
  }

  // ─── Rust ────────────────────────────────────────────────────

  private chunkRust(filePath: string, content: string, language: string): CodeChunk[] {
    const lines = content.split("\n");

    if (lines.length < 100) {
      return [this.createWholeFileChunk(filePath, content, language)];
    }

    const chunks: CodeChunk[] = [];
    const boundaries: Array<{
      line: number;
      name: string;
      kind: CodeChunk["type"];
      signature: string;
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const fnMatch = line.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
      const structMatch = line.match(/^(?:pub\s+)?(?:struct|enum)\s+(\w+)/);
      const implMatch = line.match(/^impl(?:<[^>]*>)?\s+(\w+)/);
      const traitMatch = line.match(/^(?:pub\s+)?trait\s+(\w+)/);

      if (fnMatch) {
        boundaries.push({
          line: i,
          name: fnMatch[1]!,
          kind: "function",
          signature: line.trimEnd().slice(0, 120),
        });
      } else if (structMatch) {
        boundaries.push({
          line: i,
          name: structMatch[1]!,
          kind: "class",
          signature: line.trimEnd().slice(0, 120),
        });
      } else if (implMatch) {
        boundaries.push({
          line: i,
          name: implMatch[1]!,
          kind: "class",
          signature: line.trimEnd().slice(0, 120),
        });
      } else if (traitMatch) {
        boundaries.push({
          line: i,
          name: traitMatch[1]!,
          kind: "class",
          signature: line.trimEnd().slice(0, 120),
        });
      }
    }

    for (let b = 0; b < boundaries.length; b++) {
      const start = boundaries[b]!.line;
      const nextStart = b + 1 < boundaries.length ? boundaries[b + 1]!.line : lines.length;
      const end = this.findBlockEnd(lines, start, nextStart);

      const chunkContent = lines.slice(start, end).join("\n");
      chunks.push(
        this.createChunk(
          filePath,
          chunkContent,
          language,
          boundaries[b]!.kind,
          boundaries[b]!.name,
          start + 1,
          end,
          boundaries[b]!.signature,
        ),
      );
    }

    if (boundaries.length === 0) {
      return this.chunkSlidingWindow(filePath, content, language);
    }

    return chunks;
  }

  // ─── Sliding Window (generic fallback) ───────────────────────

  chunkSlidingWindow(
    filePath: string,
    content: string,
    language: string,
    windowSize: number = 50,
    overlap: number = 10,
  ): CodeChunk[] {
    const lines = content.split("\n");
    const chunks: CodeChunk[] = [];

    for (let i = 0; i < lines.length; i += windowSize - overlap) {
      const end = Math.min(i + windowSize, lines.length);
      const chunkContent = lines.slice(i, end).join("\n");

      chunks.push({
        id: this.hashContent(filePath + ":" + i),
        filePath,
        relativePath: this.getRelativePath(filePath),
        language,
        type: "block",
        name: `${basename(filePath)}:${i + 1}-${end}`,
        content: chunkContent,
        startLine: i + 1,
        endLine: end,
        signature: "",
        dependencies: [],
        tokenEstimate: Math.ceil(chunkContent.length / 4),
      });

      if (end >= lines.length) break;
    }

    return chunks;
  }

  // ─── Helpers ─────────────────────────────────────────────────

  /** Create a single chunk for the whole file */
  createWholeFileChunk(filePath: string, content: string, language: string): CodeChunk {
    const lines = content.split("\n");
    return {
      id: this.hashContent(filePath + ":whole"),
      filePath,
      relativePath: this.getRelativePath(filePath),
      language,
      type: "module",
      name: basename(filePath),
      content,
      startLine: 1,
      endLine: lines.length,
      signature: "",
      dependencies: this.extractDependencies(content, language),
      tokenEstimate: Math.ceil(content.length / 4),
    };
  }

  /** Create a chunk from parameters */
  private createChunk(
    filePath: string,
    content: string,
    language: string,
    type: CodeChunk["type"],
    name: string,
    startLine: number,
    endLine: number,
    signature: string,
  ): CodeChunk {
    return {
      id: this.hashContent(filePath + ":" + startLine),
      filePath,
      relativePath: this.getRelativePath(filePath),
      language,
      type,
      name,
      content,
      startLine,
      endLine,
      signature,
      dependencies: this.extractDependencies(content, language),
      tokenEstimate: Math.ceil(content.length / 4),
    };
  }

  /** Find the end of a brace-delimited block */
  private findBlockEnd(lines: string[], start: number, maxEnd: number): number {
    let braces = 0;
    let foundOpen = false;

    for (let i = start; i < maxEnd; i++) {
      const line = lines[i]!;
      for (const ch of line) {
        if (ch === "{") {
          braces++;
          foundOpen = true;
        }
        if (ch === "}") {
          braces--;
        }
      }
      if (foundOpen && braces <= 0) {
        return i + 1;
      }
    }

    return maxEnd;
  }

  /** Get indentation level (number of leading spaces) */
  private getIndent(line: string): number {
    const m = line.match(/^(\s*)/);
    return m ? m[1]!.length : 0;
  }

  /** Extract import dependencies from code */
  private extractDependencies(content: string, language: string): string[] {
    const deps: string[] = [];

    if (["typescript", "javascript", "tsx", "jsx"].includes(language)) {
      const re = /(?:import|from)\s+["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        deps.push(m[1]!);
      }
    } else if (language === "python") {
      const re = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        deps.push((m[1] ?? m[2])!);
      }
    }

    return deps;
  }

  /** Hash content to create a stable chunk ID */
  hashContent(input: string): string {
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
  }

  /** Get path relative to project root */
  getRelativePath(filePath: string): string {
    try {
      return relative(this.projectRoot, filePath);
    } catch {
      return filePath;
    }
  }
}
