// KCode - Layer 9: Intention Engine
// Post-task evaluation rules that detect missing steps and suggest follow-up actions

import { log } from "./logger";

export interface Suggestion {
  type: "test" | "verify" | "commit" | "cleanup" | "safety" | "optimize";
  message: string;
  priority: "low" | "medium" | "high";
}

interface ToolAction {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export class IntentionEngine {
  private actions: ToolAction[] = [];

  recordAction(name: string, input: Record<string, unknown>, result?: string, isError?: boolean): void {
    this.actions.push({ name, input, result, isError });
  }

  evaluate(): Suggestion[] {
    const suggestions: Suggestion[] = [];
    try {
      this.checkIncompleteTask(suggestions);
      this.checkMissingTests(suggestions);
      this.checkUnverifiedWrites(suggestions);
      this.checkRepeatedFailures(suggestions);
      this.checkUnsafePatterns(suggestions);
      this.checkSimilarEdits(suggestions);
      this.checkMissingCommit(suggestions);
    } catch (err) {
      log.error("intentions", `Evaluation error: ${err}`);
    }
    return suggestions;
  }

  reset(): void {
    this.actions = [];
  }

  /**
   * Rule: If tasks were created but not all completed, and only directories were made
   * (no actual code files written), the model stopped too early.
   */
  private checkIncompleteTask(suggestions: Suggestion[]): void {
    const taskCreates = this.actions.filter(a => a.name === "TaskCreate");
    const taskCompletes = this.actions.filter(a => a.name === "TaskUpdate" && String(a.input.status ?? "") === "completed");
    const writes = this.actions.filter(a => a.name === "Write" && !a.isError);
    const mkdirs = this.actions.filter(a => a.name === "Bash" && /mkdir/.test(String(a.input.command ?? "")));

    // Tasks created but few completed, and mostly just mkdir with no real file writes
    if (taskCreates.length >= 2 && taskCompletes.length < taskCreates.length && writes.length === 0 && mkdirs.length > 0) {
      suggestions.push({
        type: "verify",
        message: `You created ${taskCreates.length} tasks but only completed ${taskCompletes.length}, and no files were written yet — only directories. Continue working on the remaining tasks.`,
        priority: "high",
      });
    }

    // More general: tasks created but nothing substantial done
    if (taskCreates.length >= 3 && writes.length === 0 && this.actions.filter(a => a.name === "Edit").length === 0) {
      suggestions.push({
        type: "verify",
        message: "You planned tasks but didn't create any files. Don't just plan — execute the plan now.",
        priority: "high",
      });
    }
  }

  private checkMissingTests(suggestions: Suggestion[]): void {
    const hasCodeChanges = this.actions.some(a => (a.name === "Write" || a.name === "Edit") && this.isCodeFile(String(a.input.file_path ?? "")));
    const hasTestRun = this.actions.some(a => a.name === "Bash" && /\b(test|jest|vitest|pytest|cargo test|go test|bun test)\b/i.test(String(a.input.command ?? "")));
    if (hasCodeChanges && !hasTestRun) {
      const files = this.actions.filter(a => (a.name === "Write" || a.name === "Edit") && this.isCodeFile(String(a.input.file_path ?? ""))).map(a => String(a.input.file_path ?? ""));
      if (files.length > 0) {
        suggestions.push({ type: "test", message: `Code modified but no tests run. Consider testing: ${files.slice(0, 3).join(", ")}`, priority: "medium" });
      }
    }
  }

  private checkUnverifiedWrites(suggestions: Suggestion[]): void {
    const written = new Set<string>();
    const verified = new Set<string>();
    for (const a of this.actions) {
      if (a.name === "Write") written.add(String(a.input.file_path ?? ""));
      if (a.name === "Read" || (a.name === "Bash" && String(a.input.command ?? "").includes("curl"))) {
        verified.add(String(a.input.file_path ?? a.input.command ?? ""));
      }
    }
    const unverified = [...written].filter(f => ![...verified].some(v => v.includes(f) || f.includes(v)));
    if (unverified.length > 0 && unverified.length <= 5) {
      suggestions.push({ type: "verify", message: `Created files not verified: ${unverified.join(", ")}`, priority: "low" });
    }
  }

  private checkRepeatedFailures(suggestions: Suggestion[]): void {
    const counts = new Map<string, number>();
    for (const a of this.actions) {
      if (a.isError) {
        const key = `${a.name}:${String(a.input.command ?? a.input.file_path ?? "").slice(0, 50)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    for (const [key, count] of counts) {
      if (count >= 3) {
        suggestions.push({ type: "optimize", message: `"${key}" failed ${count} times. Try a different approach.`, priority: "high" });
      }
    }
  }

  private checkUnsafePatterns(suggestions: Suggestion[]): void {
    const patterns = [
      { pattern: /rm\s+-rf\s+\//, label: "recursive delete at root" },
      { pattern: /chmod\s+777/, label: "world-writable permissions" },
      { pattern: /curl.*\|\s*(bash|sh)/, label: "piping remote script to shell" },
      { pattern: /--no-verify/, label: "skipping git hooks" },
      { pattern: /DROP\s+TABLE|DROP\s+DATABASE/i, label: "destructive SQL" },
    ];
    for (const a of this.actions) {
      if (a.name === "Bash") {
        const cmd = String(a.input.command ?? "");
        for (const { pattern, label } of patterns) {
          if (pattern.test(cmd)) {
            suggestions.push({ type: "safety", message: `Unsafe command: ${label}`, priority: "high" });
          }
        }
      }
    }
  }

  private checkSimilarEdits(suggestions: Suggestion[]): void {
    const edits = this.actions.filter(a => a.name === "Edit");
    if (edits.length < 4) return;
    const seen = new Map<string, number>();
    for (const e of edits) {
      const content = String(e.input.old_string ?? "").slice(0, 20);
      if (content.length >= 10) seen.set(content, (seen.get(content) ?? 0) + 1);
    }
    for (const [, count] of seen) {
      if (count >= 3) {
        suggestions.push({ type: "optimize", message: `${count} similar edits. Consider replace_all or batch approach.`, priority: "low" });
        break;
      }
    }
  }

  private checkMissingCommit(suggestions: Suggestion[]): void {
    const codeChanges = this.actions.filter(a => (a.name === "Write" || a.name === "Edit") && this.isCodeFile(String(a.input.file_path ?? "")));
    const hasCommit = this.actions.some(a => a.name === "Bash" && /git\s+commit/i.test(String(a.input.command ?? "")));
    if (codeChanges.length >= 3 && !hasCommit) {
      suggestions.push({ type: "commit", message: `${codeChanges.length} files modified. Consider committing.`, priority: "low" });
    }
  }

  /**
   * Real-time check after each tool result. Returns a warning string to inject
   * into the conversation if the model is wasting context, or null if fine.
   * This is called inline during the agent loop, not just at the end.
   */
  getInlineWarning(): string | null {
    // ── Universal: detect ANY identical tool call repeated 3+ times ──
    const callCounts = new Map<string, number>();
    for (const a of this.actions) {
      // Create a signature from tool name + key input params
      const inputKey = a.name === "Bash"
        ? String(a.input.command ?? "").slice(0, 100)
        : String(a.input.file_path ?? a.input.pattern ?? a.input.query ?? JSON.stringify(a.input).slice(0, 100));
      const sig = `${a.name}:${inputKey}`;
      callCounts.set(sig, (callCounts.get(sig) ?? 0) + 1);
    }
    for (const [sig, count] of callCounts) {
      if (count >= 3) {
        return `STOP: You have called "${sig.slice(0, 80)}" ${count} times with identical parameters. You are in an infinite loop. Do something DIFFERENT — do not call this tool again with the same input. If you need to read a file, use offset/limit to read a different section. If you are stuck, tell the user.`;
      }
    }

    // Detect repeated empty searches (WebSearch returning no results)
    const emptySearches = this.actions.filter(
      a => a.name === "WebSearch" && a.result && /no\s*(search)?\s*results?\s*found/i.test(a.result),
    );
    if (emptySearches.length >= 3) {
      return `STOP SEARCHING. You've done ${emptySearches.length} web searches with zero results. The search engine has no results for this topic. Instead: try fetching a known URL directly (WebFetch), or use the information you already have to proceed. Do NOT call WebSearch again for this topic.`;
    }

    // Detect redundant directory listings (Glob/ls on same path)
    const dirChecks = this.actions.filter(a =>
      (a.name === "Glob") ||
      (a.name === "Bash" && /\b(ls|find)\b/.test(String(a.input.command ?? ""))),
    );
    if (dirChecks.length >= 5) {
      const paths = dirChecks.map(a => String(a.input.pattern ?? a.input.command ?? "").slice(0, 60));
      const unique = new Set(paths);
      if (unique.size <= 2) {
        return `You've checked the same directory ${dirChecks.length} times. The directory structure hasn't changed. Stop listing files and start CREATING them.`;
      }
    }

    return null;
  }

  private isCodeFile(path: string): boolean {
    return [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".swift", ".rb", ".c", ".cpp", ".h", ".cs", ".vue", ".svelte"].some(ext => path.endsWith(ext));
  }
}

let _engine: IntentionEngine | null = null;
export function getIntentionEngine(): IntentionEngine {
  if (!_engine) _engine = new IntentionEngine();
  return _engine;
}
