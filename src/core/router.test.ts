import { test, expect, describe, beforeEach, mock } from "bun:test";
import { classifyTask, withCloudFailover, resetRoutingRules } from "./router.ts";

// ─── classifyTask ──────────────────────────────────────────────────

describe("classifyTask", () => {
  // ─── Vision detection ──────────────────────────────────────────

  describe("vision detection", () => {
    test("base64 data URI → vision", () => {
      expect(classifyTask("data:image/png;base64,abc123")).toBe("vision");
    });

    test("base64 jpeg data URI → vision", () => {
      expect(classifyTask("data:image/jpeg;base64,xyz")).toBe("vision");
    });

    test("[Image: ...] header → vision", () => {
      expect(classifyTask("[Image: /path/to/file.png]")).toBe("vision");
    });

    test("[image/png output] notebook output → vision", () => {
      expect(classifyTask("[image/png output]")).toBe("vision");
    });

    test("[image/jpeg output] notebook output → vision", () => {
      expect(classifyTask("[image/jpeg output]")).toBe("vision");
    });

    test("message referencing a .png file → vision", () => {
      expect(classifyTask("look at screenshot.png please")).toBe("vision");
    });

    test("message referencing a .jpg file → vision", () => {
      expect(classifyTask("check photo.jpg for errors")).toBe("vision");
    });

    test("env var line with image extensions → NOT vision", () => {
      expect(classifyTask("IMAGE_FORMATS=png,jpg")).not.toBe("vision");
    });

    test("config line with formats → NOT vision", () => {
      expect(classifyTask("VISION_SUPPORTED_FORMATS=png,jpg,jpeg")).not.toBe("vision");
    });
  });

  // ─── Simple task detection ─────────────────────────────────────

  describe("simple task detection", () => {
    test("'show git status' → simple", () => {
      expect(classifyTask("show git status")).toBe("simple");
    });

    test("'ls src/' → simple", () => {
      expect(classifyTask("ls src/")).toBe("simple");
    });

    test("'what is a closure' → simple", () => {
      expect(classifyTask("what is a closure")).toBe("simple");
    });

    test("'list all test files' → simple", () => {
      expect(classifyTask("list all test files")).toBe("simple");
    });

    test("'find the config file' → simple", () => {
      expect(classifyTask("find the config file")).toBe("simple");
    });

    test("'read src/index.ts' → simple", () => {
      expect(classifyTask("read src/index.ts")).toBe("simple");
    });

    test("'grep for TODO' → simple", () => {
      expect(classifyTask("grep for TODO")).toBe("simple");
    });

    test("'git status' → simple", () => {
      expect(classifyTask("git status")).toBe("simple");
    });

    test("'git log' → simple", () => {
      expect(classifyTask("git log")).toBe("simple");
    });

    test("'where is the router' → simple", () => {
      expect(classifyTask("where is the router")).toBe("simple");
    });

    test("'how many tests are there' → simple", () => {
      expect(classifyTask("how many tests are there")).toBe("simple");
    });

    test("long message with 'show' keyword → NOT simple", () => {
      const longMessage = "show me " + "a very detailed explanation of ".repeat(10) + "the entire architecture";
      expect(longMessage.length).toBeGreaterThan(200);
      expect(classifyTask(longMessage)).not.toBe("simple");
    });
  });

  // ─── Reasoning detection ───────────────────────────────────────

  describe("reasoning detection", () => {
    test("'architect the system' → reasoning", () => {
      expect(classifyTask("architect the system")).toBe("reasoning");
    });

    test("'why does this happen' → reasoning", () => {
      expect(classifyTask("why does this happen")).toBe("reasoning");
    });

    test("'explain why the test fails' → reasoning", () => {
      expect(classifyTask("explain why the test fails")).toBe("reasoning");
    });

    test("'root cause of the memory leak' → reasoning", () => {
      expect(classifyTask("root cause of the memory leak")).toBe("reasoning");
    });

    test("'trade-off between speed and safety' → reasoning", () => {
      expect(classifyTask("trade-off between speed and safety")).toBe("reasoning");
    });

    test("'do a security audit' → reasoning", () => {
      expect(classifyTask("do a security audit")).toBe("reasoning");
    });

    test("'do an audit of the codebase' → reasoning", () => {
      expect(classifyTask("do an audit of the codebase")).toBe("reasoning");
    });

    test("'pros and cons of this approach' → reasoning", () => {
      expect(classifyTask("pros and cons of this approach")).toBe("reasoning");
    });
  });

  // ─── Code detection ────────────────────────────────────────────

  describe("code detection", () => {
    test("'refactor the auth module' → code", () => {
      expect(classifyTask("refactor the auth module")).toBe("code");
    });

    test("'implement a REST API' → code", () => {
      expect(classifyTask("implement a REST API")).toBe("code");
    });

    test("'fix the login bug' → code", () => {
      expect(classifyTask("fix bug in the login flow")).toBe("code");
    });

    test("'write code for a parser' → code", () => {
      expect(classifyTask("write code for a parser")).toBe("code");
    });

    test("'create function to validate input' → code", () => {
      expect(classifyTask("create function to validate input")).toBe("code");
    });

    test("'debug the failing endpoint' → code", () => {
      expect(classifyTask("debug the failing endpoint")).toBe("code");
    });

    test("'write a unit test for router' → code", () => {
      expect(classifyTask("write a unit test for router")).toBe("code");
    });

    test("message with code block → code", () => {
      expect(classifyTask("here is the issue:\n```typescript\nconst x = 1;\n```")).toBe("code");
    });

    test("'deploy the service' → code", () => {
      expect(classifyTask("deploy the service to production")).toBe("code");
    });
  });

  // ─── General / default ─────────────────────────────────────────

  describe("general / default", () => {
    test("'hello how are you' → general", () => {
      expect(classifyTask("hello how are you")).toBe("general");
    });

    test("empty string → general", () => {
      expect(classifyTask("")).toBe("general");
    });

    test("whitespace only → general", () => {
      expect(classifyTask("   ")).toBe("general");
    });

    test("generic sentence → general", () => {
      expect(classifyTask("thanks for the help")).toBe("general");
    });
  });

  // ─── Priority order ────────────────────────────────────────────

  describe("classification priority", () => {
    test("vision takes priority over code keywords", () => {
      // Message has both image content and code keywords
      expect(classifyTask("refactor this [Image: /path/to/screenshot.png]")).toBe("vision");
    });

    test("simple takes priority over reasoning for short matching messages", () => {
      // "what is" matches simple, and is short
      expect(classifyTask("what is this")).toBe("simple");
    });

    test("reasoning takes priority over code", () => {
      // "why does" matches reasoning; "implement" would match code
      expect(classifyTask("why does the implementation fail")).toBe("reasoning");
    });
  });
});

// ─── withCloudFailover ─────────────────────────────────────────────

describe("withCloudFailover", () => {
  beforeEach(() => {
    resetRoutingRules();
  });

  test("single model → calls fn with that model and returns result", async () => {
    const fn = mock(async (model: string) => `result-from-${model}`);
    const result = await withCloudFailover(["model-a"], fn);
    expect(result).toBe("result-from-model-a");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("all models fail → throws the last error", async () => {
    // Mock isPro to return true so failover logic activates
    mock.module("./pro.js", () => ({
      isPro: async () => true,
    }));

    const fn = mock(async (model: string) => {
      throw new Error(`${model} failed`);
    });

    try {
      await withCloudFailover(["m1", "m2", "m3"], fn);
      // Should not reach here
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toBe("m3 failed");
    }
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("first model succeeds → returns immediately without trying others", async () => {
    mock.module("./pro.js", () => ({
      isPro: async () => true,
    }));

    const fn = mock(async (model: string) => `ok-${model}`);
    const result = await withCloudFailover(["m1", "m2"], fn);
    expect(result).toBe("ok-m1");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("first model fails, second succeeds → returns second result", async () => {
    mock.module("./pro.js", () => ({
      isPro: async () => true,
    }));

    let callCount = 0;
    const fn = mock(async (model: string) => {
      callCount++;
      if (callCount === 1) throw new Error("first failed");
      return `ok-${model}`;
    });

    const result = await withCloudFailover(["m1", "m2"], fn);
    expect(result).toBe("ok-m2");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
