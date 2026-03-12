// KCode - Task Management Tools
// In-memory task store with dependencies and background process tracking

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
}

const taskStore = new Map<string, Task>();
let nextTaskId = 1;

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

  const id = String(nextTaskId++);
  const now = Date.now();

  const task: Task = {
    id,
    title,
    description: description ?? "",
    status: "pending",
    owner,
    blocks: blocks ?? [],
    blockedBy: blockedBy ?? [],
    createdAt: now,
    updatedAt: now,
  };

  taskStore.set(id, task);

  // Update reverse dependencies
  for (const blockedId of task.blocks) {
    const blocked = taskStore.get(blockedId);
    if (blocked && !blocked.blockedBy.includes(id)) {
      blocked.blockedBy.push(id);
      blocked.updatedAt = now;
    }
  }

  for (const blockerId of task.blockedBy) {
    const blocker = taskStore.get(blockerId);
    if (blocker && !blocker.blocks.includes(id)) {
      blocker.blocks.push(id);
      blocker.updatedAt = now;
    }
  }

  return {
    tool_use_id: "",
    content: JSON.stringify({ id, title, status: task.status }),
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
    },
  },
};

export async function executeTaskList(input: Record<string, unknown>): Promise<ToolResult> {
  const { status, owner } = input as { status?: TaskStatus; owner?: string };

  let tasks = Array.from(taskStore.values());

  if (status) {
    tasks = tasks.filter((t) => t.status === status);
  }
  if (owner) {
    tasks = tasks.filter((t) => t.owner === owner);
  }

  if (tasks.length === 0) {
    return { tool_use_id: "", content: "No tasks found." };
  }

  const formatted = tasks
    .map((t) => {
      const deps = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
      return `[${t.id}] ${t.status.toUpperCase()} - ${t.title}${deps}`;
    })
    .join("\n");

  return { tool_use_id: "", content: `Tasks (${tasks.length}):\n${formatted}` };
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
  const task = taskStore.get(id);

  if (!task) {
    return {
      tool_use_id: "",
      content: `Error: Task "${id}" not found`,
      is_error: true,
    };
  }

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

  const task = taskStore.get(id);
  if (!task) {
    return {
      tool_use_id: "",
      content: `Error: Task "${id}" not found`,
      is_error: true,
    };
  }

  if (title !== undefined) task.title = title;
  if (description !== undefined) task.description = description;
  if (status !== undefined) task.status = status;
  if (owner !== undefined) task.owner = owner;
  task.updatedAt = Date.now();

  return {
    tool_use_id: "",
    content: JSON.stringify({ id: task.id, title: task.title, status: task.status, owner: task.owner }),
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
  const task = taskStore.get(id);

  if (!task) {
    return {
      tool_use_id: "",
      content: `Error: Task "${id}" not found`,
      is_error: true,
    };
  }

  // Kill associated process if it exists
  if (task.pid) {
    try {
      process.kill(task.pid, "SIGTERM");
    } catch {
      // Process may already be dead
    }
    task.pid = undefined;
  }

  task.status = "completed";
  task.updatedAt = Date.now();

  return {
    tool_use_id: "",
    content: `Task "${id}" stopped. Status set to completed.`,
  };
}
