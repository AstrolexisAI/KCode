// Facade for file/slash-command actions. The actual handlers live in
// sibling modules (file-actions-<group>.ts) and are tried in order until
// one returns a non-null result.

import type { ActionContext } from "./action-helpers.js";
import { handleAnalysisAction } from "./file-actions-analysis.js";
import { handleAuditAction } from "./file-actions-audit.js";
import { handleFormatAction } from "./file-actions-formats.js";
import { handleGitAction } from "./file-actions-git.js";
import { handleStackAction } from "./file-actions-stacks.js";

export async function handleFileAction(action: string, ctx: ActionContext): Promise<string | null> {
  const handlers = [
    handleAuditAction,
    handleGitAction,
    handleAnalysisAction,
    handleStackAction,
    handleFormatAction,
  ];

  for (const handler of handlers) {
    const result = await handler(action, ctx);
    if (result !== null) return result;
  }

  return null;
}
