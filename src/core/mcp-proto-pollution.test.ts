// Regression test for js-008-prototype-pollution-bracket in
// McpManager.loadFromConfigs. A malicious MCP config could list
// `__proto__`, `constructor`, or `prototype` as a "server name";
// prior to v2.10.13 this was assigned via bracket notation into a
// plain object literal, poisoning Object.prototype for the rest of
// the process.

import { describe, expect, test } from "bun:test";
import { McpManager } from "./mcp";

describe("McpManager.loadFromConfigs — prototype pollution", () => {
  test("does not pollute Object.prototype via __proto__ server name", async () => {
    // Stub network side effects so the test stays hermetic.
    const mgr = new McpManager();
    const anyMgr = mgr as unknown as { startServers: () => Promise<void>; startHealthChecks: () => void };
    anyMgr.startServers = async () => { /* no-op */ };
    anyMgr.startHealthChecks = () => { /* no-op */ };

    // Use JSON.parse so TS doesn't narrow away the __proto__ literal.
    const hostile = JSON.parse(`{
      "__proto__": { "polluted": true },
      "constructor": { "polluted": true },
      "prototype":   { "polluted": true },
      "legit":       { "command": "echo", "args": ["hi"] }
    }`);

    // The load call must complete without crashing AND without
    // assigning any of the hostile entries onto Object.prototype.
    await mgr.loadFromConfigs(hostile);

    const blankProbe: Record<string, unknown> = {};
    expect((blankProbe as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test("legitimate server names are still accepted", async () => {
    const mgr = new McpManager();
    const anyMgr = mgr as unknown as { startServers: (c: unknown) => Promise<void>; startHealthChecks: () => void };
    let startedWith: unknown = null;
    anyMgr.startServers = async (configs) => { startedWith = configs; };
    anyMgr.startHealthChecks = () => { /* no-op */ };

    const configs = JSON.parse(`{
      "good-server": { "command": "echo", "args": ["hi"] }
    }`);
    await mgr.loadFromConfigs(configs);

    expect(startedWith).not.toBeNull();
    const got = startedWith as Record<string, unknown>;
    expect(got["good-server"]).toBeDefined();
    // Hostile keys should be absent entirely.
    expect(got["__proto__"]).toBeUndefined();
  });
});
