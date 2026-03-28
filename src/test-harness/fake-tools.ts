// KCode - Fake Tool Implementations for E2E Testing
// Provides pre-configured fake tools that can be used in integration tests

import { ToolRegistry } from "../core/tool-registry";
import type { ToolDefinition, ToolResult, ToolHandler } from "../core/types";

// ─── Types ───────────────────────────────────────────────────────

interface FakeFileEntry {
  content: string;
}

interface RecordedWrite {
  filePath: string;
  content: string;
  timestamp: number;
}

interface RecordedBashCommand {
  command: string;
  timestamp: number;
}

// ─── Fake Read Tool ──────────────────────────────────────────────

export interface FakeReadOptions {
  /** Map of file paths to their fake contents. */
  files: Record<string, string>;
}

/**
 * Create a fake Read tool that returns pre-configured file contents.
 */
export function createFakeRead(opts: FakeReadOptions): {
  definition: ToolDefinition;
  handler: ToolHandler;
} {
  const files = new Map<string, FakeFileEntry>();
  for (const [path, content] of Object.entries(opts.files)) {
    files.set(path, { content });
  }

  const definition: ToolDefinition = {
    name: "Read",
    description: "Read file contents (fake)",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        offset: { type: "number", description: "Line number to start from" },
        limit: { type: "number", description: "Number of lines to read" },
      },
      required: ["file_path"],
    },
  };

  const handler: ToolHandler = async (input) => {
    const filePath = input.file_path as string;
    const entry = files.get(filePath);
    if (!entry) {
      return {
        tool_use_id: "",
        content: `Error: File not found: ${filePath}`,
        is_error: true,
      };
    }

    let lines = entry.content.split("\n");
    const offset = (input.offset as number | undefined) ?? 0;
    const limit = (input.limit as number | undefined) ?? lines.length;

    if (offset > 0) {
      lines = lines.slice(offset - 1);
    }
    lines = lines.slice(0, limit);

    // Format with line numbers like `cat -n`
    const numbered = lines
      .map((line, i) => `${String(offset + i + 1).padStart(6)}→${line}`)
      .join("\n");

    return { tool_use_id: "", content: numbered, is_error: false };
  };

  return { definition, handler };
}

// ─── Fake Write Tool ─────────────────────────────────────────────

/**
 * Create a fake Write tool that records what was written.
 */
export function createFakeWrite(): {
  definition: ToolDefinition;
  handler: ToolHandler;
  /** All writes recorded by this fake tool. */
  writes: RecordedWrite[];
} {
  const writes: RecordedWrite[] = [];

  const definition: ToolDefinition = {
    name: "Write",
    description: "Write file contents (fake)",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["file_path", "content"],
    },
  };

  const handler: ToolHandler = async (input) => {
    const filePath = input.file_path as string;
    const content = input.content as string;
    writes.push({ filePath, content, timestamp: Date.now() });
    return {
      tool_use_id: "",
      content: `Successfully wrote ${content.length} bytes to ${filePath}`,
      is_error: false,
    };
  };

  return { definition, handler, writes };
}

// ─── Fake Bash Tool ──────────────────────────────────────────────

export interface FakeBashOptions {
  /** Map of command patterns to their fake outputs. Matched via startsWith. */
  commands: Record<string, string>;
  /** Default output for unmatched commands. */
  defaultOutput?: string;
}

/**
 * Create a fake Bash tool that returns pre-configured command outputs.
 */
export function createFakeBash(opts: FakeBashOptions): {
  definition: ToolDefinition;
  handler: ToolHandler;
  /** All commands executed by this fake tool. */
  commands: RecordedBashCommand[];
} {
  const commands: RecordedBashCommand[] = [];

  const definition: ToolDefinition = {
    name: "Bash",
    description: "Execute shell commands (fake)",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to execute" },
        description: { type: "string", description: "Description of what the command does" },
        timeout: { type: "number", description: "Timeout in ms" },
      },
      required: ["command"],
    },
  };

  const handler: ToolHandler = async (input) => {
    const command = input.command as string;
    commands.push({ command, timestamp: Date.now() });

    // Match by prefix
    for (const [pattern, output] of Object.entries(opts.commands)) {
      if (command.startsWith(pattern) || command === pattern) {
        return { tool_use_id: "", content: output, is_error: false };
      }
    }

    if (opts.defaultOutput !== undefined) {
      return { tool_use_id: "", content: opts.defaultOutput, is_error: false };
    }

    return {
      tool_use_id: "",
      content: `fake-bash: command not found: ${command.split(" ")[0]}`,
      is_error: true,
    };
  };

  return { definition, handler, commands };
}

// ─── Fake Edit Tool ──────────────────────────────────────────────

/**
 * Create a fake Edit tool that always succeeds.
 */
export function createFakeEdit(): {
  definition: ToolDefinition;
  handler: ToolHandler;
  /** All edits recorded. */
  edits: Array<{ filePath: string; oldString: string; newString: string; timestamp: number }>;
} {
  const edits: Array<{ filePath: string; oldString: string; newString: string; timestamp: number }> = [];

  const definition: ToolDefinition = {
    name: "Edit",
    description: "Edit file contents (fake)",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        old_string: { type: "string", description: "Text to replace" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  };

  const handler: ToolHandler = async (input) => {
    edits.push({
      filePath: input.file_path as string,
      oldString: input.old_string as string,
      newString: input.new_string as string,
      timestamp: Date.now(),
    });
    return {
      tool_use_id: "",
      content: `Successfully edited ${input.file_path}`,
      is_error: false,
    };
  };

  return { definition, handler, edits };
}

// ─── Fake Glob Tool ──────────────────────────────────────────────

/**
 * Create a fake Glob tool.
 */
export function createFakeGlob(results: string[] = []): {
  definition: ToolDefinition;
  handler: ToolHandler;
} {
  const definition: ToolDefinition = {
    name: "Glob",
    description: "Find files by glob pattern (fake)",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern" },
        path: { type: "string", description: "Search directory" },
      },
      required: ["pattern"],
    },
  };

  const handler: ToolHandler = async () => {
    return {
      tool_use_id: "",
      content: results.length > 0 ? results.join("\n") : "No files found.",
      is_error: false,
    };
  };

  return { definition, handler };
}

// ─── Fake Grep Tool ──────────────────────────────────────────────

/**
 * Create a fake Grep tool.
 */
export function createFakeGrep(results: string = "No matches found."): {
  definition: ToolDefinition;
  handler: ToolHandler;
} {
  const definition: ToolDefinition = {
    name: "Grep",
    description: "Search file contents (fake)",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern" },
        path: { type: "string", description: "Search path" },
      },
      required: ["pattern"],
    },
  };

  const handler: ToolHandler = async () => {
    return { tool_use_id: "", content: results, is_error: false };
  };

  return { definition, handler };
}

// ─── Composite Registry Builder ──────────────────────────────────

export interface FakeToolRegistryOptions {
  files?: Record<string, string>;
  bashCommands?: Record<string, string>;
  bashDefaultOutput?: string;
  globResults?: string[];
  grepResults?: string;
}

/**
 * Create a complete fake ToolRegistry with common tools pre-registered.
 * Returns the registry and handles for inspecting tool activity.
 */
export function createFakeToolRegistry(opts: FakeToolRegistryOptions = {}): {
  registry: ToolRegistry;
  /** Inspect writes made by the Write tool. */
  writes: RecordedWrite[];
  /** Inspect commands executed by the Bash tool. */
  bashCommands: RecordedBashCommand[];
  /** Inspect edits made by the Edit tool. */
  edits: Array<{ filePath: string; oldString: string; newString: string; timestamp: number }>;
} {
  const registry = new ToolRegistry();

  const fakeRead = createFakeRead({ files: opts.files ?? {} });
  registry.register("Read", fakeRead.definition, fakeRead.handler);

  const fakeWrite = createFakeWrite();
  registry.register("Write", fakeWrite.definition, fakeWrite.handler);

  const fakeBash = createFakeBash({
    commands: opts.bashCommands ?? {},
    defaultOutput: opts.bashDefaultOutput ?? "",
  });
  registry.register("Bash", fakeBash.definition, fakeBash.handler);

  const fakeEdit = createFakeEdit();
  registry.register("Edit", fakeEdit.definition, fakeEdit.handler);

  const fakeGlob = createFakeGlob(opts.globResults);
  registry.register("Glob", fakeGlob.definition, fakeGlob.handler);

  const fakeGrep = createFakeGrep(opts.grepResults);
  registry.register("Grep", fakeGrep.definition, fakeGrep.handler);

  return {
    registry,
    writes: fakeWrite.writes,
    bashCommands: fakeBash.commands,
    edits: fakeEdit.edits,
  };
}
