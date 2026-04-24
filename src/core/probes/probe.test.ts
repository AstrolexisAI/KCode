import { beforeEach, describe, expect, test } from "bun:test";
import { getTaskScopeManager } from "../task-scope";
import { listProbes, resolveApplicableProbe } from "./registry";
import {
  computeEvidenceTier,
  tierAllowsClaim,
  type EvidenceTier,
} from "./types";

describe("probe registry (v298)", () => {
  beforeEach(() => getTaskScopeManager().reset());

  test("bitcoin-rpc probe is registered", () => {
    const probes = listProbes();
    expect(probes.some((p) => p.id === "bitcoin-rpc-getblockcount")).toBe(true);
  });

  test("bitcoin-rpc probe applies when scope has bitcoin-core imports", async () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "bitcoin tui" });
    // Write a fake file with bitcoin-core content that the probe's
    // file-reader will pick up.
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "kcode-probe-test-"));
    const filePath = join(tmp, "index.ts");
    writeFileSync(
      filePath,
      `import { Client } from 'bitcoin-core';\nconst c = new Client({ host: 'localhost' });\nawait c.getBlockCount();`,
    );
    mgr.recordMutation({ tool: "Write", path: filePath, at: Date.now() });

    const probe = await resolveApplicableProbe(mgr.current()!);
    expect(probe).not.toBeNull();
    expect(probe?.id).toBe("bitcoin-rpc-getblockcount");
  });

  test("bitcoin-rpc probe does NOT apply when no RPC pattern in files", async () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "web app" });
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "kcode-probe-test-"));
    const filePath = join(tmp, "app.ts");
    writeFileSync(
      filePath,
      `import express from 'express';\nconst app = express();\napp.listen(3000);`,
    );
    mgr.recordMutation({ tool: "Write", path: filePath, at: Date.now() });

    const probe = await resolveApplicableProbe(mgr.current()!);
    expect(probe).toBeNull();
  });
});

describe("evidence tiers", () => {
  beforeEach(() => getTaskScopeManager().reset());

  test("tier 0 when no artifacts or runtime", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    expect(computeEvidenceTier(mgr.current()!)).toBe(0);
  });

  test("tier 1 when files written but no runtime", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordMutation({ tool: "Write", path: "/proj/index.ts", at: Date.now() });
    expect(computeEvidenceTier(mgr.current()!)).toBe(1);
  });

  test("tier 2 when runtime=verified (spawn) but no probe", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordMutation({ tool: "Write", path: "/proj/index.ts", at: Date.now() });
    mgr.recordRuntimeCommand({
      command: "bun run index.ts",
      exitCode: 0,
      output: "running",
      runtimeFailed: false,
      status: "verified",
      timestamp: Date.now(),
    });
    expect(computeEvidenceTier(mgr.current()!)).toBe(2);
  });

  test("tier 3 when functional probe passed", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordMutation({ tool: "Write", path: "/proj/index.ts", at: Date.now() });
    mgr.update({
      verification: {
        lastProbeResult: {
          status: "pass",
          probeId: "bitcoin-rpc-getblockcount",
          evidence: "getblockcount returned 820000",
          tier: 3,
        },
      },
    });
    expect(computeEvidenceTier(mgr.current()!)).toBe(3);
  });

  test("tier 2 when probe failed (runtime still counts for tier)", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "scaffold", userPrompt: "test" });
    mgr.recordRuntimeCommand({
      command: "bun run index.ts",
      exitCode: 0,
      output: "running",
      runtimeFailed: false,
      status: "verified",
      timestamp: Date.now(),
    });
    mgr.update({
      verification: {
        lastProbeResult: {
          status: "fail_auth",
          probeId: "bitcoin-rpc-getblockcount",
          error: "401",
        },
      },
    });
    // Runtime said verified (tier 2) but probe failed — tier stays 2, not 3.
    expect(computeEvidenceTier(mgr.current()!)).toBe(2);
  });
});

describe("tierAllowsClaim", () => {
  test("tier 0 allows none", () => {
    const tier: EvidenceTier = 0;
    expect(tierAllowsClaim(tier, "implemented")).toBe(false);
    expect(tierAllowsClaim(tier, "running")).toBe(false);
    expect(tierAllowsClaim(tier, "verified")).toBe(false);
    expect(tierAllowsClaim(tier, "complete")).toBe(false);
  });

  test("tier 1 allows 'implemented' only", () => {
    const tier: EvidenceTier = 1;
    expect(tierAllowsClaim(tier, "implemented")).toBe(true);
    expect(tierAllowsClaim(tier, "running")).toBe(false);
    expect(tierAllowsClaim(tier, "verified")).toBe(false);
  });

  test("tier 2 allows 'implemented' and 'running'", () => {
    const tier: EvidenceTier = 2;
    expect(tierAllowsClaim(tier, "running")).toBe(true);
    expect(tierAllowsClaim(tier, "verified")).toBe(false);
  });

  test("tier 3 allows 'verified' / 'ready' / 'works'", () => {
    const tier: EvidenceTier = 3;
    expect(tierAllowsClaim(tier, "verified")).toBe(true);
    expect(tierAllowsClaim(tier, "ready")).toBe(true);
    expect(tierAllowsClaim(tier, "works")).toBe(true);
    expect(tierAllowsClaim(tier, "complete")).toBe(false);
  });

  test("tier 4 allows everything including 'complete'", () => {
    const tier: EvidenceTier = 4;
    expect(tierAllowsClaim(tier, "complete")).toBe(true);
  });
});
