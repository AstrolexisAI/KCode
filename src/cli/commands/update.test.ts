import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { registerUpdateCommand } from "./update";


const asFetch = (fn: unknown): typeof globalThis.fetch => fn as typeof globalThis.fetch;

function buildManifest(latest: string) {
  return {
    schema_version: 1,
    latest,
    released_at: "2026-04-01T12:00:00Z",
    channels: { stable: latest },
    platforms: {
      "linux-x64": {
        url: `https://kulvex.ai/downloads/kcode/kcode-${latest}-linux-x64`,
        filename: `kcode-${latest}-linux-x64`,
        sha256: "a".repeat(64),
        size: 117_000_000,
      },
      "linux-arm64": {
        url: `https://kulvex.ai/downloads/kcode/kcode-${latest}-linux-arm64`,
        filename: `kcode-${latest}-linux-arm64`,
        sha256: "b".repeat(64),
        size: 117_000_000,
      },
      "darwin-x64": {
        url: `https://kulvex.ai/downloads/kcode/kcode-${latest}-darwin-x64`,
        filename: `kcode-${latest}-darwin-x64`,
        sha256: "c".repeat(64),
        size: 117_000_000,
      },
      "darwin-arm64": {
        url: `https://kulvex.ai/downloads/kcode/kcode-${latest}-darwin-arm64`,
        filename: `kcode-${latest}-darwin-arm64`,
        sha256: "d".repeat(64),
        size: 117_000_000,
      },
    },
    release_notes: `https://github.com/AstrolexisAI/KCode/releases/tag/v${latest}`,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── registerUpdateCommand tests ────────────────────────────────

describe("registerUpdateCommand", () => {
  test("registers 'update' subcommand on program", () => {
    const program = new Command();
    registerUpdateCommand(program, "1.8.0");
    const cmd = program.commands.find((c) => c.name() === "update");
    expect(cmd).toBeDefined();
  });

  test("has correct description", () => {
    const program = new Command();
    registerUpdateCommand(program, "1.8.0");
    const cmd = program.commands.find((c) => c.name() === "update")!;
    expect(cmd.description()).toContain("update");
  });

  test("supports --check option", () => {
    const program = new Command();
    registerUpdateCommand(program, "1.8.0");
    const cmd = program.commands.find((c) => c.name() === "update")!;
    expect(cmd.options.find((o) => o.long === "--check")).toBeDefined();
  });

  test("supports --force option", () => {
    const program = new Command();
    registerUpdateCommand(program, "1.8.0");
    const cmd = program.commands.find((c) => c.name() === "update")!;
    expect(cmd.options.find((o) => o.long === "--force")).toBeDefined();
  });

  test("supports --yes option as alias for --force", () => {
    const program = new Command();
    registerUpdateCommand(program, "1.8.0");
    const cmd = program.commands.find((c) => c.name() === "update")!;
    expect(cmd.options.find((o) => o.long === "--yes")).toBeDefined();
  });

  test("supports --beta option", () => {
    const program = new Command();
    registerUpdateCommand(program, "1.8.0");
    const cmd = program.commands.find((c) => c.name() === "update")!;
    expect(cmd.options.find((o) => o.long === "--beta")).toBeDefined();
  });

  test("supports --rollback option", () => {
    const program = new Command();
    registerUpdateCommand(program, "1.8.0");
    const cmd = program.commands.find((c) => c.name() === "update")!;
    expect(cmd.options.find((o) => o.long === "--rollback")).toBeDefined();
  });
});

// ─── CLI output tests (mocked fetch) ───────────────────────────

describe("update command output", () => {
  const originalFetch = globalThis.fetch;
  let consoleLogs: string[];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    consoleLogs = [];
    console.log = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    globalThis.fetch = asFetch(originalFetch);
    console.log = originalLog;
    console.error = originalError;
  });

  test("--check with no update shows up-to-date message", async () => {
    globalThis.fetch = asFetch(mock(() => Promise.resolve(jsonResponse(buildManifest("1.8.0")))));

    const program = new Command();
    program.exitOverride();
    registerUpdateCommand(program, "1.8.0");

    await program.parseAsync(["node", "kcode", "update", "--check"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("up to date");
  });

  test("--check with update available shows version info", async () => {
    globalThis.fetch = asFetch(mock(() => Promise.resolve(jsonResponse(buildManifest("2.0.0")))));

    const program = new Command();
    program.exitOverride();
    registerUpdateCommand(program, "1.8.0");

    await program.parseAsync(["node", "kcode", "update", "--check"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("2.0.0");
    expect(output).toContain("kcode update");
  });

  test("shows release notes URL when available", async () => {
    globalThis.fetch = asFetch(mock(() => Promise.resolve(jsonResponse(buildManifest("2.0.0")))));

    const program = new Command();
    program.exitOverride();
    registerUpdateCommand(program, "1.8.0");

    await program.parseAsync(["node", "kcode", "update", "--check"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("Release notes:");
    expect(output).toContain("github.com/AstrolexisAI/KCode/releases/tag/v2.0.0");
  });

  test("shows published date when available", async () => {
    globalThis.fetch = asFetch(mock(() => Promise.resolve(jsonResponse(buildManifest("2.0.0")))));

    const program = new Command();
    program.exitOverride();
    registerUpdateCommand(program, "1.8.0");

    await program.parseAsync(["node", "kcode", "update", "--check"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("2026-04-01");
  });

  test("--rollback with no previous binary shows nothing-to-rollback message", async () => {
    // Force an empty KCODE_HOME so the rollback check finds no previous binary.
    const tempHome = await Bun.write(`/tmp/kcode-update-cli-test-${Date.now()}/.placeholder`, "x");
    process.env.KCODE_HOME = `/tmp/kcode-update-cli-test-${Date.now()}`;

    const program = new Command();
    program.exitOverride();
    registerUpdateCommand(program, "1.8.0");

    await program.parseAsync(["node", "kcode", "update", "--rollback"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("nothing to roll back");

    // tempHome unused after creation — referenced to keep TS happy.
    void tempHome;
  });
});

// ─── Export shape ───────────────────────────────────────────────

describe("module exports", () => {
  test("exports registerUpdateCommand as a function", async () => {
    const mod = await import("./update");
    expect(typeof mod.registerUpdateCommand).toBe("function");
  });
});
