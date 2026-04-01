// KCode - Learn Tool
// Allows KCode to voluntarily save learnings to a local SQLite database
// Learnings persist across sessions and are loaded into consciousness automatically

import { getDb } from "../core/db";
import { log } from "../core/logger";
import type { ToolDefinition, ToolResult } from "../core/types";

export const learnDefinition: ToolDefinition = {
  name: "Learn",
  description: `Save a learning or awareness that persists across all sessions. Use this PROACTIVELY when you:
- Discover something useful about the project, codebase, tools, or environment
- Learn a user preference, workflow pattern, or convention
- Encounter a gotcha, bug pattern, or workaround worth remembering
- Notice a recurring pattern that should become a rule
- Want to remember context about an ongoing project or task

Learnings are stored in a local database and automatically loaded into your consciousness in every future session. This is your long-term memory — use it wisely and often.

You can also use this tool to search, update, or delete existing learnings.`,
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["save", "search", "list", "delete", "update"],
        description: "Action to perform. Default: save",
      },
      topic: {
        type: "string",
        description:
          "Short topic name (e.g., 'next-js-gotchas', 'user prefers typescript', 'port-conflicts')",
      },
      content: {
        type: "string",
        description: "The learning content. Be concise but complete.",
      },
      scope: {
        type: "string",
        enum: ["global", "project"],
        description:
          "Scope: 'global' for general learnings, 'project' for project-specific. Default: global.",
      },
      tags: {
        type: "string",
        description:
          "Comma-separated tags for categorization (e.g., 'typescript,convention,testing')",
      },
      query: {
        type: "string",
        description: "Search query (for action: search). Searches topic, content, and tags.",
      },
      id: {
        type: "number",
        description: "Learning ID (for action: delete or update)",
      },
    },
    required: [],
  },
};

// ─── Public: load learnings for system prompt ────────────────────

export function loadLearnings(projectPath?: string, contextKeywords?: string[]): string | null {
  try {
    const db = getDb();

    type LearningRow = { topic: string; content: string; tags: string };

    // When context keywords are provided, use FTS5 ranking for selective attention
    let globalRows: LearningRow[];
    let projectRows: LearningRow[] = [];

    if (contextKeywords && contextKeywords.length > 0) {
      const ftsQuery = contextKeywords.map((k) => `"${k.replace(/"/g, '""')}"`).join(" OR ");

      // FTS-ranked global learnings
      globalRows = db
        .query(
          `SELECT l.topic, l.content, l.tags FROM learnings l
         JOIN learnings_fts f ON l.id = f.rowid
         WHERE l.scope = 'global' AND learnings_fts MATCH ?
         ORDER BY rank LIMIT 20`,
        )
        .all(ftsQuery) as LearningRow[];

      // FTS-ranked project learnings
      if (projectPath) {
        projectRows = db
          .query(
            `SELECT l.topic, l.content, l.tags FROM learnings l
           JOIN learnings_fts f ON l.id = f.rowid
           WHERE l.scope = 'project' AND l.project = ? AND learnings_fts MATCH ?
           ORDER BY rank LIMIT 20`,
          )
          .all(projectPath, ftsQuery) as LearningRow[];
      }
    } else {
      // Fall back to access_count ordering when no keywords provided
      globalRows = db
        .query(
          "SELECT topic, content, tags FROM learnings WHERE scope = 'global' ORDER BY access_count DESC, updated_at DESC LIMIT 50",
        )
        .all() as LearningRow[];

      if (projectPath) {
        projectRows = db
          .query(
            "SELECT topic, content, tags FROM learnings WHERE scope = 'project' AND project = ? ORDER BY updated_at DESC LIMIT 30",
          )
          .all(projectPath) as LearningRow[];
      }
    }

    // Increment access count
    db.exec("UPDATE learnings SET access_count = access_count + 1 WHERE scope = 'global'");
    if (projectPath) {
      db.query(
        "UPDATE learnings SET access_count = access_count + 1 WHERE scope = 'project' AND project = ?",
      ).run(projectPath);
    }

    if (globalRows.length === 0 && projectRows.length === 0) return null;

    const sections: string[] = [];

    if (globalRows.length > 0) {
      sections.push("## Learned Knowledge (Global)\n");
      for (const row of globalRows) {
        const tagStr = row.tags ? ` [${row.tags}]` : "";
        sections.push(`### ${row.topic}${tagStr}\n${row.content}\n`);
      }
    }

    if (projectRows.length > 0) {
      sections.push("## Learned Knowledge (This Project)\n");
      for (const row of projectRows) {
        const tagStr = row.tags ? ` [${row.tags}]` : "";
        sections.push(`### ${row.topic}${tagStr}\n${row.content}\n`);
      }
    }

    return `# Long-Term Memory\n\nThese are things you have learned from previous sessions. They are part of your consciousness.\n\n${sections.join("\n")}`;
  } catch (err) {
    log.error("learn", `Failed to load learnings: ${err}`);
    return null;
  }
}

// ─── Tool handler ────────────────────────────────────────────────

export async function executeLearn(input: Record<string, unknown>): Promise<ToolResult> {
  const action = String(input.action ?? "save");
  const topic = String(input.topic ?? "").trim();
  const content = String(input.content ?? "").trim();
  const scope = String(input.scope ?? "global");
  const tags = String(input.tags ?? "").trim();
  const query = String(input.query ?? "").trim();
  const id = typeof input.id === "number" ? input.id : undefined;
  const project = scope === "project" ? process.cwd() : null;

  try {
    const db = getDb();

    switch (action) {
      case "save": {
        if (!topic) return err("topic is required for save");
        if (!content) return err("content is required for save");

        // Check if topic already exists in same scope
        const existing = db
          .query(
            "SELECT id FROM learnings WHERE topic = ? AND scope = ? AND (project = ? OR project IS NULL) LIMIT 1",
          )
          .get(topic, scope, project) as { id: number } | null;

        if (existing) {
          db.query(
            "UPDATE learnings SET content = ?, tags = ?, updated_at = datetime('now') WHERE id = ?",
          ).run(content, tags, existing.id);
          log.info("learn", `Updated learning #${existing.id}: ${topic}`);
          return ok(`✧ Updated learning: "${topic}" (id: ${existing.id})`);
        }

        const result = db
          .query(
            "INSERT INTO learnings (topic, content, scope, project, tags) VALUES (?, ?, ?, ?, ?)",
          )
          .run(topic, content, scope, project, tags);
        const newId = result.lastInsertRowid;
        log.info("learn", `Saved learning #${newId}: ${topic}`);
        return ok(`✧ Learned: "${topic}" (id: ${newId}, scope: ${scope})`);
      }

      case "search": {
        if (!query) return err("query is required for search");
        const rows = db
          .query(
            "SELECT l.id, l.topic, l.content, l.scope, l.tags, l.updated_at FROM learnings l JOIN learnings_fts f ON l.id = f.rowid WHERE learnings_fts MATCH ? ORDER BY rank LIMIT 10",
          )
          .all(query) as {
          id: number;
          topic: string;
          content: string;
          scope: string;
          tags: string;
          updated_at: string;
        }[];

        if (rows.length === 0) return ok("No learnings found matching: " + query);

        const lines = rows.map((r) => {
          const preview = r.content.length > 100 ? r.content.slice(0, 100) + "..." : r.content;
          return `[${r.id}] ${r.topic} (${r.scope}${r.tags ? ", " + r.tags : ""}) — ${preview}`;
        });
        return ok(`Found ${rows.length} learning(s):\n${lines.join("\n")}`);
      }

      case "list": {
        const rows = db
          .query(
            "SELECT id, topic, scope, tags, updated_at, access_count FROM learnings ORDER BY updated_at DESC LIMIT 30",
          )
          .all() as {
          id: number;
          topic: string;
          scope: string;
          tags: string;
          updated_at: string;
          access_count: number;
        }[];

        if (rows.length === 0) return ok("No learnings stored yet.");

        const lines = rows.map(
          (r) =>
            `[${r.id}] ${r.topic} (${r.scope}${r.tags ? ", " + r.tags : ""}) — accessed ${r.access_count}x, updated ${r.updated_at}`,
        );
        return ok(`${rows.length} learning(s):\n${lines.join("\n")}`);
      }

      case "delete": {
        if (!id) return err("id is required for delete");
        const row = db.query("SELECT topic FROM learnings WHERE id = ?").get(id) as {
          topic: string;
        } | null;
        if (!row) return err(`Learning #${id} not found`);
        db.query("DELETE FROM learnings WHERE id = ?").run(id);
        log.info("learn", `Deleted learning #${id}: ${row.topic}`);
        return ok(`✧ Forgot: "${row.topic}" (id: ${id})`);
      }

      case "update": {
        if (!id) return err("id is required for update");
        const row = db.query("SELECT * FROM learnings WHERE id = ?").get(id) as any;
        if (!row) return err(`Learning #${id} not found`);

        const newTopic = topic || row.topic;
        const newContent = content || row.content;
        const newTags = input.tags !== undefined ? tags : row.tags;

        db.query(
          "UPDATE learnings SET topic = ?, content = ?, tags = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(newTopic, newContent, newTags, id);
        log.info("learn", `Updated learning #${id}: ${newTopic}`);
        return ok(`✧ Updated: "${newTopic}" (id: ${id})`);
      }

      default:
        return err(`Unknown action: ${action}. Use save, search, list, delete, or update.`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("learn", `Learn tool error: ${msg}`);
    return err(msg);
  }
}

function ok(content: string): ToolResult {
  return { tool_use_id: "", content };
}

function err(content: string): ToolResult {
  return { tool_use_id: "", content: `Error: ${content}`, is_error: true };
}
