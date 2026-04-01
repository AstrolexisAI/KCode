// KCode - Conventional Commit Parser

import type { CommitType, ChangelogEntry } from "./types";

/**
 * Parse a conventional commit message.
 * Format: type(scope): description
 * Or:     type: description
 * Or:     type!: description (breaking change)
 */
export function parseConventionalCommit(message: string): Omit<ChangelogEntry, "hash" | "author" | "date"> | null {
  // Match: type(scope)!: description  or  type!: description  or  type(scope): description
  const match = message.match(/^(\w+)(?:\(([^)]+)\))?(!)?\s*:\s*(.+)$/);
  if (!match) return null;

  const rawType = match[1]!.toLowerCase();
  const scope = match[2] || undefined;
  const bangBreaking = match[3] === "!";
  const description = match[4]!.trim();

  const validTypes: CommitType[] = ["feat", "fix", "docs", "refactor", "test", "chore", "perf", "style", "ci", "build"];
  const type: CommitType = validTypes.includes(rawType as CommitType) ? (rawType as CommitType) : "chore";

  // Check for BREAKING CHANGE in footer (simplified — just check prefix)
  const breaking = bangBreaking || description.toUpperCase().includes("BREAKING CHANGE");

  return { type, scope, description, breaking };
}

/**
 * Classify a non-conventional commit message heuristically.
 */
export function classifyCommit(message: string): Omit<ChangelogEntry, "hash" | "author" | "date"> {
  const lower = message.toLowerCase();

  if (lower.startsWith("fix") || lower.includes("bug") || lower.includes("patch")) {
    return { type: "fix", description: message, breaking: false };
  }
  if (lower.startsWith("add") || lower.startsWith("implement") || lower.includes("feature") || lower.startsWith("feat")) {
    return { type: "feat", description: message, breaking: false };
  }
  if (lower.startsWith("refactor") || lower.includes("cleanup") || lower.includes("clean up")) {
    return { type: "refactor", description: message, breaking: false };
  }
  if (lower.startsWith("doc") || lower.includes("readme")) {
    return { type: "docs", description: message, breaking: false };
  }
  if (lower.startsWith("test") || lower.includes("coverage")) {
    return { type: "test", description: message, breaking: false };
  }
  if (lower.includes("perf") || lower.includes("optimize") || lower.includes("speed")) {
    return { type: "perf", description: message, breaking: false };
  }
  if (lower.startsWith("bump") || lower.startsWith("release") || lower.startsWith("version")) {
    return { type: "chore", description: message, breaking: false };
  }
  if (lower.includes("breaking") || lower.includes("BREAKING")) {
    return { type: "breaking", description: message, breaking: true };
  }

  return { type: "chore", description: message, breaking: false };
}
