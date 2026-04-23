// KCode - MultiEdit Tool
// Applies multiple edits atomically across one or more files in a single tool call.
// All edits are validated before any writes happen — if any edit fails validation,
// no files are modified (atomic all-or-nothing).

import { readFileSync, writeFileSync } from "node:fs";
import { checkMutationAllowed } from "../core/audit-guards";
import { detectStrcmpInversion } from "../core/semantic-guards";
import type { ToolDefinition, ToolResult } from "../core/types";

export const multiEditDefinition: ToolDefinition = {
  name: "MultiEdit",
  description:
    "Apply multiple file edits atomically. All edits are validated first; if any fails, no files are changed. " +
    "Use this for refactors that touch multiple files in one logical operation.",
  input_schema: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        description: "Array of edit operations to apply",
        items: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Absolute path to the file" },
            old_string: { type: "string", description: "The exact text to find and replace" },
            new_string: { type: "string", description: "The replacement text" },
            replace_all: {
              type: "boolean",
              description: "Replace all occurrences (default false)",
            },
          },
          required: ["file_path", "old_string", "new_string"],
        },
      },
    },
    required: ["edits"],
  },
};

interface EditOp {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * Generate a compact diff for a single replacement.
 */
function miniDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  if (oldLines.length <= 4 && newLines.length <= 4) {
    const parts: string[] = [];
    for (const l of oldLines) parts.push(`  - ${l}`);
    for (const l of newLines) parts.push(`  + ${l}`);
    return parts.join("\n");
  }

  return `  - (${oldLines.length} lines) → + (${newLines.length} lines)`;
}

export async function executeMultiEdit(input: Record<string, unknown>): Promise<ToolResult> {
  // Phase 4: detect immediate retry of a failed MultiEdit
  try {
    const { detectImmediateEditRetry, acknowledgeEditWarning } = await import(
      "../core/file-edit-history.js"
    );
    const warning = detectImmediateEditRetry("MultiEdit", input);
    if (warning) {
      acknowledgeEditWarning("MultiEdit", input);
      return { tool_use_id: "", content: warning.report, is_error: true };
    }
  } catch {
    /* non-fatal */
  }

  const result = await _executeMultiEditInner(input);

  try {
    const { recordEditAttempt } = await import("../core/file-edit-history.js");
    recordEditAttempt("MultiEdit", input, result.is_error ?? false, String(result.content ?? ""));
  } catch {
    /* non-fatal */
  }

  return result;
}

async function _executeMultiEditInner(input: Record<string, unknown>): Promise<ToolResult> {
  const edits = input.edits as EditOp[] | undefined;

  if (!edits || !Array.isArray(edits) || edits.length === 0) {
    return {
      tool_use_id: "",
      content: "Error: 'edits' must be a non-empty array.",
      is_error: true,
    };
  }

  if (edits.length > 50) {
    return {
      tool_use_id: "",
      content: "Error: Maximum 50 edits per MultiEdit call.",
      is_error: true,
    };
  }

  // Audit-session guard: check every target file. If any is blocked,
  // refuse the entire MultiEdit (atomic all-or-nothing).
  const blockedFiles: string[] = [];
  let firstBlockReason: string | null = null;
  for (const edit of edits) {
    if (!edit?.file_path) continue;
    // Unified mutation policy (Phase 2) — see edit.ts for rationale.
    const policy = checkMutationAllowed(edit.file_path, "MultiEdit");
    if (!policy.allowed) {
      blockedFiles.push(edit.file_path);
      if (!firstBlockReason) firstBlockReason = policy.reason!;
    }
  }
  if (blockedFiles.length > 0) {
    return {
      tool_use_id: "",
      content:
        firstBlockReason! +
        (blockedFiles.length > 1
          ? `\n\nAdditional blocked files in this MultiEdit: ${blockedFiles.slice(1).join(", ")}`
          : ""),
      is_error: true,
    };
  }

  // Semantic inversion guard — applied to every edit in the batch.
  for (const edit of edits) {
    if (!edit?.old_string || !edit?.new_string) continue;
    const inversionError = detectStrcmpInversion(edit.old_string, edit.new_string);
    if (inversionError) {
      return {
        tool_use_id: "",
        content: `${inversionError}\n\nFile: ${edit.file_path ?? "(unknown)"}`,
        is_error: true,
      };
    }
  }

  // ── Phase 1: Read all files and validate every edit ───────────────

  // Group edits by file so we apply them sequentially on the same content
  const fileEdits = new Map<string, EditOp[]>();
  for (const edit of edits) {
    if (
      typeof edit.file_path !== "string" ||
      edit.file_path.trim() === "" ||
      typeof edit.old_string !== "string" ||
      edit.old_string === "" ||
      typeof edit.new_string !== "string"
    ) {
      return {
        tool_use_id: "",
        content: `Error: Each edit must have file_path (string), old_string (non-empty string), and new_string (string).`,
        is_error: true,
      };
    }
    const existing = fileEdits.get(edit.file_path) ?? [];
    existing.push(edit);
    fileEdits.set(edit.file_path, existing);
  }

  // Read originals and compute final content for each file
  const filePlans = new Map<string, { original: string; updated: string }>();
  const results: string[] = [];

  for (const [filePath, ops] of fileEdits) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (err) {
      return {
        tool_use_id: "",
        content: `Error: Cannot read ${filePath}: ${err instanceof Error ? err.message : err}`,
        is_error: true,
      };
    }

    let working = content;
    for (const op of ops) {
      if (op.old_string === op.new_string) {
        return {
          tool_use_id: "",
          content: `Error: old_string === new_string in ${filePath}. No edit needed. Do NOT retry.`,
          is_error: true,
        };
      }

      const occurrences = working.split(op.old_string).length - 1;
      if (occurrences === 0) {
        return {
          tool_use_id: "",
          content: `Error: old_string not found in ${filePath}:\n  "${op.old_string.slice(0, 80)}"`,
          is_error: true,
        };
      }
      if (occurrences > 1 && !op.replace_all) {
        return {
          tool_use_id: "",
          content: `Error: old_string found ${occurrences} times in ${filePath}. Use replace_all or add more context.`,
          is_error: true,
        };
      }

      working = op.replace_all
        ? working.replaceAll(op.old_string, op.new_string)
        : working.replace(op.old_string, op.new_string);
    }

    filePlans.set(filePath, { original: content, updated: working });
  }

  // ── Phase 2: Write all files (atomic — all validated before any write) ──

  const writtenFiles: string[] = [];
  for (const [filePath, plan] of filePlans) {
    try {
      writeFileSync(filePath, plan.updated, "utf-8");
      writtenFiles.push(filePath);
    } catch (err) {
      // Roll back already-written files (best-effort)
      let rollbackFailed = false;
      for (const written of writtenFiles) {
        const orig = filePlans.get(written)!;
        try {
          writeFileSync(written, orig.original, "utf-8");
        } catch {
          rollbackFailed = true;
        }
      }
      const rollbackMsg = rollbackFailed
        ? "Partial rollback attempted (some files may not have been restored)."
        : "All changes rolled back.";
      return {
        tool_use_id: "",
        content: `Error writing ${filePath}: ${err instanceof Error ? err.message : err}. ${rollbackMsg}`,
        is_error: true,
      };
    }

    // Build summary for this file
    const ops = fileEdits.get(filePath)!;
    const linesDelta = plan.updated.split("\n").length - plan.original.split("\n").length;
    const delta = linesDelta > 0 ? `+${linesDelta}` : linesDelta === 0 ? "±0" : `${linesDelta}`;
    results.push(`${filePath} (${ops.length} edit${ops.length > 1 ? "s" : ""}, ${delta} lines)`);

    for (const op of ops) {
      results.push(miniDiff(op.old_string, op.new_string));
    }

    // Phase 27 for MultiEdit: run location-mismatch check against the
    // FIRST edit in this file. If the first edit is far from user
    // hints, subsequent edits are likely in the same region and the
    // single warning covers them all. Non-blocking — appended to the
    // results list so it shows up in the success message.
    try {
      const firstOp = ops[0];
      if (firstOp) {
        const firstEditLine =
          plan.original.slice(0, plan.original.indexOf(firstOp.old_string))
            .split("\n").length;
        const { getUserTexts } = await import("../core/session-tracker.js");
        const { extractLocationHints, checkEditLocationMismatch, buildLocationWarning } =
          await import("../core/edit-location-check.js");
        const hints = extractLocationHints(getUserTexts());
        const verdict = checkEditLocationMismatch(
          hints,
          firstEditLine,
          filePath,
          plan.original,
        );
        if (verdict.isMismatch) {
          results.push(buildLocationWarning(verdict));
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  return {
    tool_use_id: "",
    content: `MultiEdit: ${edits.length} edit${edits.length > 1 ? "s" : ""} across ${filePlans.size} file${filePlans.size > 1 ? "s" : ""}\n\n${results.join("\n")}`,
  };
}
