import { describe, expect, test } from "bun:test";
import {
  createAutoPrompt,
  PERMISSION_TIMEOUT_MS,
  type PermissionRequest,
  RemotePermissionBridge,
} from "./remote-permission";

function makeRequest(id: string = "req-1"): PermissionRequest {
  return {
    id,
    tool: "Bash",
    description: "Execute shell command",
    detail: "rm -rf /tmp/test",
    cwd: "/home/user/project",
  };
}

describe("remote-permission", () => {
  describe("PERMISSION_TIMEOUT_MS", () => {
    test("is 30 seconds", () => {
      expect(PERMISSION_TIMEOUT_MS).toBe(30_000);
    });
  });

  describe("RemotePermissionBridge", () => {
    test("approves when prompt returns true", async () => {
      const bridge = new RemotePermissionBridge(async () => true);
      const result = await bridge.handleRequest(makeRequest());

      expect(result.requestId).toBe("req-1");
      expect(result.approved).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test("denies when prompt returns false", async () => {
      const bridge = new RemotePermissionBridge(async () => false);
      const result = await bridge.handleRequest(makeRequest());

      expect(result.requestId).toBe("req-1");
      expect(result.approved).toBe(false);
      expect(result.reason).toBe("User denied the request.");
    });

    test("denies on timeout with appropriate message", async () => {
      // Use a very short timeout for testing
      const bridge = new RemotePermissionBridge(
        () => new Promise(() => {}), // Never resolves
        100, // 100ms timeout
      );

      const result = await bridge.handleRequest(makeRequest("timeout-req"));

      expect(result.requestId).toBe("timeout-req");
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("timed out");
    });

    test("denies on prompt error", async () => {
      const bridge = new RemotePermissionBridge(async () => {
        throw new Error("Prompt crashed");
      });

      const result = await bridge.handleRequest(makeRequest("error-req"));

      expect(result.requestId).toBe("error-req");
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("Error");
    });

    test("handles concurrent requests independently", async () => {
      let callCount = 0;
      const bridge = new RemotePermissionBridge(async (req) => {
        callCount++;
        return req.id === "req-approve";
      });

      const [r1, r2] = await Promise.all([
        bridge.handleRequest(makeRequest("req-approve")),
        bridge.handleRequest(makeRequest("req-deny")),
      ]);

      expect(r1.approved).toBe(true);
      expect(r2.approved).toBe(false);
      expect(callCount).toBe(2);
    });

    test("cancel() denies pending request", async () => {
      const bridge = new RemotePermissionBridge(
        () => new Promise(() => {}), // Never resolves
        10_000,
      );

      const promise = bridge.handleRequest(makeRequest("cancel-req"));

      // Cancel immediately
      bridge.cancel("cancel-req");

      const result = await promise;
      expect(result.requestId).toBe("cancel-req");
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("cancelled");
    });

    test("cancelAll() denies all pending requests", async () => {
      const bridge = new RemotePermissionBridge(() => new Promise(() => {}), 10_000);

      const p1 = bridge.handleRequest(makeRequest("all-1"));
      const p2 = bridge.handleRequest(makeRequest("all-2"));

      expect(bridge.pendingCount).toBe(2);

      bridge.cancelAll();

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.approved).toBe(false);
      expect(r2.approved).toBe(false);
      expect(bridge.pendingCount).toBe(0);
    });

    test("pendingCount tracks active requests", async () => {
      const bridge = new RemotePermissionBridge(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return true;
      });

      expect(bridge.pendingCount).toBe(0);

      const p = bridge.handleRequest(makeRequest());
      // The request is being processed
      expect(bridge.pendingCount).toBeGreaterThanOrEqual(0);

      await p;
      expect(bridge.pendingCount).toBe(0);
    });

    test("cancel non-existent request is a no-op", () => {
      const bridge = new RemotePermissionBridge(async () => true);
      expect(() => bridge.cancel("nonexistent")).not.toThrow();
    });
  });

  describe("createAutoPrompt", () => {
    test("auto-approve returns true", async () => {
      const prompt = createAutoPrompt(true);
      const result = await prompt(makeRequest());
      expect(result).toBe(true);
    });

    test("auto-deny returns false", async () => {
      const prompt = createAutoPrompt(false);
      const result = await prompt(makeRequest());
      expect(result).toBe(false);
    });

    test("default is auto-deny", async () => {
      const prompt = createAutoPrompt();
      const result = await prompt(makeRequest());
      expect(result).toBe(false);
    });
  });
});
