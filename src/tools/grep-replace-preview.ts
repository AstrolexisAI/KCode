// KCode - GrepReplace Preview Engine
// Generates a diff preview of grep-replace operations without modifying files.

import { join } from "node:path";
import { log } from "../core/logger";

export interface GrepReplacePreviewResult {
  files: Array<{
    path: string;
    matches: number;
    diff: string;
  }>;
  totalFiles: number;
  totalMatches: number;
}

/**
 * Preview a grep-replace without modifying any files.
 * Returns unified diff for each affected file.
 */
export async function previewGrepReplace(
  pattern: string,
  replacement: string,
  glob: string,
  cwd: string,
): Promise<GrepReplacePreviewResult> {
  const results: GrepReplacePreviewResult["files"] = [];

  // Find matching files
  const findProc = Bun.spawn(
    ["rg", "--files-with-matches", "--glob", glob, pattern, cwd],
    { stdout: "pipe", stderr: "pipe" },
  );
  const findOutput = await new Response(findProc.stdout).text();
  const files = findOutput.trim().split("\n").filter(Boolean);

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "g");
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${pattern}`);
  }

  for (const filePath of files) {
    try {
      const file = Bun.file(filePath);
      const content = await file.text();
      const lines = content.split("\n");
      const diffLines: string[] = [];
      let matchCount = 0;

      const relativePath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
      diffLines.push(`--- a/${relativePath}`);
      diffLines.push(`+++ b/${relativePath}`);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        regex.lastIndex = 0;

        if (regex.test(line)) {
          matchCount++;
          regex.lastIndex = 0;
          const newLine = line.replace(regex, replacement);

          // Context (1 line before)
          if (i > 0 && (diffLines.length < 3 || !diffLines[diffLines.length - 1]?.startsWith(" "))) {
            diffLines.push(`@@ -${i},3 +${i},3 @@`);
            diffLines.push(` ${lines[i - 1]}`);
          }

          diffLines.push(`\x1b[31m-${line}\x1b[0m`);
          diffLines.push(`\x1b[32m+${newLine}\x1b[0m`);

          // Context (1 line after)
          if (i + 1 < lines.length) {
            diffLines.push(` ${lines[i + 1]}`);
          }
        }
      }

      if (matchCount > 0) {
        results.push({
          path: relativePath,
          matches: matchCount,
          diff: diffLines.join("\n"),
        });
      }
    } catch (err) {
      log.debug("grep-replace-preview", `Error processing ${filePath}: ${err}`);
    }
  }

  return {
    files: results,
    totalFiles: results.length,
    totalMatches: results.reduce((sum, f) => sum + f.matches, 0),
  };
}

/**
 * Format preview for terminal display.
 */
export function formatPreview(preview: GrepReplacePreviewResult): string {
  const lines: string[] = [];

  lines.push(`\n  GrepReplace Preview: ${preview.totalMatches} match(es) in ${preview.totalFiles} file(s)\n`);

  for (const file of preview.files) {
    lines.push(`  \x1b[1m${file.path}\x1b[0m (${file.matches} match${file.matches !== 1 ? "es" : ""})`);
    lines.push(file.diff);
    lines.push("");
  }

  if (preview.totalFiles === 0) {
    lines.push("  No matches found.");
  }

  return lines.join("\n");
}
