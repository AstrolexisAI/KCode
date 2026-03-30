// KCode - Output Styles System
// Loads and manages output style definitions that modify the system prompt tone/format

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { kcodePath } from "./paths";

// ─── Built-in Styles ─────────────────────────────────────────────

const BUILTIN_STYLES: Record<string, string> = {
  default: "", // no extra instructions
  concise: "Be extremely concise. Use bullet points. No explanations unless asked. Code only when relevant.",
  verbose: "Be thorough and detailed. Explain your reasoning. Show alternatives considered.",
  "code-only": "Only output code. No explanations, no markdown headers, no commentary. Just the code.",
};

// ─── State ───────────────────────────────────────────────────────

let currentStyle = "default";

// ─── Public API ──────────────────────────────────────────────────

/**
 * Get the name of the currently active output style.
 */
export function getCurrentStyle(): string {
  return currentStyle;
}

/**
 * Set the active output style by name.
 * Returns true if the style exists, false otherwise.
 */
export function setCurrentStyle(name: string): boolean {
  const all = listStyles();
  if (all.includes(name)) {
    currentStyle = name;
    return true;
  }
  return false;
}

/**
 * List all available style names (built-in + custom).
 */
export function listStyles(): string[] {
  const names = new Set<string>(Object.keys(BUILTIN_STYLES));
  for (const name of loadCustomStyleNames()) {
    names.add(name);
  }
  return [...names].sort();
}

/**
 * Get the formatting instructions for the current style.
 * Returns empty string for "default" or if no style is set.
 */
export function getStyleInstructions(): string {
  if (currentStyle === "default") return "";

  // Check built-in styles first
  if (currentStyle in BUILTIN_STYLES) {
    return BUILTIN_STYLES[currentStyle]!;
  }

  // Load from custom style files
  const content = loadCustomStyleContent(currentStyle);
  return content ?? "";
}

// ─── Custom Style Loading ────────────────────────────────────────

/**
 * Directories to scan for custom output style .md files:
 *   1. ~/.kcode/output-styles/*.md  (user-level)
 *   2. .kcode/output-styles/*.md    (project-level, relative to cwd)
 */
function getStyleDirs(): string[] {
  const dirs: string[] = [];
  const userDir = kcodePath("output-styles");
  if (existsSync(userDir)) dirs.push(userDir);

  const projectDir = join(process.cwd(), ".kcode", "output-styles");
  if (existsSync(projectDir)) dirs.push(projectDir);

  return dirs;
}

/**
 * Collect all custom style names from .md files in style directories.
 * The filename (without .md extension) is the style name.
 */
function loadCustomStyleNames(): string[] {
  const names: string[] = [];
  for (const dir of getStyleDirs()) {
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (file.endsWith(".md")) {
          names.push(basename(file, ".md"));
        }
      }
    } catch {
      // Directory unreadable, skip
    }
  }
  return names;
}

/**
 * Load the content of a custom style file by name.
 * Project-level styles take precedence over user-level.
 */
function loadCustomStyleContent(name: string): string | null {
  const filename = `${name}.md`;

  // Project-level first (higher precedence)
  const projectPath = join(process.cwd(), ".kcode", "output-styles", filename);
  if (existsSync(projectPath)) {
    try {
      return readFileSync(projectPath, "utf-8").trim();
    } catch {
      // Fall through
    }
  }

  // User-level fallback
  const userPath = kcodePath("output-styles", filename);
  if (existsSync(userPath)) {
    try {
      return readFileSync(userPath, "utf-8").trim();
    } catch {
      // Fall through
    }
  }

  return null;
}
