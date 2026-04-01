// KCode - Tool Registration
// Registers all built-in tools with the registry, plus MCP-discovered tools

import { getMcpManager, type McpManager } from "../core/mcp";
import { ToolRegistry } from "../core/tool-registry";
import { agentDefinition, executeAgent } from "./agent";
import { askUserDefinition, executeAskUser } from "./ask-user";
import { bashDefinition, executeBash } from "./bash";
import { browserDefinition, executeBrowser } from "./browser";
import { clipboardDefinition, executeClipboard } from "./clipboard-tool";
import {
  cronCreateDefinition,
  cronDeleteDefinition,
  cronListDefinition,
  executeCronCreate,
  executeCronDelete,
  executeCronList,
} from "./cron";
import { deployDefinition, executeDeploy } from "./deploy";
import { diffViewerDefinition, executeDiffViewer } from "./diff-viewer";
import { editDefinition, executeEdit } from "./edit";
import {
  executeGitCommit,
  executeGitLog,
  executeGitStatus,
  gitCommitDefinition,
  gitLogDefinition,
  gitStatusDefinition,
} from "./git-tools";
import { executeGlob, globDefinition } from "./glob";
import { executeGrep, grepDefinition } from "./grep";
import { executeGrepReplace, grepReplaceDefinition } from "./grep-replace";
import { executeImageGen, imageGenDefinition } from "./image-gen";
import { executeKulvex, kulvexDefinition } from "./kulvex";
import { executeLearn, learnDefinition } from "./learn";
import { executeLs, lsDefinition } from "./ls";
import { executeLsp, lspDefinition } from "./lsp-tool";
import {
  executeListMcpResources,
  executeReadMcpResource,
  listMcpResourcesDefinition,
  readMcpResourceDefinition,
} from "./mcp-tools";
import { executeMultiEdit, multiEditDefinition } from "./multi-edit";
import { executeNotebookEdit, notebookEditDefinition } from "./notebook";
import { executePlan, planDefinition } from "./plan";
import {
  enterPlanModeDefinition,
  executeEnterPlanMode,
  executeExitPlanMode,
  exitPlanModeDefinition,
} from "./plan-mode";
import { executeRead, readDefinition } from "./read";
import { executeRename, renameDefinition } from "./rename";
import { executeSendMessage, sendMessageDefinition } from "./send-message";
import { executeSkill, skillDefinition } from "./skill";
import { executeStash, stashDefinition } from "./stash";
import { executeSyntheticOutput, syntheticOutputDefinition } from "./synthetic-output";
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
import { executeTestRunner, testRunnerDefinition } from "./test-runner";
import { executeToolSearch, toolSearchDefinition } from "./tool-search";
import { executeUndo, undoDefinition } from "./undo";
import { executeWebFetch, webFetchDefinition } from "./web-fetch";
import { executeWebSearch, webSearchDefinition } from "./web-search";
import {
  enterWorktreeDefinition,
  executeEnterWorktree,
  executeExitWorktree,
  exitWorktreeDefinition,
} from "./worktree";
import { executeWrite, writeDefinition } from "./write";

/**
 * Register all built-in tools and optionally MCP-discovered tools.
 * If an McpManager is provided, its discovered tools are registered
 * dynamically after the built-in tools.
 */
export function registerBuiltinTools(mcpManager?: McpManager): ToolRegistry {
  const registry = new ToolRegistry();

  // Built-in tools
  registry.register("Bash", bashDefinition, executeBash);
  registry.register("Read", readDefinition, executeRead);
  registry.register("Write", writeDefinition, executeWrite);
  registry.register("Edit", editDefinition, executeEdit);
  registry.register("Glob", globDefinition, executeGlob);
  registry.register("Grep", grepDefinition, executeGrep);
  registry.register("Agent", agentDefinition, executeAgent);
  registry.register("WebFetch", webFetchDefinition, executeWebFetch);
  registry.register("WebSearch", webSearchDefinition, executeWebSearch);
  registry.register("NotebookEdit", notebookEditDefinition, executeNotebookEdit);
  registry.register("TaskCreate", taskCreateDefinition, executeTaskCreate);
  registry.register("TaskList", taskListDefinition, executeTaskList);
  registry.register("TaskGet", taskGetDefinition, executeTaskGet);
  registry.register("TaskUpdate", taskUpdateDefinition, executeTaskUpdate);
  registry.register("TaskStop", taskStopDefinition, executeTaskStop);

  // Learning / long-term memory
  registry.register("Learn", learnDefinition, executeLearn);

  // Kulvex bridge (Jarvis backend integration)
  registry.register("Kulvex", kulvexDefinition, executeKulvex);

  // Browser automation (Playwright)
  registry.register("Browser", browserDefinition, executeBrowser);

  // Image generation (cloud: Flux, DALL-E)
  registry.register("ImageGen", imageGenDefinition, executeImageGen);

  // Structured planning
  registry.register("Plan", planDefinition, executePlan);

  // Atomic multi-file editing
  registry.register("MultiEdit", multiEditDefinition, executeMultiEdit);

  // Skill execution (invoke slash commands programmatically)
  registry.register("Skill", skillDefinition, executeSkill);

  // Cron job management
  registry.register("CronList", cronListDefinition, executeCronList);
  registry.register("CronCreate", cronCreateDefinition, executeCronCreate);
  registry.register("CronDelete", cronDeleteDefinition, executeCronDelete);

  // Plan mode (read-only restriction)
  registry.register("EnterPlanMode", enterPlanModeDefinition, executeEnterPlanMode);
  registry.register("ExitPlanMode", exitPlanModeDefinition, executeExitPlanMode);

  // Worktree isolation
  registry.register("EnterWorktree", enterWorktreeDefinition, executeEnterWorktree);
  registry.register("ExitWorktree", exitWorktreeDefinition, executeExitWorktree);

  // Diff viewer
  registry.register("DiffView", diffViewerDefinition, executeDiffViewer);

  // Test runner
  registry.register("TestRunner", testRunnerDefinition, executeTestRunner);

  // Rename refactoring
  registry.register("Rename", renameDefinition, executeRename);

  // Clipboard
  registry.register("Clipboard", clipboardDefinition, executeClipboard);

  // Undo
  registry.register("Undo", undoDefinition, executeUndo);

  // Git tools
  registry.register("GitStatus", gitStatusDefinition, executeGitStatus);
  registry.register("GitCommit", gitCommitDefinition, executeGitCommit);
  registry.register("GitLog", gitLogDefinition, executeGitLog);

  // GrepReplace
  registry.register("GrepReplace", grepReplaceDefinition, executeGrepReplace);

  // Stash (conversation context snapshots)
  registry.register("Stash", stashDefinition, executeStash);

  // LSP code intelligence (go-to-definition, references, hover, symbols)
  registry.register("LSP", lspDefinition, executeLsp);

  // AskUser — structured user prompts
  registry.register("AskUser", askUserDefinition, executeAskUser);

  // SendMessage — one-way status messages to the user
  registry.register("SendMessage", sendMessageDefinition, executeSendMessage);

  // LS — fast directory listing
  registry.register("LS", lsDefinition, executeLs);

  // ToolSearch — deferred tool loading
  registry.register("ToolSearch", toolSearchDefinition, executeToolSearch);

  // Deploy — deploy automation (Pro)
  registry.register("Deploy", deployDefinition, executeDeploy);

  // SyntheticOutput — inject content into conversation stream
  registry.register("SyntheticOutput", syntheticOutputDefinition, executeSyntheticOutput);

  // MCP resource tools (always available, gracefully handle no servers)
  registry.register("ListMcpResources", listMcpResourcesDefinition, executeListMcpResources);
  registry.register("ReadMcpResource", readMcpResourceDefinition, executeReadMcpResource);

  // MCP server-discovered tools (registered dynamically)
  if (mcpManager) {
    mcpManager.registerTools(registry);
  }

  return registry;
}

/**
 * Initialize MCP servers and register their tools into an existing registry.
 * Call this after registerBuiltinTools() once the working directory is known.
 * This is async because it spawns MCP server processes and waits for tool discovery.
 */
export async function registerMcpTools(registry: ToolRegistry, cwd: string): Promise<void> {
  const manager = getMcpManager();
  try {
    await manager.loadAndStart(cwd);
    manager.registerTools(registry);

    const serverNames = manager.getServerNames();
    if (serverNames.length > 0) {
      const toolCount = registry.getToolNames().filter((n) => n.startsWith("mcp__")).length;
      console.error(
        `[MCP] Connected to ${serverNames.length} server(s), registered ${toolCount} tool(s)`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MCP] Failed to initialize MCP servers: ${msg}`);
  }
}
