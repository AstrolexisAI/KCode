// KCode - Test Environment Setup for E2E Testing
// Creates isolated test environments with fake dependencies

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { Database } from "bun:sqlite";
import type { KCodeConfig } from "../core/types";
import { FakeProvider } from "./fake-provider";
import { createFakeToolRegistry, type FakeToolRegistryOptions } from "./fake-tools";
import type { ToolRegistry } from "../core/tool-registry";

// ─── Types ───────────────────────────────────────────────────────

export interface TestEnv {
  /** The fake LLM provider. */
  provider: FakeProvider;
  /** The minimal KCodeConfig pointing at the fake provider. */
  config: KCodeConfig;
  /** The fake tool registry. */
  registry: ToolRegistry;
  /** Inspect writes made by the fake Write tool. */
  writes: Array<{ filePath: string; content: string; timestamp: number }>;
  /** Inspect commands executed by the fake Bash tool. */
  bashCommands: Array<{ command: string; timestamp: number }>;
  /** Inspect edits made by the fake Edit tool. */
  edits: Array<{ filePath: string; oldString: string; newString: string; timestamp: number }>;
  /** In-memory SQLite database (not connected to production db). */
  db: Database;
  /** Path to the temporary working directory. */
  workDir: string;
  /** Cleanup function — stops server, closes db, removes temp dir. */
  cleanup: () => Promise<void>;
}

export interface TestEnvOptions {
  /** Options for the fake tool registry. */
  tools?: FakeToolRegistryOptions;
  /** Custom model name (default: "fake-model"). */
  model?: string;
  /** Context window size (default: 32000). */
  contextWindowSize?: number;
  /** Max output tokens (default: 4096). */
  maxTokens?: number;
  /** Whether to initialize a git repo in the temp dir (default: true). */
  initGit?: boolean;
  /** Additional config overrides. */
  configOverrides?: Partial<KCodeConfig>;
}

// ─── Factory ─────────────────────────────────────────────────────

/**
 * Create a complete isolated test environment for E2E testing.
 *
 * Sets up:
 * - Temporary working directory (optionally with git init)
 * - In-memory SQLite database
 * - Fake LLM provider on a random port
 * - Fake tool registry
 * - Minimal KCodeConfig wired to the fake provider
 *
 * Call `cleanup()` when done to release resources.
 */
export async function createTestEnv(opts: TestEnvOptions = {}): Promise<TestEnv> {
  // 1. Create temp directory
  const workDir = mkdtempSync(join(tmpdir(), "kcode-e2e-"));

  // 2. Optionally initialize git repo
  if (opts.initGit !== false) {
    try {
      execSync("git init", { cwd: workDir, stdio: "ignore" });
      execSync('git config user.email "test@kcode.dev"', { cwd: workDir, stdio: "ignore" });
      execSync('git config user.name "KCode Test"', { cwd: workDir, stdio: "ignore" });
      // Create an initial commit so git log works
      writeFileSync(join(workDir, ".gitkeep"), "");
      execSync("git add -A && git commit -m 'init'", { cwd: workDir, stdio: "ignore" });
    } catch {
      // Git not available — continue without
    }
  }

  // 3. Create in-memory SQLite database
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");

  // 4. Start fake LLM provider
  const provider = new FakeProvider();
  await provider.start();

  // 5. Create fake tool registry
  const { registry, writes, bashCommands, edits } = createFakeToolRegistry(opts.tools);

  // 6. Build config
  const config: KCodeConfig = {
    model: opts.model ?? "fake-model",
    apiBase: provider.baseUrl,
    apiKey: "fake-key",
    maxTokens: opts.maxTokens ?? 4096,
    systemPrompt: "", // Will be built by ConversationManager
    workingDirectory: workDir,
    permissionMode: "auto", // No permission prompts in tests
    contextWindowSize: opts.contextWindowSize ?? 32_000,
    maxRetries: 0, // No retries in tests — fail fast
    autoRoute: false, // Don't try to route to other models
    noCache: true, // Don't use response cache in tests
    noSessionPersistence: true, // Don't write transcript files
    telemetry: false,
    ...opts.configOverrides,
  };

  // 7. Cleanup function
  const cleanup = async () => {
    await provider.stop();
    try { db.close(); } catch { /* ignore */ }
    try {
      const { rmSync } = await import("node:fs");
      rmSync(workDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  };

  return {
    provider,
    config,
    registry,
    writes,
    bashCommands,
    edits,
    db,
    workDir,
    cleanup,
  };
}

/**
 * Collect all StreamEvents from an async generator into an array.
 * Useful for assertions in tests.
 */
export async function collectEvents<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/**
 * Collect events and also extract just the text from text_delta events.
 */
export async function collectText(gen: AsyncGenerator<{ type: string; text?: string }>): Promise<{
  events: Array<{ type: string; [key: string]: unknown }>;
  text: string;
}> {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const textParts: string[] = [];
  for await (const event of gen) {
    events.push(event as any);
    if (event.type === "text_delta" && event.text) {
      textParts.push(event.text);
    }
  }
  return { events, text: textParts.join("") };
}
