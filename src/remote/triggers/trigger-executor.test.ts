// KCode - Remote Trigger Executor Tests

import { describe, test, expect, mock } from "bun:test";
import { TriggerExecutor } from "./trigger-executor";
import type { SpawnResult, SpawnOptions } from "./trigger-executor";
import type { RemoteTrigger, TriggerRunResult } from "./types";

function makeTrigger(overrides?: Partial<RemoteTrigger>): RemoteTrigger {
  return {
    id: "trg_test_001",
    name: "Test trigger",
    schedule: "0 9 * * *",
    prompt: "Run tests and report",
    status: "active",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

function createMockSpawn(result: SpawnResult) {
  return mock((_args: string[], _options: SpawnOptions) =>
    Promise.resolve(result),
  );
}

describe("TriggerExecutor", () => {
  describe("execute", () => {
    test("returns success result on exit code 0", async () => {
      const spawnFn = createMockSpawn({
        exitCode: 0,
        stdout: "All tests passed",
        stderr: "",
      });

      const executor = new TriggerExecutor({ spawnFn });
      const trigger = makeTrigger();
      const result = await executor.execute(trigger, "/tmp/project");

      expect(result.triggerId).toBe("trg_test_001");
      expect(result.status).toBe("success");
      expect(result.summary).toContain("All tests passed");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("returns error result on non-zero exit code", async () => {
      const spawnFn = createMockSpawn({
        exitCode: 1,
        stdout: "",
        stderr: "Command not found",
      });

      const executor = new TriggerExecutor({ spawnFn });
      const trigger = makeTrigger();
      const result = await executor.execute(trigger, "/tmp/project");

      expect(result.status).toBe("error");
      expect(result.summary).toContain("Exit code 1");
      expect(result.summary).toContain("Command not found");
    });

    test("handles timeout errors (exit code 124)", async () => {
      const spawnFn = createMockSpawn({
        exitCode: 124,
        stdout: "",
        stderr: "Trigger timed out after 5000ms",
      });

      const executor = new TriggerExecutor({ spawnFn, timeoutMs: 5000 });
      const trigger = makeTrigger();
      const result = await executor.execute(trigger, "/tmp/project");

      expect(result.status).toBe("error");
      expect(result.summary).toContain("timed out");
    });

    test("handles spawn function throwing error", async () => {
      const spawnFn = mock(() => Promise.reject(new Error("ENOENT: bun not found")));

      const executor = new TriggerExecutor({ spawnFn });
      const trigger = makeTrigger();
      const result = await executor.execute(trigger, "/tmp/project");

      expect(result.status).toBe("error");
      expect(result.summary).toContain("ENOENT");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("captures duration", async () => {
      const spawnFn = mock(async () => {
        // Small delay to ensure measurable duration
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { exitCode: 0, stdout: "done", stderr: "" };
      });

      const executor = new TriggerExecutor({ spawnFn });
      const trigger = makeTrigger();
      const result = await executor.execute(trigger, "/tmp/project");

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.durationMs).toBe("number");
    });

    test("passes model flag when trigger has model", async () => {
      const spawnFn = createMockSpawn({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      });

      const executor = new TriggerExecutor({ spawnFn });
      const trigger = makeTrigger({ model: "claude-3-haiku" });
      await executor.execute(trigger, "/tmp/project");

      expect(spawnFn).toHaveBeenCalledTimes(1);
      const args = spawnFn.mock.calls[0][0] as string[];
      expect(args).toContain("--model");
      expect(args).toContain("claude-3-haiku");
    });

    test("passes maxTurns flag when trigger has maxTurns", async () => {
      const spawnFn = createMockSpawn({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      });

      const executor = new TriggerExecutor({ spawnFn });
      const trigger = makeTrigger({ maxTurns: 10 });
      await executor.execute(trigger, "/tmp/project");

      const args = spawnFn.mock.calls[0][0] as string[];
      expect(args).toContain("--max-turns");
      expect(args).toContain("10");
    });

    test("uses trigger workingDirectory when provided", async () => {
      const spawnFn = createMockSpawn({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      });

      const executor = new TriggerExecutor({ spawnFn });
      const trigger = makeTrigger({ workingDirectory: "/custom/dir" });
      await executor.execute(trigger, "/default/dir");

      const options = spawnFn.mock.calls[0][1] as SpawnOptions;
      expect(options.cwd).toBe("/custom/dir");
    });

    test("uses provided cwd when trigger has no workingDirectory", async () => {
      const spawnFn = createMockSpawn({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      });

      const executor = new TriggerExecutor({ spawnFn });
      const trigger = makeTrigger();
      await executor.execute(trigger, "/default/dir");

      const options = spawnFn.mock.calls[0][1] as SpawnOptions;
      expect(options.cwd).toBe("/default/dir");
    });

    test("returns success summary when stdout is empty", async () => {
      const spawnFn = createMockSpawn({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const executor = new TriggerExecutor({ spawnFn });
      const trigger = makeTrigger();
      const result = await executor.execute(trigger, "/tmp/project");

      expect(result.status).toBe("success");
      expect(result.summary).toBe("Completed successfully");
    });
  });

  describe("executeAll", () => {
    test("runs triggers in sequence", async () => {
      const callOrder: string[] = [];
      const spawnFn = mock(async (args: string[]) => {
        const prompt = args[args.length - 1];
        callOrder.push(prompt);
        return { exitCode: 0, stdout: `Done: ${prompt}`, stderr: "" };
      });

      const executor = new TriggerExecutor({ spawnFn });
      const triggers = [
        makeTrigger({ id: "trg_1", prompt: "first" }),
        makeTrigger({ id: "trg_2", prompt: "second" }),
        makeTrigger({ id: "trg_3", prompt: "third" }),
      ];

      const results = await executor.executeAll(triggers, "/tmp");

      expect(results).toHaveLength(3);
      expect(results[0].triggerId).toBe("trg_1");
      expect(results[1].triggerId).toBe("trg_2");
      expect(results[2].triggerId).toBe("trg_3");
      expect(callOrder).toEqual(["first", "second", "third"]);
    });

    test("returns empty array for empty input", async () => {
      const spawnFn = createMockSpawn({ exitCode: 0, stdout: "", stderr: "" });
      const executor = new TriggerExecutor({ spawnFn });

      const results = await executor.executeAll([], "/tmp");
      expect(results).toEqual([]);
      expect(spawnFn).not.toHaveBeenCalled();
    });

    test("continues executing after a failure", async () => {
      let callCount = 0;
      const spawnFn = mock(async () => {
        callCount++;
        if (callCount === 2) {
          return { exitCode: 1, stdout: "", stderr: "failed" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      });

      const executor = new TriggerExecutor({ spawnFn });
      const triggers = [
        makeTrigger({ id: "trg_1" }),
        makeTrigger({ id: "trg_2" }),
        makeTrigger({ id: "trg_3" }),
      ];

      const results = await executor.executeAll(triggers, "/tmp");

      expect(results).toHaveLength(3);
      expect(results[0].status).toBe("success");
      expect(results[1].status).toBe("error");
      expect(results[2].status).toBe("success");
    });
  });

  describe("formatResult", () => {
    test("produces readable output for success", () => {
      const executor = new TriggerExecutor({
        spawnFn: createMockSpawn({ exitCode: 0, stdout: "", stderr: "" }),
      });

      const result: TriggerRunResult = {
        triggerId: "trg_001",
        status: "success",
        summary: "All tests passed",
        messagesCount: 5,
        tokensUsed: 2400,
        costUsd: 0.012,
        durationMs: 15000,
      };

      const output = executor.formatResult(result);

      expect(output).toContain("Trigger: trg_001");
      expect(output).toContain("Status:  OK");
      expect(output).toContain("Duration: 15.0s");
      expect(output).toContain("Summary: All tests passed");
      expect(output).toContain("Tokens:  2400");
      expect(output).toContain("Cost:    $0.0120");
    });

    test("produces readable output for error", () => {
      const executor = new TriggerExecutor({
        spawnFn: createMockSpawn({ exitCode: 0, stdout: "", stderr: "" }),
      });

      const result: TriggerRunResult = {
        triggerId: "trg_002",
        status: "error",
        summary: "Process crashed",
        messagesCount: 0,
        tokensUsed: 0,
        costUsd: 0,
        durationMs: 500,
      };

      const output = executor.formatResult(result);

      expect(output).toContain("Status:  ERROR");
      expect(output).toContain("Duration: 0.5s");
      expect(output).not.toContain("Tokens:");
      expect(output).not.toContain("Cost:");
    });

    test("includes artifacts when present", () => {
      const executor = new TriggerExecutor({
        spawnFn: createMockSpawn({ exitCode: 0, stdout: "", stderr: "" }),
      });

      const result: TriggerRunResult = {
        triggerId: "trg_003",
        status: "success",
        summary: "Files updated",
        messagesCount: 3,
        tokensUsed: 0,
        costUsd: 0,
        durationMs: 8000,
        artifacts: [
          { path: "src/index.ts", action: "modified" },
          { path: "src/new-file.ts", action: "created" },
        ],
      };

      const output = executor.formatResult(result);

      expect(output).toContain("Artifacts:");
      expect(output).toContain("modified: src/index.ts");
      expect(output).toContain("created: src/new-file.ts");
    });

    test("omits artifacts section when none present", () => {
      const executor = new TriggerExecutor({
        spawnFn: createMockSpawn({ exitCode: 0, stdout: "", stderr: "" }),
      });

      const result: TriggerRunResult = {
        triggerId: "trg_004",
        status: "success",
        summary: "Done",
        messagesCount: 1,
        tokensUsed: 0,
        costUsd: 0,
        durationMs: 1000,
      };

      const output = executor.formatResult(result);
      expect(output).not.toContain("Artifacts:");
    });
  });
});
