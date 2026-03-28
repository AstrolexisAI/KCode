// KCode - Grep Workspace Guard Tests

import { test, expect, describe, afterAll } from "bun:test";
import { executeGrep } from "./grep";
import { setToolWorkspace } from "./workspace";

const originalWorkspace = process.cwd();

afterAll(() => {
  setToolWorkspace(originalWorkspace);
});

describe("Grep workspace guards", () => {
  test("warns when workspace is HOME and no path specified", async () => {
    const home = process.env.HOME ?? "";
    if (!home) return;
    setToolWorkspace(home);
    const result = await executeGrep({ pattern: "password" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("home directory");
  });

  test("rejects path outside workspace", async () => {
    setToolWorkspace("/tmp");
    const result = await executeGrep({ pattern: "test", path: "/etc/passwd" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("outside the project workspace");
  });
});
