import { test, expect, describe } from "bun:test";
import { executeWebSearch, webSearchDefinition } from "./web-search.ts";

describe("web search tool", () => {
  // ─── Definition ───

  test("webSearchDefinition has correct name and required fields", () => {
    expect(webSearchDefinition.name).toBe("WebSearch");
    expect(webSearchDefinition.input_schema.required).toContain("query");
  });

  test("definition describes tier fallback logic", () => {
    const desc = webSearchDefinition.description;
    expect(desc).toContain("Brave");
    expect(desc).toContain("SearXNG");
    expect(desc).toContain("DuckDuckGo");
  });

  test("definition includes allowed_domains and blocked_domains properties", () => {
    const props = webSearchDefinition.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("allowed_domains");
    expect(props).toHaveProperty("blocked_domains");
  });

  // ─── filterResults via executeWebSearch ───
  // Since filterResults and formatResults are not exported, we test them
  // through the full executeWebSearch flow.

  test("returns results for a common query (network test)", async () => {
    // This hits the network — use a query likely to return results
    const result = await executeWebSearch({ query: "bun javascript runtime" });

    expect(result.tool_use_id).toBe("");
    // Should either succeed with results or fail gracefully
    if (!result.is_error) {
      expect(result.content).toContain("bun javascript runtime");
      // Should have at least some formatted output
      expect(result.content.length).toBeGreaterThan(50);
    } else {
      // All backends failed — that's OK in CI/network-restricted envs
      expect(result.content).toContain("All search backends failed");
    }
  }, 30_000); // 30s timeout for network

  test("allowed_domains filters results", async () => {
    const result = await executeWebSearch({
      query: "typescript documentation",
      allowed_domains: ["typescriptlang.org"],
    });

    if (!result.is_error) {
      // If we got results, they should only be from the allowed domain
      // or there should be no results if none matched
      const hasResults = !result.content.includes("No search results found.");
      if (hasResults) {
        // Every URL in the results should be from typescriptlang.org
        const urlMatches = result.content.match(/\(https?:\/\/[^)]+\)/g) || [];
        for (const urlMatch of urlMatches) {
          expect(urlMatch).toContain("typescriptlang.org");
        }
      }
    }
    // If is_error, backends failed — acceptable in test environments
  }, 30_000);

  test("blocked_domains excludes results", async () => {
    const result = await executeWebSearch({
      query: "javascript tutorial",
      blocked_domains: ["w3schools.com"],
    });

    if (!result.is_error) {
      // Results should not contain blocked domain
      expect(result.content).not.toContain("w3schools.com");
    }
  }, 30_000);

  // ─── formatResults with no results ───
  // We can trigger this by using an extremely restrictive allowed_domains filter

  test("shows 'No search results found.' when all results filtered out", async () => {
    const result = await executeWebSearch({
      query: "test query",
      allowed_domains: ["this-domain-definitely-does-not-exist-xyz123.invalid"],
    });

    if (!result.is_error) {
      expect(result.content).toContain("No search results found.");
    }
  }, 30_000);

  // ─── Tier fallback: all tiers failed message ───

  test("reports all backends failed when none work", async () => {
    // Save original env
    const origBrave = process.env.BRAVE_API_KEY;
    const origSearxng = process.env.SEARXNG_URL;

    // Set a bad Brave key and a bad SearXNG URL to force failures
    process.env.BRAVE_API_KEY = "invalid-key-12345";
    process.env.SEARXNG_URL = "http://127.0.0.1:1"; // port 1 — should fail fast

    try {
      const result = await executeWebSearch({ query: "test fallback" });

      // Either DuckDuckGo fallback works, or all fail
      // We can't guarantee DDG fails, so just verify the structure
      if (result.is_error) {
        expect(result.content).toContain("All search backends failed");
        expect(result.content).toContain("Brave Search");
        expect(result.content).toContain("SearXNG");
      }
      // If DDG succeeded, that's fine too — the tier logic worked
    } finally {
      // Restore env
      if (origBrave !== undefined) {
        process.env.BRAVE_API_KEY = origBrave;
      } else {
        delete process.env.BRAVE_API_KEY;
      }
      if (origSearxng !== undefined) {
        process.env.SEARXNG_URL = origSearxng;
      } else {
        delete process.env.SEARXNG_URL;
      }
    }
  }, 30_000);

  // ─── Output format ───

  test("output includes search query in header", async () => {
    const result = await executeWebSearch({ query: "openai api" });

    if (!result.is_error) {
      expect(result.content).toContain('Search: "openai api"');
      expect(result.content).toContain("via ");
    }
  }, 30_000);

  // ─── Empty query handling ───

  test("handles empty query without crashing", async () => {
    const result = await executeWebSearch({ query: "" });
    // Should not throw — may return results or error
    expect(result.tool_use_id).toBe("");
  }, 30_000);

  // ─── tool_use_id ───

  test("result always has empty tool_use_id", async () => {
    const result = await executeWebSearch({ query: "test" });
    expect(result.tool_use_id).toBe("");
  }, 30_000);
});
