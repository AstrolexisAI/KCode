// Tests for update-notifier — the startup nag.
//
// These exercise the suppression rules (TTY, --ci/--quiet/--print,
// suppressed subcommands, KCODE_QUIET, autoUpdate=false) and the cache
// behavior (only prints when an update is genuinely available).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const asFetch = (fn: unknown): typeof globalThis.fetch => fn as typeof globalThis.fetch;

function mockManifest(latest: string) {
  return {
    schema_version: 1,
    latest,
    released_at: "2026-04-26T12:00:00Z",
    channels: { stable: latest },
    platforms: {
      "linux-x64": {
        url: `https://kulvex.ai/downloads/kcode/kcode-${latest}-linux-x64`,
        filename: `kcode-${latest}-linux-x64`,
        sha256: "a".repeat(64),
        size: 117_000_000,
      },
      "darwin-arm64": {
        url: `https://kulvex.ai/downloads/kcode/kcode-${latest}-darwin-arm64`,
        filename: `kcode-${latest}-darwin-arm64`,
        sha256: "b".repeat(64),
        size: 117_000_000,
      },
    },
    release_notes: `https://github.com/AstrolexisAI/KCode/releases/tag/v${latest}`,
  };
}

describe("maybeNotifyUpdate", () => {
  let originalHome: string | undefined;
  let originalArgv: string[];
  let originalIsTTY: boolean | undefined;
  let originalQuiet: string | undefined;
  let tempDir: string;
  let logs: string[];
  const originalLog = console.log;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-notifier-test-"));
    originalHome = process.env.KCODE_HOME;
    process.env.KCODE_HOME = tempDir;

    originalArgv = process.argv;
    originalIsTTY = process.stdout.isTTY;
    originalQuiet = process.env.KCODE_QUIET;

    // Pretend we have a TTY by default — tests that need non-TTY
    // override individually.
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    logs = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.KCODE_HOME = originalHome;
    } else {
      delete process.env.KCODE_HOME;
    }
    process.argv = originalArgv;
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
    if (originalQuiet !== undefined) {
      process.env.KCODE_QUIET = originalQuiet;
    } else {
      delete process.env.KCODE_QUIET;
    }
    console.log = originalLog;
    globalThis.fetch = asFetch(globalThis.fetch);
    await rm(tempDir, { recursive: true, force: true });
  });

  test("prints notice when update is available", async () => {
    process.argv = ["bun", "kcode"];
    const origFetch = globalThis.fetch;
    globalThis.fetch = asFetch(
      mock(() =>
        Promise.resolve(
          new Response(JSON.stringify(mockManifest("2.10.999")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    try {
      const { maybeNotifyUpdate } = await import("./update-notifier");
      await maybeNotifyUpdate("1.0.0");
      const out = logs.join("\n");
      expect(out).toContain("2.10.999");
      expect(out).toContain("kcode update");
    } finally {
      globalThis.fetch = asFetch(origFetch);
    }
  });

  test("stays silent when no update is available", async () => {
    process.argv = ["bun", "kcode"];
    const origFetch = globalThis.fetch;
    globalThis.fetch = asFetch(
      mock(() =>
        Promise.resolve(
          new Response(JSON.stringify(mockManifest("1.0.0")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    try {
      const { maybeNotifyUpdate } = await import("./update-notifier");
      await maybeNotifyUpdate("1.0.0");
      expect(logs.join("\n")).toBe("");
    } finally {
      globalThis.fetch = asFetch(origFetch);
    }
  });

  test("stays silent when running `kcode update`", async () => {
    process.argv = ["bun", "kcode", "update"];
    let fetched = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = asFetch(
      mock(() => {
        fetched = true;
        return Promise.resolve(
          new Response(JSON.stringify(mockManifest("2.10.999")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    try {
      const { maybeNotifyUpdate } = await import("./update-notifier");
      await maybeNotifyUpdate("1.0.0");
      expect(logs.join("\n")).toBe("");
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = asFetch(origFetch);
    }
  });

  test("stays silent on --version", async () => {
    process.argv = ["bun", "kcode", "--version"];
    const { maybeNotifyUpdate } = await import("./update-notifier");
    await maybeNotifyUpdate("1.0.0");
    expect(logs.join("\n")).toBe("");
  });

  test("stays silent on --ci anywhere in argv", async () => {
    process.argv = ["bun", "kcode", "audit", ".", "--ci"];
    const { maybeNotifyUpdate } = await import("./update-notifier");
    await maybeNotifyUpdate("1.0.0");
    expect(logs.join("\n")).toBe("");
  });

  test("stays silent on --quiet", async () => {
    process.argv = ["bun", "kcode", "--quiet"];
    const { maybeNotifyUpdate } = await import("./update-notifier");
    await maybeNotifyUpdate("1.0.0");
    expect(logs.join("\n")).toBe("");
  });

  test("stays silent on --print", async () => {
    process.argv = ["bun", "kcode", "--print"];
    const { maybeNotifyUpdate } = await import("./update-notifier");
    await maybeNotifyUpdate("1.0.0");
    expect(logs.join("\n")).toBe("");
  });

  test("stays silent when stdout is not a TTY", async () => {
    process.argv = ["bun", "kcode"];
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

    const { maybeNotifyUpdate } = await import("./update-notifier");
    await maybeNotifyUpdate("1.0.0");
    expect(logs.join("\n")).toBe("");
  });

  test("stays silent when KCODE_QUIET=1", async () => {
    process.argv = ["bun", "kcode"];
    process.env.KCODE_QUIET = "1";

    const { maybeNotifyUpdate } = await import("./update-notifier");
    await maybeNotifyUpdate("1.0.0");
    expect(logs.join("\n")).toBe("");
  });

  test("stays silent when autoUpdate=false in settings", async () => {
    process.argv = ["bun", "kcode"];
    await writeFile(join(tempDir, "settings.json"), JSON.stringify({ autoUpdate: false }));

    let fetched = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = asFetch(
      mock(() => {
        fetched = true;
        return Promise.resolve(
          new Response(JSON.stringify(mockManifest("2.10.999")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    try {
      const { maybeNotifyUpdate } = await import("./update-notifier");
      await maybeNotifyUpdate("1.0.0");
      expect(logs.join("\n")).toBe("");
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = asFetch(origFetch);
    }
  });
});
