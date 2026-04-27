// Model discovery tests.
//
// Covers: guessContextSize heuristic, provider adapters (parseDataIdArray,
// headers factory), discoverFromProvider with a mocked fetch, merge
// behavior (never overwrites existing), and the runModelDiscovery
// orchestrator.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetForTest,
  ALL_PROVIDERS,
  collectProviderKeys,
  type DiscoveryResult,
  discoverFromProvider,
  fetchProviderModels,
  guessContextSize,
  maybeAutoDiscover,
  runModelDiscovery,
} from "./model-discovery";
import { _setModelsPathForTest, type ModelsConfig } from "./models";

// Cast helper: bun:test's mock and async functions don't include
// fetch's `preconnect` static method; the runtime wires through fine,
// but `globalThis.fetch =` requires the full typeof fetch shape.
const asFetch = (fn: unknown): typeof globalThis.fetch => fn as typeof globalThis.fetch;

// Test isolation
let testHome: string;
let testModelsPath: string;
let originalFetch: typeof globalThis.fetch;
let originalKcodeHome: string | undefined;

beforeEach(() => {
  originalKcodeHome = process.env.KCODE_HOME;
  originalFetch = globalThis.fetch;
  testHome = join(
    tmpdir(),
    `kcode-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(testHome, { recursive: true });
  process.env.KCODE_HOME = testHome;
  testModelsPath = join(testHome, "models.json");
  _setModelsPathForTest(testModelsPath);
  _resetForTest(); // clear in-flight discovery promise
});

afterEach(() => {
  globalThis.fetch = asFetch(originalFetch);
  _setModelsPathForTest(undefined);
  if (originalKcodeHome === undefined) {
    delete process.env.KCODE_HOME;
  } else {
    process.env.KCODE_HOME = originalKcodeHome;
  }
  if (existsSync(testHome)) {
    rmSync(testHome, { recursive: true, force: true });
  }
  // Clean provider keys from env so they don't leak between tests
  for (const env of [
    "ANTHROPIC_API_KEY",
    "KCODE_ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "KCODE_OPENAI_API_KEY",
    "GROQ_API_KEY",
    "KCODE_GROQ_API_KEY",
    "DEEPSEEK_API_KEY",
    "KCODE_DEEPSEEK_API_KEY",
    "TOGETHER_API_KEY",
    "TOGETHER_AI_API_KEY",
    "KCODE_TOGETHER_API_KEY",
  ]) {
    delete process.env[env];
  }
});

// ─── guessContextSize ──────────────────────────────────────────

describe("guessContextSize", () => {
  test("Claude models map to 200K", () => {
    expect(guessContextSize("claude-opus-4-7")).toBe(200_000);
    expect(guessContextSize("claude-opus-4-6")).toBe(200_000);
    expect(guessContextSize("claude-sonnet-4-6")).toBe(200_000);
    expect(guessContextSize("claude-haiku-4-5")).toBe(200_000);
    expect(guessContextSize("claude-3-5-sonnet-20241022")).toBe(200_000);
  });

  test("Claude 1M beta maps to 1M", () => {
    expect(guessContextSize("claude-sonnet-4-6-1m")).toBe(1_000_000);
  });

  test("OpenAI modern models map correctly", () => {
    expect(guessContextSize("gpt-4o")).toBe(128_000);
    expect(guessContextSize("gpt-4o-mini")).toBe(128_000);
    expect(guessContextSize("gpt-4-turbo-preview")).toBe(128_000);
    expect(guessContextSize("gpt-4.1")).toBe(1_000_000);
    expect(guessContextSize("o1-preview")).toBe(200_000);
    expect(guessContextSize("o3-mini")).toBe(200_000);
  });

  test("old GPT-4 is 8K", () => {
    expect(guessContextSize("gpt-4")).toBe(8_192);
  });

  test("Llama 3.x 70B/8B are 128K", () => {
    expect(guessContextSize("llama-3.1-70b-versatile")).toBe(128_000);
    expect(guessContextSize("llama-3.3-70b-versatile")).toBe(128_000);
  });

  test("DeepSeek R1/V3/coder maps to 128K", () => {
    expect(guessContextSize("deepseek-r1")).toBe(128_000);
    expect(guessContextSize("deepseek-v3")).toBe(128_000);
    expect(guessContextSize("deepseek-coder-v2")).toBe(128_000);
  });

  test("unknown model defaults to 128K", () => {
    expect(guessContextSize("some-new-model-2026")).toBe(128_000);
  });
});

// ─── Provider adapters ─────────────────────────────────────────

describe("Provider spec parse", () => {
  test("Anthropic adapter parses OpenAI-compat { data: [] } shape", () => {
    const anthropic = ALL_PROVIDERS.find((p) => p.id === "anthropic")!;
    const ids = anthropic.parse({
      data: [
        { id: "claude-opus-4-7", type: "model" },
        { id: "claude-sonnet-4-6", type: "model" },
      ],
    });
    expect(ids).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
  });

  test("OpenAI adapter parses the same shape", () => {
    const openai = ALL_PROVIDERS.find((p) => p.id === "openai")!;
    const ids = openai.parse({
      data: [
        { id: "gpt-4o", object: "model" },
        { id: "o3-mini", object: "model" },
      ],
    });
    expect(ids).toEqual(["gpt-4o", "o3-mini"]);
  });

  test("parse handles missing/malformed body", () => {
    const openai = ALL_PROVIDERS.find((p) => p.id === "openai")!;
    expect(openai.parse(null)).toEqual([]);
    expect(openai.parse({})).toEqual([]);
    expect(openai.parse({ data: "not an array" })).toEqual([]);
    expect(openai.parse({ data: [{ foo: "bar" }] })).toEqual([]);
  });

  test("Anthropic headers include x-api-key and anthropic-version", () => {
    const anthropic = ALL_PROVIDERS.find((p) => p.id === "anthropic")!;
    const h = anthropic.headers("test-key");
    expect(h["x-api-key"]).toBe("test-key");
    expect(h["anthropic-version"]).toBeTruthy();
    expect(h["authorization"]).toBeUndefined();
  });

  test("OpenAI-compat providers use Bearer auth", () => {
    for (const id of ["openai", "groq", "deepseek", "together"]) {
      const spec = ALL_PROVIDERS.find((p) => p.id === id)!;
      const h = spec.headers("test-key");
      expect(h.authorization).toBe("Bearer test-key");
    }
  });
});

// ─── fetchProviderModels ───────────────────────────────────────

describe("fetchProviderModels (with mocked fetch)", () => {
  test("returns IDs on a 200 response", async () => {
    globalThis.fetch = asFetch(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: "claude-opus-4-7" }, { id: "claude-sonnet-4-6" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const anthropic = ALL_PROVIDERS.find((p) => p.id === "anthropic")!;
    const ids = await fetchProviderModels(anthropic, "test-key");
    expect(ids).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
  });

  test("throws on non-200 response", async () => {
    globalThis.fetch = asFetch(async () => new Response("unauthorized", { status: 401 }));
    const openai = ALL_PROVIDERS.find((p) => p.id === "openai")!;
    await expect(fetchProviderModels(openai, "bad-key")).rejects.toThrow(/HTTP 401/);
  });
});

// ─── discoverFromProvider ──────────────────────────────────────

describe("discoverFromProvider", () => {
  test("adds new models to an empty config", async () => {
    globalThis.fetch = asFetch(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: "claude-opus-4-7" }, { id: "claude-sonnet-4-6" }] }),
          { status: 200 },
        ),
    );
    const config: ModelsConfig = { models: [] };
    const anthropic = ALL_PROVIDERS.find((p) => p.id === "anthropic")!;
    const r = await discoverFromProvider(anthropic, "test-key", config);
    expect(r.added).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
    expect(r.skipped).toEqual([]);
    expect(config.models).toHaveLength(2);
    expect(config.models[0]!.provider).toBe("anthropic");
    expect(config.models[0]!.contextSize).toBe(200_000);
    expect(config.models[0]!.baseUrl).toBe("https://api.anthropic.com");
  });

  test("never overwrites existing entries (user customization preserved)", async () => {
    globalThis.fetch = asFetch(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "claude-opus-4-7" }] }), { status: 200 }),
    );
    const config: ModelsConfig = {
      models: [
        {
          name: "claude-opus-4-7",
          baseUrl: "https://custom.example.com",
          contextSize: 99_999,
          description: "User's custom config",
          provider: "anthropic",
        },
      ],
    };
    const anthropic = ALL_PROVIDERS.find((p) => p.id === "anthropic")!;
    const r = await discoverFromProvider(anthropic, "test-key", config);
    expect(r.added).toEqual([]);
    expect(r.skipped).toEqual(["claude-opus-4-7"]);
    expect(config.models).toHaveLength(1);
    expect(config.models[0]!.baseUrl).toBe("https://custom.example.com");
    expect(config.models[0]!.contextSize).toBe(99_999);
    expect(config.models[0]!.description).toBe("User's custom config");
  });

  test("records the error and returns empty added on fetch failure", async () => {
    globalThis.fetch = asFetch(async () => new Response("server error", { status: 500 }));
    const config: ModelsConfig = { models: [] };
    const openai = ALL_PROVIDERS.find((p) => p.id === "openai")!;
    const r = await discoverFromProvider(openai, "test-key", config);
    expect(r.added).toEqual([]);
    expect(r.error).toMatch(/HTTP 500/);
    expect(config.models).toHaveLength(0);
  });
});

// ─── collectProviderKeys ───────────────────────────────────────

describe("collectProviderKeys", () => {
  test("picks up standard env var names", async () => {
    process.env.ANTHROPIC_API_KEY = "a-key";
    process.env.OPENAI_API_KEY = "o-key";
    process.env.GROQ_API_KEY = "g-key";
    const keys = await collectProviderKeys();
    expect(keys.get("anthropic")).toBe("a-key");
    expect(keys.get("openai")).toBe("o-key");
    expect(keys.get("groq")).toBe("g-key");
  });

  test("falls back to KCODE-prefixed names", async () => {
    process.env.KCODE_ANTHROPIC_API_KEY = "k-a-key";
    const keys = await collectProviderKeys();
    expect(keys.get("anthropic")).toBe("k-a-key");
  });

  test("omits providers without a key", async () => {
    const keys = await collectProviderKeys();
    expect(keys.has("anthropic")).toBe(false);
    expect(keys.has("openai")).toBe(false);
  });

  test("falls back to settings.json keys (the /cloud flow stores them here)", async () => {
    // Simulate a user who ran /cloud and has anthropicApiKey saved
    // in ~/.kcode/settings.json but no env var exported.
    writeFileSync(
      join(testHome, "settings.json"),
      JSON.stringify({
        anthropicApiKey: "sk-ant-api03-from-settings",
        xaiApiKey: "xai-some-key",
      }),
      "utf-8",
    );
    const keys = await collectProviderKeys();
    expect(keys.get("anthropic")).toBe("sk-ant-api03-from-settings");
  });

  test("env var wins over settings.json when both are present", async () => {
    process.env.ANTHROPIC_API_KEY = "env-wins";
    writeFileSync(
      join(testHome, "settings.json"),
      JSON.stringify({ anthropicApiKey: "settings-loses" }),
      "utf-8",
    );
    const keys = await collectProviderKeys();
    expect(keys.get("anthropic")).toBe("env-wins");
  });
});

describe("Anthropic headers auto-switch on OAuth vs API key", () => {
  test("sk-ant-oat01-* uses Authorization: Bearer + oauth-beta", () => {
    const anthropic = ALL_PROVIDERS.find((p) => p.id === "anthropic")!;
    const h = anthropic.headers("sk-ant-oat01-testtoken123");
    expect(h.authorization).toBe("Bearer sk-ant-oat01-testtoken123");
    expect(h["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["x-api-key"]).toBeUndefined();
  });

  test("sk-ant-api03-* uses x-api-key (no OAuth beta)", () => {
    const anthropic = ALL_PROVIDERS.find((p) => p.id === "anthropic")!;
    const h = anthropic.headers("sk-ant-api03-testkey456");
    expect(h["x-api-key"]).toBe("sk-ant-api03-testkey456");
    expect(h.authorization).toBeUndefined();
    expect(h["anthropic-beta"]).toBeUndefined();
    expect(h["anthropic-version"]).toBe("2023-06-01");
  });
});

// ─── runModelDiscovery ─────────────────────────────────────────

describe("runModelDiscovery", () => {
  test("discovers from all providers with keys", async () => {
    writeFileSync(testModelsPath, JSON.stringify({ models: [] }), "utf-8");
    globalThis.fetch = asFetch(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("anthropic.com")) {
        return new Response(JSON.stringify({ data: [{ id: "claude-opus-4-7" }] }), { status: 200 });
      }
      if (url.includes("openai.com")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-4o-2026-preview" }] }), {
          status: 200,
        });
      }
      return new Response("not mocked", { status: 404 });
    });
    const keys = new Map([
      ["anthropic", "a"],
      ["openai", "o"],
    ]);
    const results = await runModelDiscovery({
      apiKeys: keys,
      providerFilter: ["anthropic", "openai"],
    });
    const added = results.flatMap((r) => r.added);
    expect(added).toContain("claude-opus-4-7");
    expect(added).toContain("gpt-4o-2026-preview");
  });

  test("skips providers without keys and records error", async () => {
    writeFileSync(testModelsPath, JSON.stringify({ models: [] }), "utf-8");
    const results: DiscoveryResult[] = await runModelDiscovery({
      apiKeys: new Map(), // no keys
      providerFilter: ["anthropic"],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.error).toMatch(/no API key/);
    expect(results[0]!.added).toEqual([]);
  });

  test("providerFilter limits which providers are queried", async () => {
    writeFileSync(testModelsPath, JSON.stringify({ models: [] }), "utf-8");
    globalThis.fetch = asFetch(
      async () => new Response(JSON.stringify({ data: [{ id: "some-model" }] }), { status: 200 }),
    );
    const keys = new Map([
      ["anthropic", "a"],
      ["openai", "o"],
      ["groq", "g"],
    ]);
    const results = await runModelDiscovery({
      apiKeys: keys,
      providerFilter: ["anthropic"], // only anthropic
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.provider).toBe("anthropic");
  });
});

// ─── maybeAutoDiscover (throttle) ──────────────────────────────

describe("maybeAutoDiscover throttle", () => {
  test("skips when last run was recent (within interval)", async () => {
    // Pre-seed the discovery-state file with a very recent timestamp
    const statePath = join(testHome, "discovery-state.json");
    writeFileSync(
      statePath,
      JSON.stringify({ lastRunAt: Date.now() - 1000 }), // 1s ago
      "utf-8",
    );
    writeFileSync(testModelsPath, JSON.stringify({ models: [] }), "utf-8");

    // Fetch should NOT be called since we're within the interval
    let fetchCalls = 0;
    globalThis.fetch = asFetch(async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const added = await maybeAutoDiscover({ minIntervalMs: 60_000 });
    expect(added).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  test("runs when no previous state exists", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    writeFileSync(testModelsPath, JSON.stringify({ models: [] }), "utf-8");

    globalThis.fetch = asFetch(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("anthropic.com")) {
        return new Response(JSON.stringify({ data: [{ id: "claude-opus-4-7" }] }), { status: 200 });
      }
      return new Response("not mocked", { status: 404 });
    });

    const added = await maybeAutoDiscover();
    expect(added).toContain("claude-opus-4-7");

    // State file should have been created with a fresh timestamp
    const statePath = join(testHome, "discovery-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.lastRunAt).toBeGreaterThan(Date.now() - 10_000);
  });

  test("force=true bypasses the throttle", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    writeFileSync(testModelsPath, JSON.stringify({ models: [] }), "utf-8");
    const statePath = join(testHome, "discovery-state.json");
    writeFileSync(
      statePath,
      JSON.stringify({ lastRunAt: Date.now() - 1000 }), // 1s ago — would normally skip
      "utf-8",
    );

    let fetchCalls = 0;
    globalThis.fetch = asFetch(async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ data: [{ id: "fresh-model" }] }), { status: 200 });
    });

    const added = await maybeAutoDiscover({ force: true });
    expect(fetchCalls).toBeGreaterThan(0); // at least one provider queried
    expect(added).toContain("fresh-model");
  });

  test("network failure returns empty array instead of throwing", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    writeFileSync(testModelsPath, JSON.stringify({ models: [] }), "utf-8");
    globalThis.fetch = asFetch(async () => {
      throw new Error("network down");
    });
    // Should not throw
    const added = await maybeAutoDiscover({ force: true });
    expect(added).toEqual([]);
  });
});
