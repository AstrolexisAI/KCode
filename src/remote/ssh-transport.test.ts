import { test, expect, describe } from "bun:test";
import {
  checkConnectivity,
  checkKCodeInstalled,
  executeRemoteSync,
  DEFAULT_RECONNECT,
} from "./ssh-transport";

/**
 * Use a host that will fail FAST (connection refused, not timeout).
 * localhost with a port that's not running SSH fails immediately.
 * Format: ssh -p <port> user@localhost -- this gets refused instantly.
 */
const FAST_FAIL_HOST = "nobody@localhost";
const FAST_FAIL_OPTS = { timeout: 2, extraOptions: { Port: "1" } };

describe("ssh-transport", () => {
  describe("checkConnectivity", () => {
    test("returns false when SSH connection is refused", () => {
      const result = checkConnectivity(FAST_FAIL_HOST, FAST_FAIL_OPTS);
      expect(result).toBe(false);
    });

    test("returns false for empty host", () => {
      const result = checkConnectivity("", { timeout: 1 });
      expect(result).toBe(false);
    });
  });

  describe("checkKCodeInstalled", () => {
    test("returns not installed for unreachable host", () => {
      const result = checkKCodeInstalled(FAST_FAIL_HOST, FAST_FAIL_OPTS);
      expect(result.installed).toBe(false);
    });
  });

  describe("executeRemoteSync", () => {
    test("returns non-zero exit code for unreachable host", () => {
      const result = executeRemoteSync(
        FAST_FAIL_HOST,
        ["echo", "hello"],
        undefined,
        FAST_FAIL_OPTS,
      );
      expect(result.exitCode).not.toBe(0);
    });

    test("handles cwd parameter in command construction", () => {
      const result = executeRemoteSync(
        FAST_FAIL_HOST,
        ["ls", "-la"],
        "/some/dir",
        FAST_FAIL_OPTS,
      );
      expect(typeof result.exitCode).toBe("number");
      expect(typeof result.stdout).toBe("string");
      expect(typeof result.stderr).toBe("string");
    });
  });

  describe("reconnect", () => {
    // Test reconnect logic without actual SSH calls by testing the config shape
    test("DEFAULT_RECONNECT has expected defaults", () => {
      expect(DEFAULT_RECONNECT.retryInterval).toBe(5000);
      expect(DEFAULT_RECONNECT.maxAttempts).toBe(12);
    });

    test("reconnect with zero maxAttempts returns false immediately", async () => {
      const { reconnect } = await import("./ssh-transport");
      const attempts: number[] = [];
      const result = await reconnect(
        FAST_FAIL_HOST,
        { retryInterval: 10, maxAttempts: 0 },
        (attempt) => attempts.push(attempt),
      );
      expect(result).toBe(false);
      expect(attempts.length).toBe(0);
    });

    test("reconnect calls onAttempt and returns false for unreachable host", async () => {
      const { reconnect } = await import("./ssh-transport");
      const attempts: Array<{ attempt: number; max: number }> = [];
      const result = await reconnect(
        FAST_FAIL_HOST,
        { retryInterval: 10, maxAttempts: 2 },
        (attempt, max) => attempts.push({ attempt, max }),
      );
      expect(result).toBe(false);
      expect(attempts.length).toBe(2);
      expect(attempts[0]).toEqual({ attempt: 1, max: 2 });
      expect(attempts[1]).toEqual({ attempt: 2, max: 2 });
    });
  });
});
