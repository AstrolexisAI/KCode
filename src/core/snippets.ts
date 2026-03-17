// KCode - Snippet Manager
// Save and retrieve reusable code/text snippets

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";

const SNIPPETS_DIR = join(homedir(), ".kcode", "snippets");

export interface Snippet {
  name: string;
  content: string;
  createdAt: string;
}

function ensureDir(): void {
  if (!existsSync(SNIPPETS_DIR)) {
    mkdirSync(SNIPPETS_DIR, { recursive: true });
  }
}

function snippetPath(name: string): string {
  // Sanitize name: alphanumeric, dashes, underscores only
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(SNIPPETS_DIR, `${safe}.json`);
}

export function saveSnippet(name: string, content: string): Snippet {
  ensureDir();
  const snippet: Snippet = { name, content, createdAt: new Date().toISOString() };
  writeFileSync(snippetPath(name), JSON.stringify(snippet, null, 2), "utf-8");
  return snippet;
}

export function loadSnippet(name: string): Snippet | null {
  const path = snippetPath(name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Snippet;
  } catch {
    return null;
  }
}

export function listSnippets(): Snippet[] {
  ensureDir();
  const files = readdirSync(SNIPPETS_DIR).filter(f => f.endsWith(".json"));
  const snippets: Snippet[] = [];
  for (const file of files.sort()) {
    try {
      snippets.push(JSON.parse(readFileSync(join(SNIPPETS_DIR, file), "utf-8")) as Snippet);
    } catch { /* skip corrupt files */ }
  }
  return snippets;
}

export function deleteSnippet(name: string): boolean {
  const path = snippetPath(name);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
