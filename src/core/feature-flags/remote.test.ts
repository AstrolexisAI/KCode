import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetRemoteFlagClient, getRemoteFlagClient, RemoteFlagClient } from "./remote";

describe("RemoteFlagClient", () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    _resetRemoteFlagClient();
    savedEnv = {
      KCODE_FLAG_TEST_FEATURE: process.env.KCODE_FLAG_TEST_FEATURE,
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetRemoteFlagClient();
  });

  test("starts with no flags", () => {
    const client = new RemoteFlagClient();
    expect(client.getAllFlags()).toHaveLength(0);
  });

  test("isEnabled returns false for unknown flags", () => {
    const client = new RemoteFlagClient();
    expect(client.isEnabled("nonexistent")).toBe(false);
  });

  test("env var override takes precedence", () => {
    process.env.KCODE_FLAG_TEST_FEATURE = "true";
    const client = new RemoteFlagClient();
    expect(client.isEnabled("test_feature")).toBe(true);
  });

  test("env var override false", () => {
    process.env.KCODE_FLAG_TEST_FEATURE = "false";
    const client = new RemoteFlagClient();
    expect(client.isEnabled("test_feature")).toBe(false);
  });

  test("getVariant returns null for unknown flags", () => {
    const client = new RemoteFlagClient();
    expect(client.getVariant("nonexistent")).toBeNull();
  });

  test("getFlag returns null for unknown flags", () => {
    const client = new RemoteFlagClient();
    expect(client.getFlag("nonexistent")).toBeNull();
  });

  test("refresh handles network error gracefully", async () => {
    const client = new RemoteFlagClient({
      apiUrl: "http://localhost:99999/nonexistent",
      timeoutMs: 500,
    });
    const result = await client.refresh();
    expect(result).toBe(false);
  });

  test("singleton returns same instance", () => {
    const a = getRemoteFlagClient();
    const b = getRemoteFlagClient();
    expect(a).toBe(b);
  });

  test("reset clears singleton", () => {
    const a = getRemoteFlagClient();
    _resetRemoteFlagClient();
    const b = getRemoteFlagClient();
    expect(a).not.toBe(b);
  });

  test("stop does not throw", () => {
    const client = new RemoteFlagClient();
    expect(() => client.stop()).not.toThrow();
  });
});
