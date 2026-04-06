// KCode - PR Generator
//
// Creates a detailed Pull Request from audit findings + applied fixes.
// Uses the LLM to write a professional PR description that explains
// each bug found, its impact, and the fix applied.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AuditResult, Finding } from "./types";

export interface PrOptions {
  projectRoot: string;
  /** LLM callback for generating the PR description */
  llmCallback: (prompt: string) => Promise<string>;
  /** Override branch name (default: fix/kcode-audit-YYYY-MM-DD) */
  branchName?: string;
  /** Target repo for gh pr create (e.g. "nasa/IDF"). Auto-detected if omitted. */
  repo?: string;
  /** Don't actually push or create PR — just generate and show what would happen */
  dryRun?: boolean;
  /** Progress callback for each step */
  onStep?: (step: string) => void;
}

export interface PrResult {
  branchName: string;
  commitHash: string;
  prUrl?: string;
  prDescription: string;
  filesChanged: number;
  dryRun: boolean;
  pushError?: string;
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8", timeout: 30_000 }).trim();
}

function detectRemoteRepo(cwd: string): string | null {
  try {
    const url = git(cwd, "remote get-url origin");
    // Extract owner/repo from various URL formats
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    return m ? m[1]!.replace(/\.git$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * Build a prompt for the LLM to generate a detailed PR description
 * from the audit findings.
 */
function buildPrPrompt(result: AuditResult, fixes: string[]): string {
  const findingsSummary = result.findings
    .map((f, i) => {
      const rel = f.file.replace(result.project + "/", "");
      return `${i + 1}. [${f.severity.toUpperCase()}] ${f.pattern_title} — ${rel}:${f.line}\n   ${f.verification.reasoning}${f.verification.suggested_fix ? "\n   Fix: " + f.verification.suggested_fix : ""}`;
    })
    .join("\n\n");

  const fixesSummary = fixes.map((f) => `- ${f}`).join("\n");

  return `You are writing a Pull Request description for a security/code-quality audit.
Write a professional, detailed PR description in English.

PROJECT: ${basename(result.project)}
FILES SCANNED: ${result.files_scanned}
CONFIRMED FINDINGS: ${result.confirmed_findings}
FALSE POSITIVES: ${result.false_positives}

FINDINGS:
${findingsSummary}

FIXES APPLIED:
${fixesSummary}

Write the PR in this EXACT format:

## Security & Code Quality Audit

**Auditor:** Astrolexis.space — Kulvex Code
**Findings:** N confirmed (N false positives filtered)
**Scan time:** Ns

### Summary
[2-3 sentences explaining what was found and fixed]

### Findings & Fixes

[For EACH finding, write a subsection with:]
#### N. [SEVERITY] Title — file:line
**Bug:** [1-2 sentences explaining the root cause]
**Impact:** [What could go wrong — be specific about exploitation]
**Fix:** [What the patch does]

### Methodology
[1 paragraph about the deterministic pattern library + model verification approach]

### Testing
- [ ] Compilation verified (cmake && make — clean build)
- [ ] No regressions in existing functionality
- [ ] Fixes address CWE references where applicable

---
*Astrolexis.space — Kulvex Code | Deterministic Audit Engine*
`;
}

/**
 * Run the full PR creation pipeline:
 * 1. Create branch
 * 2. Stage + commit fixes
 * 3. Generate PR description via LLM
 * 4. Push + create PR via gh
 */
export async function createPr(opts: PrOptions): Promise<PrResult> {
  const { projectRoot, llmCallback, dryRun = false } = opts;
  const today = new Date().toISOString().split("T")[0];
  const branchName = opts.branchName ?? `fix/kcode-audit-${today}`;

  // Read the audit result
  const jsonPath = resolve(projectRoot, "AUDIT_REPORT.json");
  const mdPath = resolve(projectRoot, "AUDIT_REPORT.md");
  let auditResult: AuditResult;

  if (existsSync(jsonPath)) {
    auditResult = JSON.parse(readFileSync(jsonPath, "utf-8"));
  } else if (existsSync(mdPath)) {
    throw new Error(
      "AUDIT_REPORT.json not found. Run `/scan` with --json first, or re-run `/scan`.",
    );
  } else {
    throw new Error("No AUDIT_REPORT found. Run `/scan` first.");
  }

  // Check for uncommitted changes (our fixes)
  const status = git(projectRoot, "status --porcelain");
  if (!status) {
    throw new Error("No changes to commit. Run `/fix` first to apply patches.");
  }

  const changedFiles = status.split("\n").filter((l) => l.trim()).length;

  // Get the diff summary for the LLM
  const diffStat = git(projectRoot, "diff --stat");
  const fixes = diffStat.split("\n").filter((l) => l.includes("|")).map((l) => l.trim());

  // Generate PR description via LLM
  const prDescription = await llmCallback(buildPrPrompt(auditResult, fixes));

  // Extract title from description (first ## heading)
  const titleMatch = prDescription.match(/^## (.+)$/m);
  const prTitle = titleMatch
    ? titleMatch[1]!.slice(0, 70)
    : `fix: security audit — ${auditResult.confirmed_findings} findings`;

  let commitHash = "";
  let prUrl: string | undefined;
  let pushError: string | undefined;
  const step = opts.onStep ?? (() => {});

  if (!dryRun) {
    // Create branch
    step("Creating branch...");
    try {
      git(projectRoot, `checkout -b ${branchName}`);
    } catch {
      try { git(projectRoot, `checkout ${branchName}`); } catch { /* ignore */ }
    }

    // Stage all changes
    step("Staging changes...");
    git(projectRoot, "add -A");

    // Commit
    step("Committing...");
    const commitMsg = `fix: address ${auditResult.confirmed_findings} security/quality findings from KCode audit

Automated fixes applied by KCode Audit Engine:
- ${fixes.slice(0, 10).join("\n- ")}${fixes.length > 10 ? `\n- ... and ${fixes.length - 10} more` : ""}

Signed-off-by: Astrolexis.space — Kulvex Code
`;
    const { writeFileSync: writeTemp, unlinkSync } = require("node:fs") as typeof import("node:fs");
    const msgFile = resolve(projectRoot, ".kcode-commit-msg");
    writeTemp(msgFile, commitMsg);
    try {
      commitHash = git(projectRoot, `commit -F ${msgFile}`);
      const hashMatch = commitHash.match(/\[[\w/]+ ([a-f0-9]+)\]/);
      commitHash = hashMatch ? hashMatch[1]! : "";
    } finally {
      try { unlinkSync(msgFile); } catch { /* ignore */ }
    }

    // Push (graceful failure — no stacktrace dump)
    step("Pushing branch...");
    try {
      git(projectRoot, `push -u origin ${branchName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Extract just the useful error (permission denied, etc)
      const match = msg.match(/remote: (.+?)\\n|fatal: (.+?)\\n|error: (.+)/);
      pushError = match ? (match[1] ?? match[2] ?? match[3] ?? msg).trim() : "Push failed";
    }

    // Create PR via gh (only if push succeeded)
    if (!pushError) {
      step("Creating PR via gh...");
      const repo = opts.repo ?? detectRemoteRepo(projectRoot);
      if (repo) {
        try {
          const bodyFile = resolve(projectRoot, ".kcode-pr-body");
          writeTemp(bodyFile, prDescription);
          try {
            prUrl = git(
              projectRoot,
              `gh pr create --title "${prTitle}" --body-file ${bodyFile} --repo ${repo}`,
            );
          } catch { prUrl = undefined; }
          finally { try { unlinkSync(bodyFile); } catch { /* ignore */ } }
        } catch { /* gh pr create failed */ }
      }
    }
  }

  step("Done");

  return {
    branchName,
    commitHash,
    prUrl,
    prDescription,
    filesChanged: changedFiles,
    dryRun,
    pushError,
  };
}
