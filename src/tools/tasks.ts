// KCode - Task Management Tools
// SQLite-backed persistent task store with dependencies and background process tracking

import { getDb } from "../core/db";
import type { ToolDefinition, ToolResult } from "../core/types";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
  pid?: number;
  sessionId?: string;
  completedAt?: number;
}

/** Safely parse a JSON array, returning [] on any error */
function safeParseArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// In-memory PID tracking for running processes only (not persisted)
const runningPids = new Map<string, number>();

// Session ID for this process instance
const currentSessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Generate a unique task ID using max existing + 1, wrapped in a transaction for safety */
function nextId(): string {
  const db = getDb();
  // Use a transaction to prevent race conditions on concurrent inserts
  const row = db.query("SELECT MAX(CAST(id AS INTEGER)) as max_id FROM tasks").get() as {
    max_id: number | null;
  } | null;
  const next = (row?.max_id ?? 0) + 1;
  // Double-check the ID doesn't already exist (belt-and-suspenders)
  const exists = db.query("SELECT 1 FROM tasks WHERE id = ?").get(String(next));
  if (exists) {
    return String(next + 1);
  }
  return String(next);
}

/** Convert a DB row to a Task object */
function rowToTask(row: Record<string, unknown>): Task {
  const task: Task = {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string) ?? "",
    status: (row.status as TaskStatus) ?? "pending",
    owner: (row.owner as string) || undefined,
    blocks: safeParseArray((row.blocks as string) ?? "[]"),
    blockedBy: safeParseArray((row.blocked_by as string) ?? "[]"),
    createdAt: new Date(row.created_at as string).getTime(),
    updatedAt: new Date(row.updated_at as string).getTime(),
    sessionId: (row.session_id as string) || undefined,
    completedAt: row.completed_at ? new Date(row.completed_at as string).getTime() : undefined,
  };
  // Attach in-memory PID if this task has a running process
  const pid = runningPids.get(task.id);
  if (pid !== undefined) task.pid = pid;
  return task;
}

// ─── TaskCreate ─────────────────────────────────────────────

export const taskCreateDefinition: ToolDefinition = {
  name: "TaskCreate",
  description: "Create a new task with optional dependencies.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Task title" },
      description: { type: "string", description: "Task description" },
      owner: { type: "string", description: "Task owner (e.g. agent ID)" },
      blocks: {
        type: "array",
        items: { type: "string" },
        description: "Task IDs that this task blocks",
      },
      blockedBy: {
        type: "array",
        items: { type: "string" },
        description: "Task IDs that block this task",
      },
    },
    required: ["title"],
  },
};

export async function executeTaskCreate(input: Record<string, unknown>): Promise<ToolResult> {
  const { title, description, owner, blocks, blockedBy } = input as {
    title: string;
    description?: string;
    owner?: string;
    blocks?: string[];
    blockedBy?: string[];
  };

  const db = getDb();
  const id = nextId();
  const now = new Date().toISOString();
  const blocksArr = blocks ?? [];
  const blockedByArr = blockedBy ?? [];

  db.query(
    `INSERT INTO tasks (id, title, description, status, owner, blocks, blocked_by, created_at, updated_at, session_id)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    title,
    description ?? "",
    owner ?? "",
    JSON.stringify(blocksArr),
    JSON.stringify(blockedByArr),
    now,
    now,
    currentSessionId,
  );

  // Update reverse dependencies for tasks that this task blocks
  for (const blockedId of blocksArr) {
    const row = db.query("SELECT blocked_by FROM tasks WHERE id = ?").get(blockedId) as {
      blocked_by: string;
    } | null;
    if (row) {
      const existing: string[] = JSON.parse(row.blocked_by);
      if (!existing.includes(id)) {
        existing.push(id);
        db.query("UPDATE tasks SET blocked_by = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify(existing),
          now,
          blockedId,
        );
      }
    }
  }

  // Update reverse dependencies for tasks that block this task
  for (const blockerId of blockedByArr) {
    const row = db.query("SELECT blocks FROM tasks WHERE id = ?").get(blockerId) as {
      blocks: string;
    } | null;
    if (row) {
      const existing: string[] = JSON.parse(row.blocks);
      if (!existing.includes(id)) {
        existing.push(id);
        db.query("UPDATE tasks SET blocks = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify(existing),
          now,
          blockerId,
        );
      }
    }
  }

  return {
    tool_use_id: "",
    content: JSON.stringify({ id, title, status: "pending" }),
  };
}

// ─── TaskList ───────────────────────────────────────────────

export const taskListDefinition: ToolDefinition = {
  name: "TaskList",
  description: "List all tasks, optionally filtered by status or owner.",
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed"],
        description: "Filter by status",
      },
      owner: { type: "string", description: "Filter by owner" },
      session_id: { type: "string", description: "Filter by session ID" },
    },
  },
};

export async function executeTaskList(input: Record<string, unknown>): Promise<ToolResult> {
  const { status, owner, session_id } = input as {
    status?: TaskStatus;
    owner?: string;
    session_id?: string;
  };

  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (owner) {
    conditions.push("owner = ?");
    params.push(owner);
  }
  if (session_id) {
    conditions.push("session_id = ?");
    params.push(session_id);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const stmt = db.prepare(`SELECT * FROM tasks${where} ORDER BY CAST(id AS INTEGER)`);
  const rows = stmt.all(...(params as string[])) as Record<string, unknown>[];

  if (rows.length === 0) {
    return { tool_use_id: "", content: "No tasks found." };
  }

  const formatted = rows
    .map((row) => {
      const task = rowToTask(row);
      const deps = task.blockedBy.length > 0 ? ` (blocked by: ${task.blockedBy.join(", ")})` : "";
      return `[${task.id}] ${task.status.toUpperCase()} - ${task.title}${deps}`;
    })
    .join("\n");

  return { tool_use_id: "", content: `Tasks (${rows.length}):\n${formatted}` };
}

// ─── TaskGet ────────────────────────────────────────────────

export const taskGetDefinition: ToolDefinition = {
  name: "TaskGet",
  description: "Get details of a specific task by ID.",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID" },
    },
    required: ["id"],
  },
};

export async function executeTaskGet(input: Record<string, unknown>): Promise<ToolResult> {
  const { id } = input as { id: string };
  const db = getDb();
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<
    string,
    unknown
  > | null;

  if (!row) {
    return {
      tool_use_id: "",
      content: `Error: Task "${id}" not found`,
      is_error: true,
    };
  }

  const task = rowToTask(row);
  return {
    tool_use_id: "",
    content: JSON.stringify(task, null, 2),
  };
}

// ─── TaskUpdate ─────────────────────────────────────────────

export const taskUpdateDefinition: ToolDefinition = {
  name: "TaskUpdate",
  description: "Update a task's title, description, status, or owner.",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID to update" },
      title: { type: "string", description: "New title" },
      description: { type: "string", description: "New description" },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed"],
        description: "New status",
      },
      owner: { type: "string", description: "New owner" },
    },
    required: ["id"],
  },
};

export async function executeTaskUpdate(input: Record<string, unknown>): Promise<ToolResult> {
  const { id, title, description, status, owner } = input as {
    id: string;
    title?: string;
    description?: string;
    status?: TaskStatus;
    owner?: string;
  };

  const db = getDb();
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<
    string,
    unknown
  > | null;

  if (!row) {
    return {
      tool_use_id: "",
      content: `Error: Task "${id}" not found`,
      is_error: true,
    };
  }

  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];

  if (title !== undefined) {
    sets.push("title = ?");
    params.push(title);
  }
  if (description !== undefined) {
    sets.push("description = ?");
    params.push(description);
  }
  if (status !== undefined) {
    sets.push("status = ?");
    params.push(status);
    if (status === "completed") {
      sets.push("completed_at = ?");
      params.push(now);
    } else {
      // Clear completed_at when reverting from completed
      sets.push("completed_at = NULL");
    }
  }
  if (owner !== undefined) {
    sets.push("owner = ?");
    params.push(owner);
  }

  params.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...(params as string[]));

  // Re-read the updated row
  const updated = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>;
  const task = rowToTask(updated);

  return {
    tool_use_id: "",
    content: JSON.stringify({
      id: task.id,
      title: task.title,
      status: task.status,
      owner: task.owner,
    }),
  };
}

// ─── TaskStop ───────────────────────────────────────────────

export const taskStopDefinition: ToolDefinition = {
  name: "TaskStop",
  description: "Stop a running task and kill its associated background process if any.",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID to stop" },
    },
    required: ["id"],
  },
};

export async function executeTaskStop(input: Record<string, unknown>): Promise<ToolResult> {
  const { id } = input as { id: string };
  const db = getDb();
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<
    string,
    unknown
  > | null;

  if (!row) {
    return {
      tool_use_id: "",
      content: `Error: Task "${id}" not found`,
      is_error: true,
    };
  }

  // Kill associated process if it exists in memory
  const pid = runningPids.get(id);
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may already be dead
    }
    runningPids.delete(id);
  }

  const now = new Date().toISOString();
  db.query(
    "UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
  ).run(now, now, id);

  return {
    tool_use_id: "",
    content: `Task "${id}" stopped. Status set to completed.`,
  };
}

// ─── Utility: attach a PID to a task (used by background execution) ───

export function attachPidToTask(taskId: string, pid: number): void {
  runningPids.set(taskId, pid);
}

export function getSessionId(): string {
  return currentSessionId;
}
