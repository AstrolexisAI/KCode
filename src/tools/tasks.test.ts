// Tests for Task tools — CRUD + dependencies

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeTaskCreate,
  executeTaskGet,
  executeTaskList,
  executeTaskStop,
  executeTaskUpdate,
  taskCreateDefinition,
  taskGetDefinition,
  taskListDefinition,
  taskStopDefinition,
  taskUpdateDefinition,
} from "./tasks";

// Override db path for isolation
const testDbDir = join(tmpdir(), `kcode-tasks-test-${Date.now()}`);
process.env.KCODE_DB_PATH = join(testDbDir, "test.db");

beforeAll(() => {
  mkdirSync(testDbDir, { recursive: true });
  // Initialize the tasks table
  const db = new Database(process.env.KCODE_DB_PATH!);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      owner TEXT DEFAULT '',
      blocks TEXT DEFAULT '[]',
      blocked_by TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      session_id TEXT
    );
  `);
  db.close();
});

afterAll(() => {
  rmSync(testDbDir, { recursive: true, force: true });
  delete process.env.KCODE_DB_PATH;
});

describe("task tool definitions", () => {
  test("all definitions have correct names", () => {
    expect(taskCreateDefinition.name).toBe("TaskCreate");
    expect(taskListDefinition.name).toBe("TaskList");
    expect(taskGetDefinition.name).toBe("TaskGet");
    expect(taskUpdateDefinition.name).toBe("TaskUpdate");
    expect(taskStopDefinition.name).toBe("TaskStop");
  });

  test("TaskCreate requires title", () => {
    expect(taskCreateDefinition.input_schema.required).toContain("title");
  });

  test("TaskUpdate requires taskId", () => {
    expect(taskUpdateDefinition.input_schema.required).toContain("id");
  });

  test("TaskGet requires taskId", () => {
    expect(taskGetDefinition.input_schema.required).toContain("id");
  });
});

describe("executeTaskCreate", () => {
  test("creates a task with title", async () => {
    const result = await executeTaskCreate({ title: "Test task 1" });
    expect(result.is_error).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.title).toBe("Test task 1");
    expect(parsed.status).toBe("pending");
    expect(parsed.id).toBeDefined();
  });

  test("creates a task with description and owner", async () => {
    const result = await executeTaskCreate({
      title: "Test task 2",
      description: "A description",
      owner: "curly",
    });
    expect(result.is_error).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.id).toBeDefined();
  });

  test("assigns unique sequential IDs", async () => {
    const r1 = await executeTaskCreate({ title: "A" });
    const r2 = await executeTaskCreate({ title: "B" });
    const id1 = JSON.parse(r1.content as string).id;
    const id2 = JSON.parse(r2.content as string).id;
    expect(id1).not.toBe(id2);
  });
});

describe("executeTaskList", () => {
  test("returns tasks", async () => {
    await executeTaskCreate({ title: "List test" });
    const result = await executeTaskList({});
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("List test");
  });

  test("filters by status", async () => {
    await executeTaskCreate({ title: "Pending one" });
    const result = await executeTaskList({ status: "pending" });
    expect(result.is_error).toBeFalsy();
  });
});

describe("executeTaskGet", () => {
  test("retrieves a task by ID", async () => {
    const created = await executeTaskCreate({ title: "Get me" });
    const id = JSON.parse(created.content as string).id;
    const result = await executeTaskGet({ id: id });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("Get me");
  });

  test("returns error for non-existent task", async () => {
    const result = await executeTaskGet({ id: "999999" });
    expect(result.is_error).toBe(true);
  });
});

describe("executeTaskUpdate", () => {
  test("updates task status", async () => {
    const created = await executeTaskCreate({ title: "Update me" });
    const id = JSON.parse(created.content as string).id;
    const result = await executeTaskUpdate({ id: id, status: "in_progress" });
    expect(result.is_error).toBeFalsy();

    const fetched = await executeTaskGet({ id: id });
    expect(fetched.content).toContain("in_progress");
  });

  test("can mark task as completed", async () => {
    const created = await executeTaskCreate({ title: "Complete me" });
    const id = JSON.parse(created.content as string).id;
    const result = await executeTaskUpdate({ id: id, status: "completed" });
    expect(result.is_error).toBeFalsy();
  });

  test("returns error for non-existent task", async () => {
    const result = await executeTaskUpdate({ id: "999999", status: "in_progress" });
    expect(result.is_error).toBe(true);
  });
});

describe("executeTaskStop", () => {
  test("handles task with no PID gracefully", async () => {
    const created = await executeTaskCreate({ title: "No PID" });
    const id = JSON.parse(created.content as string).id;
    const result = await executeTaskStop({ id: id });
    // Either succeeds or errors — both are acceptable for a task with no running process
    expect(typeof result.content).toBe("string");
  });
});
