import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { registerUpdateCommand } from "./update";

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
    const checkOpt = cmd.options.find((o) => o.long === "--check");
    expect(checkOpt).toBeDefined();
  });

  test("supports --force option", () => {
    const program = new Command();
    registerUpdateCommand(program, "1.8.0");
    const cmd = program.commands.find((c) => c.name() === "update")!;
    const forceOpt = cmd.options.find((o) => o.long === "--force");
    expect(forceOpt).toBeDefined();
  });

  test("supports --yes option as alias for --force", () => {
    const program = new Command();
    registerUpdateCommand(program, "1.8.0");
    const cmd = program.commands.find((c) => c.name() === "update")!;
    const yesOpt = cmd.options.find((o) => o.long === "--yes");
    expect(yesOpt).toBeDefined();
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
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  });

  test("--check with no update shows up-to-date message", async () => {
    const mockRelease = {
      tag_name: "v1.8.0",
      body: "",
      published_at: "2026-03-15T12:00:00Z",
      assets: [],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockRelease), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const program = new Command();
    program.exitOverride();
    registerUpdateCommand(program, "1.8.0");

    await program.parseAsync(["node", "kcode", "update", "--check"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("up to date");
  });

  test("--check with update available shows version info", async () => {
    const mockRelease = {
      tag_name: "v2.0.0",
      body: "## New\n- Feature A",
      published_at: "2026-04-01T12:00:00Z",
      assets: [],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockRelease), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const program = new Command();
    program.exitOverride();
    registerUpdateCommand(program, "1.8.0");

    await program.parseAsync(["node", "kcode", "update", "--check"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("2.0.0");
    expect(output).toContain("kcode update");
  });

  test("shows changelog when release notes exist", async () => {
    const mockRelease = {
      tag_name: "v2.0.0",
      body: "## Changelog\n- Added widgets\n- Fixed bugs",
      published_at: "2026-04-01T12:00:00Z",
      assets: [],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockRelease), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const program = new Command();
    program.exitOverride();
    registerUpdateCommand(program, "1.8.0");

    await program.parseAsync(["node", "kcode", "update", "--check"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("Changelog");
    expect(output).toContain("Added widgets");
  });

  test("shows published date when available", async () => {
    const mockRelease = {
      tag_name: "v2.0.0",
      body: "",
      published_at: "2026-04-01T12:00:00Z",
      assets: [],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockRelease), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const program = new Command();
    program.exitOverride();
    registerUpdateCommand(program, "1.8.0");

    await program.parseAsync(["node", "kcode", "update", "--check"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("2026-04-01");
  });
});

// ─── Export shape ───────────────────────────────────────────────

describe("module exports", () => {
  test("exports registerUpdateCommand as a function", async () => {
    const mod = await import("./update");
    expect(typeof mod.registerUpdateCommand).toBe("function");
  });
});
