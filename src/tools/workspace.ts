// KCode - Tool Workspace Context
// Provides the effective working directory for tools like Glob and Grep.
// Set by ConversationManager at session init; tools read at execution time.

let _workspaceDir: string | null = null;

/** Set the workspace directory for all tools. Called at session init. */
export function setToolWorkspace(dir: string): void {
  _workspaceDir = dir;
}

/** Get the workspace directory. Falls back to process.cwd() if not set. */
export function getToolWorkspace(): string {
  return _workspaceDir ?? process.cwd();
}
