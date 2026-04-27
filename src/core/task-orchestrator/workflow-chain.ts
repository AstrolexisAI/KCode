// KCode - Workflow Chain Engine
//
// Chains multiple engines together automatically based on user intent.
// "audit and fix this" → scan → fix → build → pr
// "add endpoint with tests" → implement → lint → test → fix if fail
//
// Each step feeds into the next. If a step fails, the chain can
// auto-recover (e.g., test fails → debug engine → fix → re-test).

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function run(cmd: string, cwd: string, timeout = 30_000): { output: string; code: number } {
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { output, code: 0 };
  } catch (err: any) {
    return {
      output: err.stdout?.toString().trim() ?? err.stderr?.toString().trim() ?? err.message,
      code: err.status ?? 1,
    };
  }
}

// ── Chain Step Types ───────────────────────────────────────────

export interface ChainStep {
  name: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  output?: string;
  durationMs?: number;
}

export interface ChainResult {
  steps: ChainStep[];
  success: boolean;
  totalMs: number;
}

export type ChainProgressCallback = (step: ChainStep, index: number, total: number) => void;

// ── Chain Definitions ──────────────────────────────────────────

export type WorkflowType =
  | "audit-full" // scan → fix → build → pr
  | "implement-full" // implement → lint → test → fix-if-fail
  | "fix-verify" // debug → fix → test → verify
  | "refactor-safe" // refactor → test → verify no regression
  | "review-full" // lint → test → review
  | "custom";

interface ChainConfig {
  type: WorkflowType;
  steps: Array<{
    name: string;
    run: (
      cwd: string,
      context: Map<string, string>,
    ) => Promise<{ output: string; success: boolean }>;
    /** If true, failure stops the chain */
    critical?: boolean;
    /** If true, only run if previous step succeeded */
    onlyIfPrevSuccess?: boolean;
  }>;
}

// ── Step Implementations ───────────────────────────────────────

async function stepScan(
  cwd: string,
  ctx: Map<string, string>,
): Promise<{ output: string; success: boolean }> {
  const { runAudit } = await import("../audit-engine/audit-engine");
  const { generateMarkdownReport } = await import("../audit-engine/report-generator");

  const result = await runAudit({
    projectRoot: cwd,
    llmCallback: async () =>
      JSON.stringify({
        verdict: "confirmed",
        reasoning: "static-only",
        evidence: { sink: "static-only bypass" },
      }),
    skipVerification: true,
  });

  writeFileSync(join(cwd, "AUDIT_REPORT.md"), generateMarkdownReport(result));
  writeFileSync(join(cwd, "AUDIT_REPORT.json"), JSON.stringify(result, null, 2));

  ctx.set("scan_findings", String(result.candidates_found));
  return {
    output: `${result.candidates_found} candidates found in ${result.files_scanned} files`,
    success: true,
  };
}

async function stepFix(
  cwd: string,
  ctx: Map<string, string>,
): Promise<{ output: string; success: boolean }> {
  const jsonPath = join(cwd, "AUDIT_REPORT.json");
  if (!existsSync(jsonPath))
    return { output: "No AUDIT_REPORT.json — run scan first", success: false };

  const { applyFixes } = await import("../audit-engine/fixer");
  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));

  // v304: the report just written by stepScan used skipVerification:true,
  // so every finding has a synthetic 'CONFIRMED' verdict from the
  // hard-coded llmCallback rather than a real model review. Passing
  // that directly to applyFixes() violates the fixer's 'confirmed
  // findings only' contract and can patch regex false positives into
  // user code. Filter to findings that have been independently
  // confirmed by a real verifier, or bail out with a clear message.
  const realConfirmed = (data.findings ?? []).filter(
    (f: { verification?: { verdict?: string; reasoning?: string } }) =>
      f.verification?.verdict === "confirmed" && f.verification.reasoning !== "static-only",
  );
  if (realConfirmed.length === 0) {
    return {
      output:
        `Skipped: ${data.findings?.length ?? 0} candidate(s) but none are model-verified. ` +
        `Workflow uses skip-verification for speed; to apply fixes, re-run scan without ` +
        `skip-verify and then /fix manually.`,
      success: true,
    };
  }
  const filteredData = { ...data, findings: realConfirmed };
  const fixes = applyFixes(filteredData);
  const transformed = fixes.filter((f) => f.kind === "transformed").length;
  const annotated = fixes.filter((f) => f.kind === "annotated").length;
  const skipped = fixes.filter((f) => f.kind === "skipped").length;

  // Only "transformed" counts as a real fix. Annotations are advisory
  // TODOs that still need manual attention, so don't claim them as done.
  ctx.set("fixes_applied", String(transformed));
  ctx.set("fixes_annotated", String(annotated));
  return {
    output: `${transformed} real fixes, ${annotated} advisory comments, ${skipped} skipped`,
    success: transformed > 0 || (annotated === 0 && skipped === 0),
  };
}

async function stepBuild(
  cwd: string,
  _ctx: Map<string, string>,
): Promise<{ output: string; success: boolean }> {
  const { tryLevel1 } = await import("./level1-handlers");
  const result = tryLevel1("build", cwd);
  if (!result.handled) return { output: "No build system detected", success: true };
  const success = result.output.includes("✅");
  return { output: result.output.slice(0, 500), success };
}

async function stepTest(
  cwd: string,
  _ctx: Map<string, string>,
): Promise<{ output: string; success: boolean }> {
  const { tryLevel1 } = await import("./level1-handlers");
  const result = tryLevel1("test", cwd);
  if (!result.handled) return { output: "No test runner detected", success: true };
  const success = result.output.includes("✅");
  return { output: result.output.slice(0, 500), success };
}

async function stepLint(
  cwd: string,
  _ctx: Map<string, string>,
): Promise<{ output: string; success: boolean }> {
  const { tryLevel1 } = await import("./level1-handlers");
  const result = tryLevel1("lint", cwd);
  if (!result.handled) return { output: "No linter detected", success: true };
  const success = result.output.includes("✅");
  return { output: result.output.slice(0, 500), success };
}

async function stepCommit(
  cwd: string,
  ctx: Map<string, string>,
): Promise<{ output: string; success: boolean }> {
  const findings = ctx.get("scan_findings") ?? "0";
  const fixes = ctx.get("fixes_applied") ?? "0";
  const msg = `fix: address ${findings} findings (${fixes} auto-fixed)\\n\\nAstrolexis.space -- Kulvex Code`;

  const status = run("git status --porcelain", cwd);
  if (!status.output) return { output: "Nothing to commit", success: true };

  run("git add -A", cwd);
  const result = run(`git commit -m "${msg}"`, cwd);
  return { output: result.output.slice(0, 200), success: result.code === 0 };
}

// ── Chain Configurations ───────────────────────────────────────

const CHAINS: Record<WorkflowType, ChainConfig> = {
  "audit-full": {
    type: "audit-full",
    steps: [
      { name: "Scan", run: stepScan },
      { name: "Fix", run: stepFix },
      { name: "Build", run: stepBuild },
      { name: "Commit", run: stepCommit, onlyIfPrevSuccess: true },
    ],
  },
  "implement-full": {
    type: "implement-full",
    steps: [
      { name: "Lint", run: stepLint },
      { name: "Test", run: stepTest },
    ],
  },
  "fix-verify": {
    type: "fix-verify",
    steps: [{ name: "Test", run: stepTest }],
  },
  "refactor-safe": {
    type: "refactor-safe",
    steps: [
      { name: "Test (before)", run: stepTest, critical: true },
      { name: "Lint", run: stepLint },
      { name: "Test (after)", run: stepTest, critical: true },
    ],
  },
  "review-full": {
    type: "review-full",
    steps: [
      { name: "Lint", run: stepLint },
      { name: "Test", run: stepTest },
    ],
  },
  custom: {
    type: "custom",
    steps: [],
  },
};

// ── Chain Detection ────────────────────────────────────────────

export function detectChain(message: string): WorkflowType | null {
  const lower = message.toLowerCase();

  // "audit and fix" / "scan, fix and pr" / "auditalo y corrige"
  if (/\b(?:audit|scan|auditalo)\b.*\b(?:fix|corrige|arregla|pr|pull)/i.test(lower)) {
    return "audit-full";
  }

  // "add X with tests" / "create X and test it"
  if (
    /\b(?:add|create|implement|crea|agrega)\b.*\b(?:with tests|and test|con tests|y pruebas)/i.test(
      lower,
    )
  ) {
    return "implement-full";
  }

  // "fix X and verify" / "arregla y verifica"
  if (/\b(?:fix|arregla|corrige)\b.*\b(?:verify|verifica|and test|y prueba)/i.test(lower)) {
    return "fix-verify";
  }

  // "refactor X safely" / "refactoriza sin romper"
  if (
    /\b(?:refactor|refactoriza)\b.*\b(?:safe|sin romper|without breaking|and test)/i.test(lower)
  ) {
    return "refactor-safe";
  }

  return null;
}

// ── Chain Executor ─────────────────────────────────────────────

export async function executeChain(
  type: WorkflowType,
  cwd: string,
  onProgress?: ChainProgressCallback,
): Promise<ChainResult> {
  const config = CHAINS[type];
  if (!config) return { steps: [], success: false, totalMs: 0 };

  const t0 = Date.now();
  const context = new Map<string, string>();
  const steps: ChainStep[] = config.steps.map((s) => ({
    name: s.name,
    status: "pending" as const,
  }));

  let lastSuccess = true;

  for (let i = 0; i < config.steps.length; i++) {
    const stepDef = config.steps[i]!;
    const step = steps[i]!;

    // Skip if depends on previous success
    if (stepDef.onlyIfPrevSuccess && !lastSuccess) {
      step.status = "skipped";
      step.output = "Skipped (previous step failed)";
      onProgress?.(step, i, steps.length);
      continue;
    }

    step.status = "running";
    onProgress?.(step, i, steps.length);

    const stepT0 = Date.now();
    try {
      const result = await stepDef.run(cwd, context);
      step.status = result.success ? "done" : "failed";
      step.output = result.output;
      lastSuccess = result.success;
    } catch (err) {
      step.status = "failed";
      step.output = err instanceof Error ? err.message : String(err);
      lastSuccess = false;
    }
    step.durationMs = Date.now() - stepT0;
    onProgress?.(step, i, steps.length);

    // Critical failure stops the chain
    if (stepDef.critical && !lastSuccess) break;
  }

  return {
    steps,
    success: steps.every((s) => s.status === "done" || s.status === "skipped"),
    totalMs: Date.now() - t0,
  };
}
