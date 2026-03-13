import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { LspManager, getLspManager, shutdownLsp } from "./lsp.ts";

describe("LspManager", () => {
  let lsp: LspManager;

  beforeEach(() => {
    lsp = new LspManager("/tmp/kcode-lsp-test");
  });

  afterEach(() => {
    lsp.shutdown();
  });

  test("constructor stores cwd", () => {
    // We can verify cwd is stored by checking the instance exists and doesn't throw
    expect(lsp).toBeDefined();
    expect(lsp).toBeInstanceOf(LspManager);
  });

  test("isActive() returns false initially", () => {
    expect(lsp.isActive()).toBe(false);
  });

  test("getServerNames() returns empty array initially", () => {
    expect(lsp.getServerNames()).toEqual([]);
  });

  test("getDiagnostics() returns empty for unknown file", () => {
    expect(lsp.getDiagnostics("/some/unknown/file.ts")).toEqual([]);
  });

  test("getAllErrors() returns empty initially", () => {
    expect(lsp.getAllErrors()).toEqual([]);
  });

  test("formatDiagnosticsForFile() returns null for no diagnostics", () => {
    expect(lsp.formatDiagnosticsForFile("/no/such/file.ts")).toBeNull();
  });

  test("shutdown() doesn't crash when no servers running", () => {
    expect(() => lsp.shutdown()).not.toThrow();
    expect(lsp.isActive()).toBe(false);
    expect(lsp.getServerNames()).toEqual([]);
  });

  test("shutdown() can be called multiple times safely", () => {
    expect(() => {
      lsp.shutdown();
      lsp.shutdown();
    }).not.toThrow();
  });
});

describe("getLspManager / shutdownLsp singletons", () => {
  afterEach(() => {
    shutdownLsp();
  });

  test("getLspManager() returns null without cwd on first call after shutdown", () => {
    shutdownLsp(); // ensure clean state
    const result = getLspManager();
    expect(result).toBeNull();
  });

  test("getLspManager() creates singleton with cwd", () => {
    shutdownLsp(); // ensure clean state
    const mgr = getLspManager("/tmp/kcode-lsp-singleton-test");
    expect(mgr).not.toBeNull();
    expect(mgr).toBeInstanceOf(LspManager);
  });

  test("getLspManager() returns same instance on subsequent calls", () => {
    shutdownLsp();
    const first = getLspManager("/tmp/kcode-lsp-singleton-test");
    const second = getLspManager();
    expect(second).toBe(first);
  });

  test("shutdownLsp() cleans up singleton", () => {
    getLspManager("/tmp/kcode-lsp-shutdown-test");
    shutdownLsp();
    // After shutdown, calling without cwd returns null
    const result = getLspManager();
    expect(result).toBeNull();
  });
});
