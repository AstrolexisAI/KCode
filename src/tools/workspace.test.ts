// Tests for workspace — CWD anchoring for tools
import { describe, expect, test } from "bun:test";
import { getToolWorkspace, setToolWorkspace } from "./workspace";

describe("workspace", () => {
  test("default workspace is process.cwd() or similar", () => {
    const ws = getToolWorkspace();
    expect(typeof ws).toBe("string");
    expect(ws.length).toBeGreaterThan(0);
  });

  test("setToolWorkspace updates the workspace", () => {
    const original = getToolWorkspace();
    setToolWorkspace("/tmp/test-workspace");
    expect(getToolWorkspace()).toBe("/tmp/test-workspace");
    // Restore
    setToolWorkspace(original);
    expect(getToolWorkspace()).toBe(original);
  });

  test("setToolWorkspace accepts any absolute path", () => {
    setToolWorkspace("/home/user/projects/myapp");
    expect(getToolWorkspace()).toBe("/home/user/projects/myapp");
  });
});
