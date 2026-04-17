// KCode - Knowledge Distillation (RAG-based)
//
// STATUS: Auxiliary (see docs/architecture/modules.md).
// Specialized agentic-dev workflow. Not required by the audit
// engine. Safe to remove — distilled examples just won't be
// injected into the system prompt.
//
// Captures successful interaction patterns and replays them as
// few-shot context. No fine-tuning required — the model "learns"
// from better examples in its prompt.

import { getDb } from "./db";
import { log } from "./logger";
import type { ContentBlock, Message, ToolUseBlock } from "./types";

// ─── Types ───────────────────────────────────────────────────────

export interface DistilledExample {
  id: number;
  /** The user's original request */
  userQuery: string;
  /** The assistant's final text response */
  assistantResponse: string;
  /** Serialized tool chain: [{name, input_summary, success}] */
  toolChain: string;
  /** Number of tool calls in the interaction */
  toolCount: number;
  /** Whether the interaction completed without errors */
  success: boolean;
  /** Project path where this happened */
  project: string;
  /** Tags for retrieval (e.g., "git,edit,typescript") */
  tags: string;
  /** Quality score: starts at 1.0, decays or grows based on reuse */
  quality: number;
  /** How many times this example has been used in prompts */
  useCount: number;
  createdAt: string;
}

interface ToolStep {
  name: string;
  inputSummary: string;
  success: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

const MAX_QUERY_LEN = 500;
const MAX_RESPONSE_LEN = 2000;
const MAX_TOOL_CHAIN_LEN = 4000;
const MAX_EXAMPLES_IN_PROMPT = 5;
const MAX_STORED_EXAMPLES = 500;
const MIN_QUALITY_THRESHOLD = 0.3;

// Schema is initialized in db.ts (initSchema)

// ─── Extraction ─────────────────────────────────────────────────

/**
 * Extract a distillable example from a completed interaction.
 * Returns null if the interaction isn't worth saving (too short, all errors, etc.)
 */
export function extractExample(messages: Message[], project: string): DistilledExample | null {
  // Find the last user text message (the query)
  let userQuery = "";
  let queryIdx = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "user" && typeof msg.content === "string") {
      // Skip system injections
      if (msg.content.startsWith("[SYSTEM]")) continue;
      userQuery = msg.content;
      queryIdx = i;
      break;
    }
  }

  if (!userQuery || queryIdx === -1) return null;

  // Skip very short or trivial queries
  if (userQuery.length < 10) return null;

  // Collect tool chain and final response from messages after the query
  const toolSteps: ToolStep[] = [];
  let assistantResponse = "";
  let hasErrors = false;

  for (let i = queryIdx + 1; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          // Keep the last assistant text as the response
          assistantResponse = block.text;
        }
        if (block.type === "tool_use") {
          const tb = block as ToolUseBlock;
          toolSteps.push({
            name: tb.name,
            inputSummary: summarizeToolInput(tb.name, tb.input),
            success: true, // will be updated by tool_result
          });
        }
      }
    }

    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "tool_result") {
          // Find the matching tool step and update success
          const lastPending = toolSteps.findLast((s) => s.success);
          if (lastPending && block.is_error) {
            lastPending.success = false;
            hasErrors = true;
          }
        }
      }
    }
  }

  // Skip if no response or all tools errored
  if (!assistantResponse) return null;
  const successCount = toolSteps.filter((s) => s.success).length;
  const errorCount = toolSteps.filter((s) => !s.success).length;

  // Skip if more than half the tools errored (bad interaction)
  if (toolSteps.length > 0 && errorCount > successCount) return null;

  // Generate tags from tool names and query content
  const tags = generateTags(userQuery, toolSteps);

  return {
    id: 0,
    userQuery: userQuery.slice(0, MAX_QUERY_LEN),
    assistantResponse: assistantResponse.slice(0, MAX_RESPONSE_LEN),
    toolChain: JSON.stringify(toolSteps).slice(0, MAX_TOOL_CHAIN_LEN),
    toolCount: toolSteps.length,
    success: !hasErrors,
    project,
    tags,
    quality: hasErrors ? 0.7 : 1.0,
    useCount: 0,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Summarize tool input for compact storage.
 * We don't want to store full file contents, just the key parameters.
 */
function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return String(input.command ?? "").slice(0, 150);
    case "Read":
      return String(input.file_path ?? "");
    case "Write":
      return `${input.file_path} (${String(input.content ?? "").length} chars)`;
    case "Edit":
      return `${input.file_path} (replace ${String(input.old_string ?? "").length} → ${String(input.new_string ?? "").length} chars)`;
    case "Glob":
      return `${input.pattern}${input.path ? ` in ${input.path}` : ""}`;
    case "Grep":
      return `/${input.pattern}/${input.path ? ` in ${input.path}` : ""}`;
    case "WebSearch":
      return String(input.query ?? "");
    case "WebFetch":
      return String(input.url ?? "");
    case "Learn":
      return `${input.action ?? "save"}: ${input.topic ?? ""}`;
    default:
      return JSON.stringify(input).slice(0, 100);
  }
}

/**
 * Generate retrieval tags from the query and tool usage.
 */
function generateTags(query: string, tools: ToolStep[]): string {
  const tags = new Set<string>();

  // Tool-based tags
  for (const t of tools) {
    tags.add(t.name.toLowerCase());
  }

  // Query-based keyword extraction (simple)
  const keywords = [
    "git",
    "commit",
    "push",
    "pull",
    "branch",
    "merge",
    "rebase",
    "test",
    "debug",
    "fix",
    "bug",
    "error",
    "create",
    "build",
    "deploy",
    "install",
    "refactor",
    "rename",
    "move",
    "delete",
    "api",
    "endpoint",
    "route",
    "server",
    "database",
    "sql",
    "query",
    "typescript",
    "javascript",
    "python",
    "rust",
    "go",
    "react",
    "next",
    "vue",
    "angular",
    "docker",
    "kubernetes",
    "ci",
    "cd",
    "css",
    "html",
    "style",
    "ui",
    "config",
    "env",
    "setup",
  ];

  const lowerQuery = query.toLowerCase();
  for (const kw of keywords) {
    if (lowerQuery.includes(kw)) tags.add(kw);
  }

  return [...tags].join(",");
}

// ─── Storage ────────────────────────────────────────────────────

/**
 * Save a distilled example to the database.
 * Deduplicates by checking for similar queries (FTS match + quality comparison).
 */
export function saveExample(example: DistilledExample): number | null {
  try {
    const db = getDb();

    // Check for duplicate: same query (exact or very similar)
    const existing = db
      .query("SELECT id, quality, tool_count FROM distilled_examples WHERE user_query = ? LIMIT 1")
      .get(example.userQuery) as { id: number; quality: number; tool_count: number } | null;

    if (existing) {
      // Update if new example is better quality or has more tools (richer interaction)
      if (example.quality > existing.quality || example.toolCount > existing.tool_count) {
        db.query(
          `UPDATE distilled_examples SET
            assistant_response = ?, tool_chain = ?, tool_count = ?,
            success = ?, tags = ?, quality = ?, created_at = datetime('now')
          WHERE id = ?`,
        ).run(
          example.assistantResponse,
          example.toolChain,
          example.toolCount,
          example.success ? 1 : 0,
          example.tags,
          example.quality,
          existing.id,
        );
        log.info(
          "distill",
          `Updated example #${existing.id}: "${example.userQuery.slice(0, 50)}..."`,
        );
        return existing.id;
      }
      return null; // existing is better, skip
    }

    // Insert new
    const result = db
      .query(
        `INSERT INTO distilled_examples
        (user_query, assistant_response, tool_chain, tool_count, success, project, tags, quality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        example.userQuery,
        example.assistantResponse,
        example.toolChain,
        example.toolCount,
        example.success ? 1 : 0,
        example.project,
        example.tags,
        example.quality,
      );

    const newId = Number(result.lastInsertRowid);
    log.info("distill", `Saved example #${newId}: "${example.userQuery.slice(0, 50)}..."`);

    // Prune if over limit
    pruneExamples();

    return newId;
  } catch (err) {
    log.error("distill", `Failed to save example: ${err}`);
    return null;
  }
}

/**
 * Keep the database under MAX_STORED_EXAMPLES by removing lowest-quality entries.
 */
function pruneExamples(): void {
  try {
    const db = getDb();
    const count = (db.query("SELECT COUNT(*) as n FROM distilled_examples").get() as { n: number })
      .n;

    if (count > MAX_STORED_EXAMPLES) {
      const excess = count - MAX_STORED_EXAMPLES;
      db.query(
        `DELETE FROM distilled_examples WHERE id IN (
          SELECT id FROM distilled_examples ORDER BY quality ASC, use_count ASC, created_at ASC LIMIT ?
        )`,
      ).run(excess);
      log.info("distill", `Pruned ${excess} low-quality examples`);
    }
  } catch (err) {
    log.error("distill", `Failed to prune examples: ${err}`);
  }
}

// ─── Retrieval (for system prompt injection) ────────────────────

/**
 * Load relevant distilled examples for the current query context.
 * Uses FTS5 ranking + quality scoring to select the best few-shot examples.
 */
export async function loadDistilledExamples(
  currentQuery?: string,
  contextKeywords?: string[],
  project?: string,
): Promise<string | null> {
  const { isPro } = await import("./pro.js");
  if (!(await isPro())) return null; // Silently skip — not a hard gate, just a premium enhancement

  try {
    const db = getDb();

    // Check if table exists (first run)
    const tableExists = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='distilled_examples'")
      .get();
    if (!tableExists) return null;

    type ExampleRow = {
      id: number;
      user_query: string;
      assistant_response: string;
      tool_chain: string;
      tool_count: number;
      quality: number;
    };

    let rows: ExampleRow[] = [];

    // Strategy 1: FTS match against current query
    if (currentQuery && currentQuery.length > 5) {
      // Build FTS query from important words in the current query
      const ftsTerms = currentQuery
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 8)
        .map((w) => `"${w}"`)
        .join(" OR ");

      if (ftsTerms) {
        rows = db
          .query(
            `SELECT e.id, e.user_query, e.assistant_response, e.tool_chain, e.tool_count, e.quality
           FROM distilled_examples e
           JOIN distilled_fts f ON e.id = f.rowid
           WHERE distilled_fts MATCH ? AND e.quality >= ?
           ORDER BY rank * e.quality DESC
           LIMIT ?`,
          )
          .all(ftsTerms, MIN_QUALITY_THRESHOLD, MAX_EXAMPLES_IN_PROMPT) as ExampleRow[];
      }
    }

    // Strategy 2: If FTS found nothing, use keyword-based tag matching
    if (rows.length === 0 && contextKeywords && contextKeywords.length > 0) {
      const tagPattern = contextKeywords.slice(0, 5).join("%");
      rows = db
        .query(
          `SELECT id, user_query, assistant_response, tool_chain, tool_count, quality
         FROM distilled_examples
         WHERE tags LIKE ? AND quality >= ?
         ORDER BY quality DESC, use_count DESC
         LIMIT ?`,
        )
        .all(`%${tagPattern}%`, MIN_QUALITY_THRESHOLD, MAX_EXAMPLES_IN_PROMPT) as ExampleRow[];
    }

    // Strategy 3: Fall back to highest quality project-specific examples
    if (rows.length === 0 && project) {
      rows = db
        .query(
          `SELECT id, user_query, assistant_response, tool_chain, tool_count, quality
         FROM distilled_examples
         WHERE project = ? AND quality >= ?
         ORDER BY quality DESC, use_count DESC
         LIMIT ?`,
        )
        .all(project, MIN_QUALITY_THRESHOLD, MAX_EXAMPLES_IN_PROMPT) as ExampleRow[];
    }

    // Strategy 4: Global best examples
    if (rows.length === 0) {
      rows = db
        .query(
          `SELECT id, user_query, assistant_response, tool_chain, tool_count, quality
         FROM distilled_examples
         WHERE quality >= ?
         ORDER BY quality DESC, use_count DESC
         LIMIT ?`,
        )
        .all(MIN_QUALITY_THRESHOLD, 3) as ExampleRow[];
    }

    if (rows.length === 0) return null;

    // Increment use_count for selected examples (parameterized to prevent SQL injection)
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    db.query(
      `UPDATE distilled_examples SET use_count = use_count + 1 WHERE id IN (${placeholders})`,
    ).run(...ids);

    // Format as few-shot context
    const sections: string[] = [];
    for (const row of rows) {
      let toolSummary = "";
      try {
        const chain = JSON.parse(row.tool_chain) as ToolStep[];
        if (chain.length > 0) {
          const steps = chain.map((s) => `${s.name}(${s.inputSummary.slice(0, 60)})`);
          toolSummary = `\nTools used: ${steps.join(" → ")}`;
        }
      } catch {
        /* ignore */
      }

      sections.push(
        `**User**: ${row.user_query.slice(0, 300)}${toolSummary}\n**Response pattern**: ${row.assistant_response.slice(0, 500)}`,
      );
    }

    return `# Learned Interaction Patterns

The following are examples of successful past interactions. Use them as reference for similar tasks — match the tool selection, approach, and response style.

${sections.join("\n\n---\n\n")}`;
  } catch (err) {
    log.error("distill", `Failed to load distilled examples: ${err}`);
    return null;
  }
}

// ─── Quality Feedback ────────────────────────────────────────────

/**
 * Boost quality of an example (called when the user doesn't correct the response).
 */
export function boostExample(id: number, amount = 0.1): void {
  try {
    const db = getDb();
    db.query("UPDATE distilled_examples SET quality = MIN(quality + ?, 2.0) WHERE id = ?").run(
      amount,
      id,
    );
  } catch {
    /* ignore */
  }
}

/**
 * Penalize quality of an example (called when the user corrects or undoes).
 */
export function penalizeExample(id: number, amount = 0.3): void {
  try {
    const db = getDb();
    db.query("UPDATE distilled_examples SET quality = MAX(quality - ?, 0.0) WHERE id = ?").run(
      amount,
      id,
    );
  } catch {
    /* ignore */
  }
}

// ─── Stats ──────────────────────────────────────────────────────

export function getDistillationStats(): {
  totalExamples: number;
  avgQuality: number;
  totalUses: number;
  topTags: string[];
} {
  try {
    const db = getDb();
    const stats = db
      .query(
        "SELECT COUNT(*) as total, AVG(quality) as avg_q, SUM(use_count) as total_uses FROM distilled_examples",
      )
      .get() as { total: number; avg_q: number; total_uses: number };

    const tagRows = db
      .query("SELECT tags FROM distilled_examples WHERE tags != '' ORDER BY quality DESC LIMIT 20")
      .all() as { tags: string }[];

    const tagCounts = new Map<string, number>();
    for (const row of tagRows) {
      for (const tag of row.tags.split(",")) {
        if (tag) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag]) => tag);

    return {
      totalExamples: stats.total,
      avgQuality: Math.round((stats.avg_q ?? 0) * 100) / 100,
      totalUses: stats.total_uses ?? 0,
      topTags,
    };
  } catch {
    return { totalExamples: 0, avgQuality: 0, totalUses: 0, topTags: [] };
  }
}
