import { test, expect, describe } from "bun:test";
import { RemoteSession, type RemoteSessionEvent } from "./remote-session";
import { DEFAULT_REMOTE_CONFIG } from "./types";

/** Fast-fail host: connection refused instantly on port 1 */
const FAST_FAIL_HOST = "nobody@localhost";

/**
 * We override checkConnectivity behavior by using a host that SSH will refuse
 * instantly (port 1 on localhost). The RemoteSession.connect() calls
 * checkConnectivity which uses the default SSH port unless overridden,
 * so "nobody@localhost" with no SSH server on port 22 will fail.
 * If port 22 IS running, it'll fail on auth (BatchMode=yes).
 * Either way, checkConnectivity returns false quickly.
 */

describe("remote-session", () => {
  describe("RemoteSession construction", () => {
    test("creates session with unique ID", () => {
      const session = new RemoteSession({
        config: {
          host: "user@server",
          remoteDir: "/home/user/project",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "execution",
        localDir: "/tmp/local",
      });

      expect(session.sessionId).toBeTruthy();
      expect(typeof session.sessionId).toBe("string");
      expect(session.sessionId.length).toBeGreaterThan(0);
    });

    test("uses provided session ID", () => {
      const session = new RemoteSession({
        config: {
          host: "user@server",
          remoteDir: "/home/user/project",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "execution",
        localDir: "/tmp/local",
        sessionId: "custom-session-123",
      });

      expect(session.sessionId).toBe("custom-session-123");
    });

    test("initial status is disconnected", () => {
      const session = new RemoteSession({
        config: {
          host: "user@server",
          remoteDir: "/home/user/project",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "sync",
        localDir: "/tmp/local",
      });

      expect(session.status).toBe("disconnected");
    });

    test("info returns correct structure", () => {
      const session = new RemoteSession({
        config: {
          host: "user@server",
          remoteDir: "/home/user/project",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "viewer",
        localDir: "/tmp/local",
        sessionId: "info-test-id",
      });

      const info = session.info;
      expect(info.id).toBe("info-test-id");
      expect(info.host).toBe("user@server");
      expect(info.dir).toBe("/home/user/project");
      expect(info.status).toBe("disconnected");
      expect(typeof info.createdAt).toBe("string");
    });
  });

  describe("connect failures", () => {
    test("throws on unreachable host (execution mode)", async () => {
      const events: RemoteSessionEvent[] = [];
      const session = new RemoteSession({
        config: {
          host: FAST_FAIL_HOST,
          remoteDir: "/tmp",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "execution",
        localDir: "/tmp/local",
        onEvent: (e) => events.push(e),
      });

      await expect(session.connect()).rejects.toThrow("Cannot connect");
      expect(events.some((e) => e.type === "connecting")).toBe(true);
    });

    test("throws on unreachable host (sync mode)", async () => {
      const session = new RemoteSession({
        config: {
          host: FAST_FAIL_HOST,
          remoteDir: "/tmp",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "sync",
        localDir: "/tmp/local",
      });

      await expect(session.connect()).rejects.toThrow("Cannot connect");
    });

    test("throws on unreachable host (viewer mode)", async () => {
      const session = new RemoteSession({
        config: {
          host: FAST_FAIL_HOST,
          remoteDir: "/tmp",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "viewer",
        localDir: "/tmp/local",
        sessionId: "some-session",
      });

      await expect(session.connect()).rejects.toThrow("Cannot connect");
    });
  });

  describe("send()", () => {
    test("throws in viewer mode", () => {
      const session = new RemoteSession({
        config: {
          host: "user@server",
          remoteDir: "/tmp",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "viewer",
        localDir: "/tmp/local",
      });

      expect(() => session.send({ type: "test" })).toThrow("Cannot send messages in viewer mode");
    });

    test("throws when not connected", () => {
      const session = new RemoteSession({
        config: {
          host: "user@server",
          remoteDir: "/tmp",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "execution",
        localDir: "/tmp/local",
      });

      expect(() => session.send({ type: "test" })).toThrow("Not connected");
    });
  });

  describe("executeRemoteCommand()", () => {
    test("throws when not in sync mode", async () => {
      const session = new RemoteSession({
        config: {
          host: "user@server",
          remoteDir: "/tmp",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "execution",
        localDir: "/tmp/local",
      });

      await expect(
        session.executeRemoteCommand(["echo", "hello"]),
      ).rejects.toThrow("only available in sync mode");
    });
  });

  describe("disconnect()", () => {
    test("disconnect on a fresh session does not throw", async () => {
      const events: RemoteSessionEvent[] = [];
      const session = new RemoteSession({
        config: {
          host: "user@server",
          remoteDir: "/tmp",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "execution",
        localDir: "/tmp/local",
        onEvent: (e) => events.push(e),
      });

      await expect(session.disconnect()).resolves.toBeUndefined();
      expect(session.status).toBe("terminated");
      expect(events.some((e) => e.type === "session-ended")).toBe(true);
    });

    test("disconnect with killRemoteAgent=true does not throw", async () => {
      const session = new RemoteSession({
        config: {
          host: "user@server",
          remoteDir: "/tmp",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "execution",
        localDir: "/tmp/local",
      });

      await expect(session.disconnect(true)).resolves.toBeUndefined();
    });
  });
});
