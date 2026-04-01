// KCode - Persistent Conversation Branch Manager
// Tracks fork/branch relationships in SQLite for cross-session tree navigation

import { getDb } from "./db.js";

// ─── Types ───────────────────────────────────────────────────

export interface BranchInfo {
  id: string;
  parentId: string | null;
  label: string;
  sessionFile: string;
  createdAt: string;
  messageCount: number;
  status: string;
}

export interface BranchTreeNode extends BranchInfo {
  children: BranchTreeNode[];
}

export type BranchTree = BranchTreeNode[];

// ─── BranchManager ──────────────────────────────────────────

export class BranchManager {
  /**
   * Save a branch point when forking.
   */
  saveBranch(
    id: string,
    parentId: string | null,
    label: string,
    sessionFile: string,
    messageCount = 0,
  ): void {
    const db = getDb();
    db.run(
      `INSERT OR REPLACE INTO conversation_branches (id, parent_id, label, session_file, created_at, message_count, status)
       VALUES (?, ?, ?, ?, datetime('now'), ?, 'active')`,
      [id, parentId, label, sessionFile, messageCount],
    );
  }

  /**
   * List all branches, newest first.
   */
  listBranches(): BranchInfo[] {
    const db = getDb();
    const rows = db
      .query(
        `SELECT id, parent_id, label, session_file, created_at, message_count, status
       FROM conversation_branches
       WHERE status != 'deleted'
       ORDER BY created_at DESC`,
      )
      .all() as Array<{
      id: string;
      parent_id: string | null;
      label: string;
      session_file: string;
      created_at: string;
      message_count: number;
      status: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      label: r.label,
      sessionFile: r.session_file,
      createdAt: r.created_at,
      messageCount: r.message_count,
      status: r.status,
    }));
  }

  /**
   * Get branch tree — roots are branches with no parent.
   * Returns a forest of trees (multiple roots possible).
   */
  getBranchTree(): BranchTree {
    const all = this.listBranches();
    const byId = new Map<string, BranchTreeNode>();
    const roots: BranchTreeNode[] = [];

    // Create nodes
    for (const b of all) {
      byId.set(b.id, { ...b, children: [] });
    }

    // Link children to parents
    for (const node of byId.values()) {
      if (node.parentId && byId.has(node.parentId)) {
        byId.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  /**
   * Label/rename a branch.
   */
  labelBranch(id: string, label: string): void {
    const db = getDb();
    db.run(`UPDATE conversation_branches SET label = ? WHERE id = ?`, [label, id]);
  }

  /**
   * Get info for a single branch.
   */
  getBranch(id: string): BranchInfo | null {
    const db = getDb();
    const row = db
      .query(
        `SELECT id, parent_id, label, session_file, created_at, message_count, status
       FROM conversation_branches WHERE id = ?`,
      )
      .get(id) as {
      id: string;
      parent_id: string | null;
      label: string;
      session_file: string;
      created_at: string;
      message_count: number;
      status: string;
    } | null;

    if (!row) return null;

    return {
      id: row.id,
      parentId: row.parent_id,
      label: row.label,
      sessionFile: row.session_file,
      createdAt: row.created_at,
      messageCount: row.message_count,
      status: row.status,
    };
  }

  /**
   * Soft-delete a branch (mark as deleted, transcript file remains).
   * Reparents children to the deleted branch's parent to avoid orphans.
   */
  deleteBranch(id: string): void {
    const db = getDb();
    // Get the parent of the branch being deleted
    const branch = this.getBranch(id);
    const newParent = branch?.parentId ?? null;
    // Reparent children to the deleted branch's parent
    db.run(
      `UPDATE conversation_branches SET parent_id = ? WHERE parent_id = ? AND status != 'deleted'`,
      [newParent, id],
    );
    // Mark as deleted
    db.run(`UPDATE conversation_branches SET status = 'deleted' WHERE id = ?`, [id]);
  }

  /**
   * Update the message count for a branch.
   */
  updateMessageCount(id: string, count: number): void {
    const db = getDb();
    db.run(`UPDATE conversation_branches SET message_count = ? WHERE id = ?`, [count, id]);
  }

  /**
   * Find a branch by its session file name.
   */
  findBySessionFile(sessionFile: string): BranchInfo | null {
    const db = getDb();
    const row = db
      .query(
        `SELECT id, parent_id, label, session_file, created_at, message_count, status
       FROM conversation_branches WHERE session_file = ? AND status != 'deleted'`,
      )
      .get(sessionFile) as {
      id: string;
      parent_id: string | null;
      label: string;
      session_file: string;
      created_at: string;
      message_count: number;
      status: string;
    } | null;

    if (!row) return null;

    return {
      id: row.id,
      parentId: row.parent_id,
      label: row.label,
      sessionFile: row.session_file,
      createdAt: row.created_at,
      messageCount: row.message_count,
      status: row.status,
    };
  }
}

// ─── Singleton ──────────────────────────────────────────────

let _branchManager: BranchManager | null = null;

export function getBranchManager(): BranchManager {
  if (!_branchManager) {
    _branchManager = new BranchManager();
  }
  return _branchManager;
}

// ─── Tree Formatting ────────────────────────────────────────

/**
 * Format a branch tree as an indented text display.
 */
export function formatBranchTree(tree: BranchTree, indent = 0): string[] {
  const lines: string[] = [];
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i]!;
    const isLast = i === tree.length - 1;
    const prefix = indent === 0 ? "" : "  ".repeat(indent - 1) + (isLast ? "  └─ " : "  ├─ ");
    const label = node.label || node.sessionFile.slice(0, 40);
    const date = node.createdAt.replace(/T/g, " ").slice(0, 16);
    const status = node.status === "active" ? "" : ` [${node.status}]`;
    const icon = node.children.length > 0 ? "⑂" : "●";
    lines.push(`${prefix}${icon} ${label}  (${date}, ${node.messageCount} msgs)${status}`);
    if (node.children.length > 0) {
      lines.push(...formatBranchTree(node.children, indent + 1));
    }
  }
  return lines;
}
