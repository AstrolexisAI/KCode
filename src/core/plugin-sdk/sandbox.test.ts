import { describe, test, expect, beforeEach } from "bun:test";
import { PluginSandbox, createSandbox } from "./sandbox";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("PluginSandbox", () => {
  let sandbox: PluginSandbox;
  let pluginDir: string;

  beforeEach(() => {
    pluginDir = mkdtempSync(join(tmpdir(), "kcode-sandbox-test-"));
    sandbox = createSandbox(pluginDir);
  });

  describe("validatePath", () => {
    test("allows paths within plugin dir", () => {
      const result = sandbox.validatePath("skills/test.md");
      expect(result.valid).toBe(true);
    });

    test("allows plugin dir itself", () => {
      const result = sandbox.validatePath(pluginDir);
      expect(result.valid).toBe(true);
    });

    test("blocks path traversal with ..", () => {
      const result = sandbox.validatePath("../../../etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("traversal");
    });

    test("blocks absolute paths outside plugin dir", () => {
      const result = sandbox.validatePath("/etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("outside");
    });

    test("allows additional allowed paths", () => {
      const extraDir = mkdtempSync(join(tmpdir(), "kcode-extra-"));
      const s = createSandbox(pluginDir, { allowedPaths: [extraDir] });
      const result = s.validatePath(join(extraDir, "file.txt"));
      expect(result.valid).toBe(true);
    });
  });

  describe("validateCommand", () => {
    test("allows safe commands", () => {
      expect(sandbox.validateCommand("echo", ["hello"]).valid).toBe(true);
      expect(sandbox.validateCommand("cat", ["file.txt"]).valid).toBe(true);
      expect(sandbox.validateCommand("ls", ["-la"]).valid).toBe(true);
    });

    test("blocks dangerous commands", () => {
      expect(sandbox.validateCommand("rm", ["-rf", "/"]).valid).toBe(false);
      expect(sandbox.validateCommand("sudo", ["anything"]).valid).toBe(false);
      expect(sandbox.validateCommand("kill", ["-9", "1"]).valid).toBe(false);
      expect(sandbox.validateCommand("shutdown", []).valid).toBe(false);
    });

    test("blocks shell injection patterns", () => {
      expect(sandbox.validateCommand("echo", ["hello; rm -rf /"]).valid).toBe(false);
      expect(sandbox.validateCommand("echo", ["$(whoami)"]).valid).toBe(false);
      expect(sandbox.validateCommand("echo", ["hello | sh"]).valid).toBe(false);
    });
  });

  describe("executeWithTimeout", () => {
    test("resolves within timeout", async () => {
      const result = await sandbox.executeWithTimeout(async () => "done");
      expect(result).toBe("done");
    });

    test("rejects on timeout", async () => {
      await expect(
        sandbox.executeWithTimeout(
          () => new Promise((r) => setTimeout(r, 5000)),
          50,
        ),
      ).rejects.toThrow("timed out");
    });

    test("propagates errors", async () => {
      await expect(
        sandbox.executeWithTimeout(async () => {
          throw new Error("test error");
        }),
      ).rejects.toThrow("test error");
    });
  });

  describe("file operations", () => {
    test("readFile reads within sandbox", async () => {
      const testFile = join(pluginDir, "test.txt");
      writeFileSync(testFile, "hello world");
      const content = await sandbox.readFile("test.txt");
      expect(content).toBe("hello world");
    });

    test("readFile throws for files outside sandbox", async () => {
      await expect(sandbox.readFile("/etc/hostname")).rejects.toThrow();
    });

    test("readFile throws for missing files", async () => {
      await expect(sandbox.readFile("nonexistent.txt")).rejects.toThrow("not found");
    });

    test("writeFile writes within sandbox", async () => {
      await sandbox.writeFile("output.txt", "test content");
      const content = await Bun.file(join(pluginDir, "output.txt")).text();
      expect(content).toBe("test content");
    });

    test("writeFile throws for paths outside sandbox", async () => {
      await expect(
        sandbox.writeFile("/tmp/outside.txt", "nope"),
      ).rejects.toThrow();
    });

    test("listFiles lists sandbox contents", () => {
      writeFileSync(join(pluginDir, "a.txt"), "");
      writeFileSync(join(pluginDir, "b.txt"), "");
      const files = sandbox.listFiles();
      expect(files).toContain("a.txt");
      expect(files).toContain("b.txt");
    });

    test("listFiles returns empty for missing subdir", () => {
      const files = sandbox.listFiles("nonexistent");
      expect(files).toEqual([]);
    });
  });

  describe("runProcess", () => {
    test("runs allowed commands", async () => {
      const result = await sandbox.runProcess("echo", ["hello"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello");
    });

    test("rejects blocked commands", async () => {
      await expect(
        sandbox.runProcess("rm", ["-rf", pluginDir]),
      ).rejects.toThrow("not allowed");
    });

    test("runs in plugin directory by default", async () => {
      const result = await sandbox.runProcess("pwd", []);
      expect(result.stdout.trim()).toBe(pluginDir);
    });
  });

  describe("options", () => {
    test("default options are set", () => {
      const opts = sandbox.getOptions();
      expect(opts.timeout).toBe(30_000);
      expect(opts.maxMemoryMB).toBe(256);
      expect(opts.allowNetwork).toBe(false);
    });

    test("custom options are applied", () => {
      const s = createSandbox(pluginDir, {
        timeout: 5000,
        maxMemoryMB: 128,
        allowNetwork: true,
      });
      const opts = s.getOptions();
      expect(opts.timeout).toBe(5000);
      expect(opts.maxMemoryMB).toBe(128);
      expect(opts.allowNetwork).toBe(true);
    });

    test("getPluginDir returns resolved path", () => {
      expect(sandbox.getPluginDir()).toBe(pluginDir);
    });
  });
});
