// KCode - Changelog Generator
// Generates structured changelogs from git history.

import { log } from "../logger";
import { parseConventionalCommit, classifyCommit } from "./commit-parser";
import type { Changelog, ChangelogEntry, ChangelogOptions, RawCommit } from "./types";

/**
 * Generate a changelog from git commits since the last tag.
 */
export async function generateChangelog(options: ChangelogOptions = {}): Promise<Changelog> {
  const cwd = options.cwd ?? process.cwd();
  const lastTag = options.since ?? (await getLastTag(cwd));
  const commits = await getCommitsSince(lastTag, cwd);

  const entries: ChangelogEntry[] = [];

  for (const commit of commits) {
    const parsed = parseConventionalCommit(commit.message);
    if (parsed) {
      entries.push({ ...parsed, hash: commit.hash, author: commit.author, date: commit.date });
    } else {
      const classified = classifyCommit(commit.message);
      entries.push({ ...classified, hash: commit.hash, author: commit.author, date: commit.date });
    }
  }

  const breaking = entries.filter((e) => e.breaking);
  const features = entries.filter((e) => e.type === "feat" && !e.breaking);
  const fixes = entries.filter((e) => e.type === "fix" && !e.breaking);
  const other = entries.filter((e) => !["feat", "fix"].includes(e.type) && !e.breaking);

  const version = options.version ?? "Unreleased";
  const date = new Date().toISOString().split("T")[0]!;
  const markdown = renderMarkdown(version, date, breaking, features, fixes, other);

  return { version, date, entries, breaking, features, fixes, other, markdown };
}

// ─── Git helpers ───────────────────────────────────────────────

export async function getLastTag(cwd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "describe", "--tags", "--abbrev=0"], { cwd, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) return "";
    const output = await new Response(proc.stdout).text();
    return output.trim();
  } catch {
    return "";
  }
}

export async function getCommitsSince(since: string, cwd: string): Promise<RawCommit[]> {
  const range = since ? `${since}..HEAD` : "HEAD";
  try {
    const proc = Bun.spawn(
      ["git", "log", range, "--pretty=format:%H|%s|%an|%as"],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) return [];
    const output = await new Response(proc.stdout).text();
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("|");
        return {
          hash: parts[0] ?? "",
          message: parts[1] ?? "",
          author: parts[2] ?? "",
          date: parts[3] ?? "",
        };
      });
  } catch {
    return [];
  }
}

// ─── Markdown renderer ─────────────────────────────────────────

function renderMarkdown(
  version: string,
  date: string,
  breaking: ChangelogEntry[],
  features: ChangelogEntry[],
  fixes: ChangelogEntry[],
  other: ChangelogEntry[],
): string {
  let md = `## ${version} (${date})\n\n`;

  if (breaking.length > 0) {
    md += "### BREAKING CHANGES\n\n";
    for (const e of breaking) md += `- ${e.description} (${e.hash.slice(0, 7)})\n`;
    md += "\n";
  }

  if (features.length > 0) {
    md += "### Features\n\n";
    for (const e of features) {
      const scope = e.scope ? `**${e.scope}:** ` : "";
      md += `- ${scope}${e.description} (${e.hash.slice(0, 7)})\n`;
    }
    md += "\n";
  }

  if (fixes.length > 0) {
    md += "### Bug Fixes\n\n";
    for (const e of fixes) {
      const scope = e.scope ? `**${e.scope}:** ` : "";
      md += `- ${scope}${e.description} (${e.hash.slice(0, 7)})\n`;
    }
    md += "\n";
  }

  if (other.length > 0) {
    md += "### Other Changes\n\n";
    for (const e of other) md += `- ${e.description} (${e.hash.slice(0, 7)})\n`;
    md += "\n";
  }

  return md;
}
