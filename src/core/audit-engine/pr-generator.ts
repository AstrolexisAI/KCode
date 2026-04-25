// KCode - PR Generator
//
// Creates a detailed Pull Request from audit findings + applied fixes.
// Uses the LLM to write a professional PR description that explains
// each bug found, its impact, and the fix applied.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  return execSync(`git ${args}`, { cwd, encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function gh(cwd: string, args: string): string {
  return execSync(`gh ${args}`, { cwd, encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Detect the repository's default integration branch.
 *
 * Order of preference:
 *   1. `origin`'s configured default (`origin/HEAD` symbolic-ref) — what
 *      `gh` and most CI tools use.
 *   2. First match among common conventional names: main, master, devel,
 *      develop, trunk.
 *   3. Fallback to "main" so callers always get a string.
 *
 * Avoids the historic hardcode that broke `/pr` on repos using `devel`
 * (NASA-fprime) or `master` (older projects) — it raised
 * `fatal: ambiguous argument 'main^'`.
 */
function defaultBranch(cwd: string): string {
  try {
    const ref = git(cwd, "symbolic-ref refs/remotes/origin/HEAD");
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1]!;
  } catch { /* origin/HEAD not set — try fallbacks */ }
  for (const candidate of ["main", "master", "devel", "develop", "trunk"]) {
    try {
      execSync(`git rev-parse --verify --quiet ${candidate}`, {
        cwd, encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"],
      });
      return candidate;
    } catch { /* not this one */ }
  }
  return "main";
}

/**
 * Run a git/gh command and capture both stdout and stderr. v316 made
 * push errors generic ("Push to fork failed") because execSync's
 * default error message is just the exit code summary; the actual
 * remote error (e.g. "permission denied", "fork not provisioned yet")
 * was lost. This variant returns the captured stderr so callers can
 * surface it.
 */
function runCapturing(
  bin: "git" | "gh",
  cwd: string,
  args: string,
): { ok: boolean; stdout: string; stderr: string } {
  try {
    const out = execSync(`${bin} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, stdout: out.trim(), stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? e.message ?? "").trim(),
    };
  }
}

/**
 * Returns true when a remote+branch pair exists on the remote (i.e. the
 * local branch was already pushed). Used to make /pr idempotent so a
 * user can re-run after a transient push failure without losing state.
 */
function remoteBranchExists(cwd: string, remote: string, branch: string): boolean {
  const r = runCapturing("git", cwd, `ls-remote --heads ${remote} ${branch}`);
  return r.ok && r.stdout.length > 0;
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
Write a professional, detailed PR description in English ONLY.

CONSTRAINTS — these matter for upstream CI (spell-check / linting):
- Use ONLY common English words. No Spanish, no Portuguese, no other-language words.
- Do not include absolute file paths. Use repo-relative paths only.
- Do not invent project names, vendor names, or organization names.
- When you reference a tool / acronym (CWE, GCC, RAII, AES, etc.), put it in
  inline backticks (e.g. \`CWE-22\`) so spell-checkers skip the token.
- Do not use the word "kcode", "Astrolexis", or "Kulvex" in the body. The
  attribution footer is added programmatically and is the only branded text.
- Pattern IDs (like \`fsw-010\`, \`crypto-001\`) must always be in inline backticks.
- Avoid coined words like "overreads"; prefer "out-of-bounds reads".

PROJECT: ${basename(result.project)}
FILES SCANNED: ${result.files_scanned}
CONFIRMED FINDINGS: ${result.confirmed_findings}
FALSE POSITIVES: ${result.false_positives}

FINDINGS:
${findingsSummary}

FIXES APPLIED:
${fixesSummary}

Write the PR in this EXACT format:

## Security and code-quality audit

**Findings:** N confirmed (N false positives filtered)
**Scan time:** Ns

### Summary
[2-3 sentences explaining what was found and fixed.]

### Findings and fixes

[For EACH finding, write a subsection with:]
#### N. [SEVERITY] Title — file:line
**Bug:** [1-2 sentences explaining the root cause.]
**Impact:** [What could go wrong — be specific about exploitation.]
**Fix:** [What the patch does.]

### Methodology
[One paragraph: deterministic pattern library scans for known-dangerous patterns,
then a model-based verifier rules out false positives. Mention only common
English terms, no vendor names.]

### Testing
- [ ] Compilation verified (\`cmake\` and \`make\` — clean build)
- [ ] No regressions in existing functionality
- [ ] Fixes address \`CWE\` references where applicable
`;
}

/**
 * Strip / wrap content that fails upstream CI spell-check / linters:
 *
 *   - Absolute local paths (e.g. /home/<user>/proyectos/...) → repo-relative.
 *     Catches the v318 leak where the LLM hallucinated "proyectos" into the
 *     body even though it wasn't in the prompt.
 *   - Brand / vendor / project codename terms wrapped in inline code so
 *     spell-check skips them. Specific terms come from KCODE_PR_BRAND_TERMS
 *     (env override) and a short built-in list.
 *   - A neutral programmatic footer is appended at the end so the auditor
 *     attribution survives even if the LLM dropped it from the body.
 */
function sanitizePrBody(body: string, projectRoot: string): string {
  let out = body;

  // 1. Strip the local project path so anything downstream sees only the
  //    repo-relative form. Both the resolved path and any common parent
  //    leak (e.g. "/home/<user>/proyectos/<repo>/Svc/..." → "Svc/...").
  const projectAbs = projectRoot.replace(/\/+$/, "");
  if (projectAbs) {
    out = out.split(projectAbs + "/").join("");
    out = out.split(projectAbs).join("");
  }
  // Defensive: drop any other absolute path that escaped the LLM, replacing
  // it with the trailing path component only.
  out = out.replace(
    /\/(?:home|Users|var|opt|tmp)\/[\w./-]+\/([\w./-]+)/g,
    "$1",
  );

  // 2. Wrap brand / project-codename terms in inline code so spell-check
  //    skips them. The built-in list covers Astrolexis-org branding; users
  //    can extend via KCODE_PR_BRAND_TERMS=Foo,Bar.
  const builtin = ["KCode", "kcode", "Astrolexis", "Kulvex"];
  const extra = (process.env.KCODE_PR_BRAND_TERMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const term of [...builtin, ...extra]) {
    // Only wrap when not ALREADY in inline code. Cheap heuristic: skip the
    // term if it already appears between backticks on the same line.
    const re = new RegExp(`(?<!\`)\\b${term}\\b(?!\`)`, "g");
    out = out.replace(re, `\`${term}\``);
  }

  // 3. Replace coined English words that some upstream spell-checkers
  //    flag (e.g. "overreads" — flagged by NASA's check-spelling).
  out = out.replace(/\boverreads?\b/gi, "out-of-bounds reads");

  // 4. Trim + ensure neutral, spell-check-safe footer.
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  const footer = "\n\n---\n_Generated by `KCode` automated audit engine — `Astrolexis.space`._";
  // Avoid double-footer when the LLM already produced one matching ours.
  if (!out.includes("Generated by")) out += footer;
  return out;
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
  // Use timestamp with hour+minute for unique branch names across runs
  const now = new Date();
  const ts = now.toISOString().replace(/[T:]/g, "-").slice(0, 16); // 2026-04-06-21-45
  let branchName = opts.branchName ?? `fix/kcode-audit-${ts}`;

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

  // Check for uncommitted changes (our fixes). Two shapes are valid:
  //   (A) dirty tree with /fix-applied changes → normal first-run flow
  //   (B) clean tree but currently on a fix/kcode-audit-* branch with
  //       a recent commit → previous /pr run committed but couldn't
  //       push, resume from push step.
  const status = git(projectRoot, "status --porcelain");
  let resumeMode = false;
  if (!status) {
    const currentBranch = git(projectRoot, "branch --show-current");
    if (/^fix\/kcode-audit-/.test(currentBranch)) {
      resumeMode = true;
      // Use the branch we're already on instead of generating a new one,
      // so the existing commit + (maybe) existing remote ref keep working.
      branchName = currentBranch;
    } else {
      throw new Error("No changes to commit. Run `/fix` first to apply patches.");
    }
  }

  const changedFiles = resumeMode
    ? (() => {
        // Resume-mode: count commits on the fix branch that aren't on the
        // repository's default integration branch. Use `<base>..HEAD` form
        // (commits in HEAD not in base) instead of the brittle `--not main^`
        // shorthand that assumed `main` exists.
        const base = defaultBranch(projectRoot);
        try {
          return Number.parseInt(
            git(projectRoot, `rev-list --count ${base}..HEAD`).trim() || "0",
            10,
          ) || 0;
        } catch {
          return 0; // base branch missing locally — show 0 rather than crash
        }
      })()
    : status.split("\n").filter((l) => l.trim()).length;

  // Get the diff summary for the LLM
  const diffStat = git(projectRoot, "diff --stat");
  const fixes = diffStat.split("\n").filter((l) => l.includes("|")).map((l) => l.trim());

  // Generate PR description via LLM, then sanitize before submission.
  const rawDescription = await llmCallback(buildPrPrompt(auditResult, fixes));
  const prDescription = sanitizePrBody(rawDescription, projectRoot);

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
    if (resumeMode) {
      step("Resume mode: branch + commit already present, skipping to push...");
      // Capture the existing HEAD as the commit hash.
      try {
        commitHash = git(projectRoot, "rev-parse --short HEAD");
      } catch { /* ignore */ }
    } else {
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
      const msgFile = resolve(projectRoot, ".kcode-commit-msg");
      writeFileSync(msgFile, commitMsg);
      try {
        commitHash = git(projectRoot, `commit -F ${msgFile}`);
        const hashMatch = commitHash.match(/\[[\w/]+ ([a-f0-9]+)\]/);
        commitHash = hashMatch ? hashMatch[1]! : "";
      } finally {
        try { unlinkSync(msgFile); } catch { /* ignore */ }
      }
    }

    // Push strategy: try origin → if 403, fork → push to fork → PR from fork
    const upstreamRepo = opts.repo ?? detectRemoteRepo(projectRoot);
    let pushedToFork = false;
    let forkUser = "";

    // Resolve forkUser early so we can short-circuit when the branch
    // is already pushed to the user's fork.
    const userQ = runCapturing("gh", projectRoot, "api user --jq .login");
    if (userQ.ok) forkUser = userQ.stdout;

    // Resume / idempotent path: if the branch is already on the user's
    // fork, skip the push step entirely. This handles the case where a
    // previous /pr run pushed but failed to create the PR (e.g. transient
    // gh CLI error), or where the user manually pushed after a previous
    // /pr run reported "Push failed".
    if (forkUser) {
      const exists = remoteBranchExists(projectRoot, "fork", branchName);
      if (exists) {
        step("Branch already on fork. Skipping push.");
        pushedToFork = true;
      }
    }

    if (!pushedToFork) {
      step("Pushing to origin...");
      const originPush = runCapturing(
        "git",
        projectRoot,
        `push -u origin ${branchName}`,
      );
      if (!originPush.ok) {
        // Origin push failed (likely 403 — no write access). Try fork workflow.
        if (upstreamRepo) {
          if (!forkUser) {
            pushError = "GitHub not authenticated. Run /github login first.";
          } else {
            const repoName = upstreamRepo.split("/")[1] ?? "";

            // Fork the repo (or confirm it exists). gh's "already exists"
            // failure is non-fatal — we just want the fork to exist.
            step(`Forking ${upstreamRepo}...`);
            runCapturing("gh", projectRoot, `repo fork ${upstreamRepo} --clone=false`);

            // Always ensure the "fork" remote points to our fork.
            step("Configuring fork remote...");
            runCapturing("git", projectRoot, `remote remove fork`);
            const addRemote = runCapturing(
              "git",
              projectRoot,
              `remote add fork https://github.com/${forkUser}/${repoName}.git`,
            );
            if (!addRemote.ok) {
              pushError = `Could not configure fork remote: ${addRemote.stderr}`;
            }
          }

          if (!pushError) {
            step("Pushing to fork...");
            // Two attempts with a brief pause between — when gh just
            // forked the repo, GitHub takes a few seconds to fully
            // provision push access. The first push commonly hits 404
            // and a 5s retry succeeds.
            let lastStderr = "";
            for (let attempt = 0; attempt < 2; attempt++) {
              if (attempt > 0) {
                step("Waiting for fork to provision (retry)...");
                await new Promise((r) => setTimeout(r, 5000));
              }
              const r = runCapturing(
                "git",
                projectRoot,
                `push -u fork ${branchName} --force`,
              );
              if (r.ok) {
                pushedToFork = true;
                break;
              }
              lastStderr = r.stderr || r.stdout;
            }
            if (!pushedToFork) {
              const lower = lastStderr.toLowerCase();
              if (lower.includes("403") || lower.includes("permission denied")) {
                pushError = `Permission denied pushing to fork: ${lastStderr.slice(0, 240)}`;
              } else if (lower.includes("404") || lower.includes("not found")) {
                pushError = `Fork not yet provisioned by GitHub. Wait ~30s and re-run /pr. (${lastStderr.slice(0, 200)})`;
              } else {
                pushError = `Push to fork failed: ${lastStderr.slice(0, 240)}`;
              }
            }
          }
        } else {
          pushError = "No write access and no upstream repo detected";
        }
      }
    }

    // Create PR
    if (!pushError && upstreamRepo) {
      step("Creating PR...");
      const bodyFile = resolve(projectRoot, ".kcode-pr-body");
      writeFileSync(bodyFile, prDescription);
      // Detect existing PR for this branch first — if one is already
      // open we can't create a duplicate.
      const head = pushedToFork && forkUser ? `${forkUser}:${branchName}` : branchName;
      const existingPr = runCapturing(
        "gh",
        projectRoot,
        `pr list --repo ${upstreamRepo} --head ${head} --state open --json url --jq ".[0].url"`,
      );
      if (existingPr.ok && existingPr.stdout && existingPr.stdout !== "null") {
        prUrl = existingPr.stdout;
      } else {
        const create = runCapturing(
          "gh",
          projectRoot,
          pushedToFork && forkUser
            ? `pr create --title "${prTitle}" --body-file ${bodyFile} --repo ${upstreamRepo} --head ${forkUser}:${branchName}`
            : `pr create --title "${prTitle}" --body-file ${bodyFile} --repo ${upstreamRepo}`,
        );
        if (create.ok) {
          prUrl = create.stdout;
        } else {
          // Surface the real reason instead of swallowing.
          pushError = `gh pr create failed: ${(create.stderr || create.stdout).slice(0, 240)}`;
        }
      }
      try { unlinkSync(bodyFile); } catch { /* ignore */ }

      // After the PR exists, add an attribution comment. PR comments are
      // not in scope of upstream spell-check / lint workflows, so this is
      // where KCode and Astrolexis can be named without escaping. Soft-fail:
      // a comment that doesn't post is non-fatal; the PR itself still works.
      if (prUrl) {
        const commentBody =
          `🛡️ **This audit was conducted by [KCode](https://astrolexis.space) — an automated security and code-quality audit engine by Astrolexis.**\n\n` +
          `KCode performed a deterministic pattern scan against the codebase, then ran a model-based verifier with a mitigation checklist over each candidate. The Pull Request body above is auto-generated from the verified findings.\n\n` +
          `Pattern coverage and verification details: [astrolexis.space/kcode](https://astrolexis.space).`;
        const commentFile = resolve(projectRoot, ".kcode-pr-comment");
        try {
          writeFileSync(commentFile, commentBody);
          runCapturing(
            "gh",
            projectRoot,
            `pr comment ${prUrl} --body-file ${commentFile}`,
          );
        } catch { /* non-fatal */ }
        finally { try { unlinkSync(commentFile); } catch { /* ignore */ } }
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
