// KCode - Memory System
// Read/write memory files with YAML frontmatter + markdown content

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { kcodeHome } from "./paths";

// ─── Types ──────────────────────────────────────────────────────

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  /** Filename (without path) */
  filename: string;
  /** Full path to the memory file */
  path: string;
  /** YAML frontmatter fields */
  meta: MemoryMeta;
  /** Markdown body content */
  content: string;
}

export interface MemoryMeta {
  type: MemoryType;
  title: string;
  created?: string;
  updated?: string;
  tags?: string[];
  [key: string]: unknown;
}

// ─── Constants ──────────────────────────────────────────────────

const KCODE_HOME = kcodeHome();
const MEMORY_INDEX = "MEMORY.md";
const MEMORY_LINE_LIMIT = 200;

// ─── Path Helpers ───────────────────────────────────────────────

function hashProjectPath(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

export function getMemoryDir(projectPath: string): string {
  const hash = hashProjectPath(projectPath);
  return join(KCODE_HOME, "projects", hash, "memory");
}

export function getUserMemoryDir(): string {
  return join(KCODE_HOME, "memory");
}

// ─── YAML Frontmatter Parsing ───────────────────────────────────

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { meta: {}, content: raw };
  }

  const yamlBlock = match[1]!;
  const content = match[2]!.trim();
  const meta: Record<string, unknown> = {};

  // Simple YAML parser for flat key-value pairs and arrays
  for (const line of yamlBlock.split("\n")) {
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (!kvMatch) continue;
    const [, key, rawValue] = kvMatch;
    const value = rawValue!.trim();

    if (value.startsWith("[") && value.endsWith("]")) {
      // Inline array: [tag1, tag2]
      meta[key!] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else if (value === "" || value === "~" || value === "null") {
      meta[key!] = undefined;
    } else {
      meta[key!] = value.replace(/^["']|["']$/g, "");
    }
  }

  return { meta, content };
}

function serializeFrontmatter(meta: MemoryMeta, content: string): string {
  const lines: string[] = ["---"];
  lines.push(`type: ${meta.type}`);
  lines.push(`title: ${meta.title}`);
  if (meta.created) lines.push(`created: ${meta.created}`);
  if (meta.updated) lines.push(`updated: ${meta.updated}`);
  if (meta.tags && meta.tags.length > 0) {
    lines.push(`tags: [${meta.tags.join(", ")}]`);
  }
  // Include any extra fields
  for (const [key, value] of Object.entries(meta)) {
    if (["type", "title", "created", "updated", "tags"].includes(key)) continue;
    if (value !== undefined) lines.push(`${key}: ${value}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(content);
  return lines.join("\n") + "\n";
}

// ─── File I/O ───────────────────────────────────────────────────

async function ensureDir(dir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
}

// ─── Read/Write Memory Files ────────────────────────────────────

export async function readMemoryFile(filePath: string): Promise<MemoryEntry | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const raw = await file.text();
    const { meta, content } = parseFrontmatter(raw);

    return {
      filename: basename(filePath),
      path: filePath,
      meta: {
        type: (meta.type as MemoryType) ?? "reference",
        title: (meta.title as string) ?? basename(filePath, ".md"),
        created: meta.created as string | undefined,
        updated: meta.updated as string | undefined,
        tags: meta.tags as string[] | undefined,
      },
      content,
    };
  } catch {
    return null;
  }
}

export async function writeMemoryFile(
  dir: string,
  filename: string,
  meta: MemoryMeta,
  content: string,
): Promise<string> {
  // Path traversal guard: reject filenames with ".." or absolute paths
  if (filename.includes("..") || filename.startsWith("/") || filename.startsWith("\\")) {
    throw new Error(`Invalid memory filename: "${filename}" — path traversal not allowed`);
  }
  await ensureDir(dir);
  const now = new Date().toISOString();
  const fullMeta: MemoryMeta = {
    ...meta,
    created: meta.created ?? now,
    updated: now,
  };
  const filePath = join(dir, filename);
  const serialized = serializeFrontmatter(fullMeta, content);
  await Bun.write(filePath, serialized);
  return filePath;
}

// ─── MEMORY.md Index ────────────────────────────────────────────

export async function readMemoryIndex(projectPath: string): Promise<string | null> {
  const dir = getMemoryDir(projectPath);
  const indexPath = join(dir, MEMORY_INDEX);
  try {
    const file = Bun.file(indexPath);
    if (!(await file.exists())) return null;
    return await file.text();
  } catch {
    return null;
  }
}

export async function writeMemoryIndex(projectPath: string, content: string): Promise<void> {
  const dir = getMemoryDir(projectPath);
  await ensureDir(dir);
  const indexPath = join(dir, MEMORY_INDEX);

  // Enforce line limit
  const lines = content.split("\n");
  const truncated =
    lines.length > MEMORY_LINE_LIMIT
      ? lines.slice(0, MEMORY_LINE_LIMIT).join("\n") + "\n\n... (truncated at 200 lines)\n"
      : content;

  await Bun.write(indexPath, truncated);
}

// ─── List and Search Memories ───────────────────────────────────

export function listMemoryFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== MEMORY_INDEX)
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export async function loadAllMemories(projectPath: string): Promise<MemoryEntry[]> {
  const dir = getMemoryDir(projectPath);
  const files = listMemoryFiles(dir);
  const entries: MemoryEntry[] = [];

  for (const filePath of files) {
    const entry = await readMemoryFile(filePath);
    if (entry) entries.push(entry);
  }

  return entries;
}

/**
 * Search memories by pattern (grep through memory directory).
 */
export async function searchMemories(projectPath: string, pattern: string): Promise<MemoryEntry[]> {
  const dir = getMemoryDir(projectPath);

  return new Promise((resolve) => {
    const results: string[] = [];

    // Guard against excessively long/complex patterns that could cause grep to hang
    const safePattern = pattern.length > 200 ? pattern.slice(0, 200) : pattern;

    const proc = spawn("grep", ["-rl", "-i", "-F", "--", safePattern, dir], {
      timeout: 10_000,
    });

    proc.stdout.on("data", (data: Buffer) => {
      results.push(data.toString("utf-8"));
    });

    proc.on("close", async () => {
      const files = results
        .join("")
        .split("\n")
        .filter((f) => f.endsWith(".md"));

      const entries: MemoryEntry[] = [];
      for (const filePath of files) {
        const entry = await readMemoryFile(filePath);
        if (entry) entries.push(entry);
      }
      resolve(entries);
    });

    proc.on("error", () => {
      resolve([]);
    });
  });
}

// ─── @include Syntax Support ────────────────────────────────────

const INCLUDE_PATTERN = /^@include\s+(.+)$/gm;

/**
 * Process @include directives in memory content.
 * Resolves relative paths against the memory directory.
 */
export async function resolveIncludes(content: string, baseDir: string): Promise<string> {
  const matches = [...content.matchAll(INCLUDE_PATTERN)];
  if (matches.length === 0) return content;

  let resolved = content;
  for (const match of matches) {
    const includePath = match[1]!.trim();
    const fullPath = includePath.startsWith("/") ? includePath : join(baseDir, includePath);

    // Prevent path traversal — includes must resolve within baseDir
    const { resolve: resolvePath } = await import("node:path");
    const resolvedFull = resolvePath(fullPath);
    if (!resolvedFull.startsWith(resolvePath(baseDir))) {
      resolved = resolved.replace(
        match[0],
        `<!-- include blocked: path outside memory directory -->`,
      );
      continue;
    }

    try {
      const { realpathSync } = await import("node:fs");
      const { resolve: resolvePath2 } = await import("node:path");
      // Resolve symlinks to prevent traversal via symlinks inside baseDir
      let realFull: string;
      try {
        realFull = realpathSync(resolvedFull);
        if (!realFull.startsWith(resolvePath2(baseDir))) {
          resolved = resolved.replace(
            match[0],
            `<!-- include blocked: symlink escapes memory directory -->`,
          );
          continue;
        }
      } catch {
        // File doesn't exist — check below handles it
      }

      const file = Bun.file(resolvedFull);
      if (await file.exists()) {
        const includeContent = await file.text();
        resolved = resolved.replace(match[0], includeContent);
      } else {
        resolved = resolved.replace(match[0], `<!-- include not found: ${includePath} -->`);
      }
    } catch {
      resolved = resolved.replace(match[0], `<!-- include error: ${includePath} -->`);
    }
  }

  return resolved;
}

// ─── Load Context-Relevant Memories ─────────────────────────────

/**
 * Load memory index and user-level memories for injection into conversation context.
 * Returns a formatted string suitable for system prompt injection.
 */
export async function loadMemoryContext(projectPath: string): Promise<string | null> {
  const parts: string[] = [];

  // Load project MEMORY.md index
  const index = await readMemoryIndex(projectPath);
  if (index) {
    const resolved = await resolveIncludes(index, getMemoryDir(projectPath));
    parts.push(`# Project Memory\n\n${resolved}`);
  }

  // Load user-level memories
  const userDir = getUserMemoryDir();
  const userFiles = listMemoryFiles(userDir);
  for (const filePath of userFiles) {
    const entry = await readMemoryFile(filePath);
    if (entry && entry.meta.type === "user") {
      parts.push(`# User Memory: ${entry.meta.title}\n\n${entry.content}`);
    }
  }

  return parts.length > 0 ? parts.join("\n\n---\n\n") : null;
}

// ─── Delete Memory ──────────────────────────────────────────────

export async function deleteMemoryFile(filePath: string): Promise<boolean> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}
