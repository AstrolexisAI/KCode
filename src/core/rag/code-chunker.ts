// KCode - RAG Code Chunker
// Splits source code into semantic chunks for embedding

import { basename, extname } from "node:path";

// ─── Types ──────────────────────────────────────────────────────

export type ChunkType = "function" | "class" | "method" | "import" | "block";

export interface CodeChunk {
  filepath: string;
  lineStart: number;
  lineEnd: number;
  type: ChunkType;
  name: string;
  content: string;
  language: string;
}

// ─── Constants ──────────────────────────────────────────────────

/** Max chunk size in characters (~512 tokens) */
const MAX_CHUNK_CHARS = 2000;

/** Fallback chunk size in lines for unrecognized patterns */
const FALLBACK_CHUNK_LINES = 50;

/** Number of overlapping lines between adjacent chunks */
const OVERLAP_LINES = 2;

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".h": "c",
  ".hpp": "cpp",
};

// ─── Language-specific patterns ─────────────────────────────────

interface LanguagePatterns {
  functionDecl: RegExp[];
  classDecl: RegExp[];
  importBlock: RegExp[];
}

const TS_JS_PATTERNS: LanguagePatterns = {
  functionDecl: [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/,
  ],
  classDecl: [/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/],
  importBlock: [/^import\s+/],
};

const PYTHON_PATTERNS: LanguagePatterns = {
  functionDecl: [/^(?:async\s+)?def\s+(\w+)/],
  classDecl: [/^class\s+(\w+)/],
  importBlock: [/^(?:from\s+\S+\s+)?import\s+/],
};

const GO_PATTERNS: LanguagePatterns = {
  functionDecl: [/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/],
  classDecl: [/^type\s+(\w+)\s+struct/],
  importBlock: [/^import\s+/],
};

const RUST_PATTERNS: LanguagePatterns = {
  functionDecl: [/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/],
  classDecl: [
    /^(?:pub\s+)?struct\s+(\w+)/,
    /^(?:pub\s+)?enum\s+(\w+)/,
    /^(?:pub\s+)?trait\s+(\w+)/,
  ],
  importBlock: [/^use\s+/],
};

const JAVA_PATTERNS: LanguagePatterns = {
  functionDecl: [
    /^(?:\s*)(?:public|private|protected)?\s*(?:static\s+)?(?:\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/,
  ],
  classDecl: [
    /^(?:public\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/,
    /^(?:public\s+)?interface\s+(\w+)/,
  ],
  importBlock: [/^import\s+/],
};

const C_CPP_PATTERNS: LanguagePatterns = {
  functionDecl: [/^(?:static\s+)?(?:inline\s+)?(?:const\s+)?(?:\w+(?:\s*\*)?)\s+(\w+)\s*\(/],
  classDecl: [/^(?:class|struct)\s+(\w+)/],
  importBlock: [/^#include\s+/],
};

function getPatternsForLanguage(lang: string): LanguagePatterns | null {
  switch (lang) {
    case "typescript":
    case "javascript":
      return TS_JS_PATTERNS;
    case "python":
      return PYTHON_PATTERNS;
    case "go":
      return GO_PATTERNS;
    case "rust":
      return RUST_PATTERNS;
    case "java":
      return JAVA_PATTERNS;
    case "c":
    case "cpp":
      return C_CPP_PATTERNS;
    default:
      return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function detectLanguage(filepath: string): string {
  const ext = extname(filepath).toLowerCase();
  return LANGUAGE_MAP[ext] ?? "unknown";
}

/**
 * Find the end of a block starting at `startIdx`.
 * Tracks brace nesting for C-like languages, or indentation for Python.
 */
function findBlockEnd(lines: string[], startIdx: number, language: string): number {
  if (language === "python") {
    // Python: block ends when indentation returns to same level or less
    const startLine = lines[startIdx]!;
    const baseIndent = startLine.match(/^(\s*)/)?.[1]?.length ?? 0;
    let end = startIdx + 1;
    while (end < lines.length) {
      const line = lines[end]!;
      // Skip empty lines
      if (line.trim().length === 0) {
        end++;
        continue;
      }
      const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (indent <= baseIndent) break;
      end++;
    }
    return Math.max(end - 1, startIdx);
  }

  // Brace-based languages
  let braceDepth = 0;
  let foundOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    for (const ch of line) {
      if (ch === "{") {
        braceDepth++;
        foundOpen = true;
      } else if (ch === "}") {
        braceDepth--;
        if (foundOpen && braceDepth === 0) return i;
      }
    }
  }
  // If no matching brace found, take a reasonable chunk
  return Math.min(startIdx + FALLBACK_CHUNK_LINES - 1, lines.length - 1);
}

/**
 * Find the end of a contiguous import block.
 */
function findImportBlockEnd(lines: string[], startIdx: number, importPattern: RegExp[]): number {
  let end = startIdx;
  while (end + 1 < lines.length) {
    const nextLine = lines[end + 1]!.trim();
    // Continue if next line is an import or continuation (empty line between imports)
    if (nextLine.length === 0) {
      // Check if there's another import after the blank line
      if (end + 2 < lines.length && importPattern.some((p) => p.test(lines[end + 2]!.trim()))) {
        end += 2;
        continue;
      }
      break;
    }
    if (importPattern.some((p) => p.test(nextLine))) {
      end++;
    } else {
      break;
    }
  }
  return end;
}

/**
 * Truncate content to MAX_CHUNK_CHARS, returning adjusted lineEnd.
 */
function truncateChunk(
  lines: string[],
  lineStart: number,
  lineEnd: number,
): { content: string; lineEnd: number } {
  let content = "";
  let actualEnd = lineStart;
  for (let i = lineStart; i <= lineEnd && i < lines.length; i++) {
    const candidate = content + (content ? "\n" : "") + lines[i];
    if (candidate.length > MAX_CHUNK_CHARS && content.length > 0) break;
    content = candidate;
    actualEnd = i;
  }
  return { content, lineEnd: actualEnd };
}

// ─── Main ───────────────────────────────────────────────────────

/**
 * Split a source file into semantic code chunks suitable for embedding.
 */
export function chunkFile(filepath: string, content: string): CodeChunk[] {
  const language = detectLanguage(filepath);
  const lines = content.split("\n");
  const patterns = getPatternsForLanguage(language);

  if (!patterns) {
    return fallbackChunk(filepath, lines, language);
  }

  const chunks: CodeChunk[] = [];
  const consumed = new Set<number>();

  // Pass 1: Extract import blocks
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    const trimmed = lines[i]!.trim();
    if (patterns.importBlock.some((p) => p.test(trimmed))) {
      const blockEnd = findImportBlockEnd(lines, i, patterns.importBlock);
      const { content: chunkContent, lineEnd } = truncateChunk(lines, i, blockEnd);
      chunks.push({
        filepath,
        lineStart: i + 1, // 1-based
        lineEnd: lineEnd + 1,
        type: "import",
        name: `imports@${basename(filepath)}`,
        content: chunkContent,
        language,
      });
      for (let j = i; j <= lineEnd; j++) consumed.add(j);
      i = lineEnd;
    }
  }

  // Pass 2: Extract classes
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    const trimmed = lines[i]!.trim();
    for (const pat of patterns.classDecl) {
      const match = trimmed.match(pat);
      if (match) {
        const blockEnd = findBlockEnd(lines, i, language);
        const { content: chunkContent, lineEnd } = truncateChunk(lines, i, blockEnd);
        chunks.push({
          filepath,
          lineStart: i + 1,
          lineEnd: lineEnd + 1,
          type: "class",
          name: match[1]!,
          content: chunkContent,
          language,
        });
        for (let j = i; j <= lineEnd; j++) consumed.add(j);
        i = lineEnd;
        break;
      }
    }
  }

  // Pass 3: Extract functions/methods
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    const trimmed = lines[i]!.trim();
    for (const pat of patterns.functionDecl) {
      const match = trimmed.match(pat);
      if (match) {
        const blockEnd = findBlockEnd(lines, i, language);
        const { content: chunkContent, lineEnd } = truncateChunk(lines, i, blockEnd);
        chunks.push({
          filepath,
          lineStart: i + 1,
          lineEnd: lineEnd + 1,
          type: "function",
          name: match[1]!,
          content: chunkContent,
          language,
        });
        for (let j = i; j <= lineEnd; j++) consumed.add(j);
        i = lineEnd;
        break;
      }
    }
  }

  // Pass 4: Remaining unconsumed lines → fallback blocks
  const remaining: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!consumed.has(i) && lines[i]!.trim().length > 0) remaining.push(i);
  }
  if (remaining.length > 0) {
    // Group contiguous remaining lines into blocks
    let blockStart = remaining[0]!;
    for (let r = 1; r <= remaining.length; r++) {
      if (r === remaining.length || remaining[r]! - remaining[r - 1]! > 3) {
        const blockEnd = remaining[r - 1]!;
        const fallbackChunks = chunkLineRange(filepath, lines, blockStart, blockEnd, language);
        chunks.push(...fallbackChunks);
        if (r < remaining.length) blockStart = remaining[r]!;
      }
    }
  }

  // Sort by line position
  chunks.sort((a, b) => a.lineStart - b.lineStart);
  return chunks;
}

/**
 * Chunk a range of lines into fixed-size blocks with overlap.
 */
function chunkLineRange(
  filepath: string,
  lines: string[],
  start: number,
  end: number,
  language: string,
): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  let i = start;
  while (i <= end) {
    const chunkEnd = Math.min(i + FALLBACK_CHUNK_LINES - 1, end);
    const { content, lineEnd } = truncateChunk(lines, i, chunkEnd);
    if (content.trim().length > 0) {
      chunks.push({
        filepath,
        lineStart: i + 1,
        lineEnd: lineEnd + 1,
        type: "block",
        name: `block@L${i + 1}`,
        content,
        language,
      });
    }
    // Advance with overlap, but always move forward at least 1 line.
    // Without this guard, small trailing blocks (< OVERLAP_LINES lines)
    // cause i to regress and loop forever.
    const prevI = i;
    i = lineEnd + 1 - OVERLAP_LINES;
    if (i <= prevI) i = lineEnd + 1;
  }
  return chunks;
}

/**
 * Fallback chunking for files with no recognized language patterns.
 */
function fallbackChunk(filepath: string, lines: string[], language: string): CodeChunk[] {
  return chunkLineRange(filepath, lines, 0, lines.length - 1, language);
}
