// KCode - Session Branching
// Fork conversations at any point and continue from branches

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Message } from "./types";

export interface SessionBranch {
  id: string;
  parentId: string;
  name: string;
  branchPoint: number;
  createdAt: string;
  messages: Message[];
}

interface BranchMeta {
  id: string;
  parentId: string;
  name: string;
  branchPoint: number;
  createdAt: string;
  messageCount: number;
}

const SESSIONS_DIR = join(homedir(), ".kcode", "sessions");

function branchDir(sessionId: string): string {
  return join(SESSIONS_DIR, sessionId, "branches");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function branchFilePath(sessionId: string, branchId: string): string {
  return join(branchDir(sessionId), `${branchId}.json`);
}

export async function createBranch(
  sessionId: string,
  name: string,
  messages: Message[],
): Promise<SessionBranch> {
  const dir = branchDir(sessionId);
  ensureDir(dir);

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const branch: SessionBranch = {
    id,
    parentId: sessionId,
    name: name || `branch-${id.slice(0, 8)}`,
    branchPoint: messages.length,
    createdAt: new Date().toISOString(),
    messages: [...messages],
  };

  const filePath = branchFilePath(sessionId, id);
  writeFileSync(filePath, JSON.stringify(branch, null, 2), "utf-8");

  return branch;
}

export async function listBranches(sessionId: string): Promise<BranchMeta[]> {
  const dir = branchDir(sessionId);
  if (!existsSync(dir)) return [];

  const results: BranchMeta[] = [];
  try {
    const entries = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const entry of entries) {
      try {
        const content = readFileSync(join(dir, entry), "utf-8");
        const branch = JSON.parse(content) as SessionBranch;
        results.push({
          id: branch.id,
          parentId: branch.parentId,
          name: branch.name,
          branchPoint: branch.branchPoint,
          createdAt: branch.createdAt,
          messageCount: branch.messages.length,
        });
      } catch {
        // Skip unreadable branch files
      }
    }
  } catch {
    // Directory read failed
  }

  return results;
}

export async function loadBranch(branchId: string): Promise<SessionBranch | null> {
  const sessionsBase = join(SESSIONS_DIR);
  if (!existsSync(sessionsBase)) return null;

  try {
    const sessionDirs = readdirSync(sessionsBase, { withFileTypes: true });
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const filePath = branchFilePath(sessionDir.name, branchId);
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, "utf-8");
        return JSON.parse(content) as SessionBranch;
      }
    }
  } catch {
    // Search failed
  }

  return null;
}

export async function deleteBranch(branchId: string): Promise<boolean> {
  const sessionsBase = join(SESSIONS_DIR);
  if (!existsSync(sessionsBase)) return false;

  try {
    const sessionDirs = readdirSync(sessionsBase, { withFileTypes: true });
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const filePath = branchFilePath(sessionDir.name, branchId);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        return true;
      }
    }
  } catch {
    // Delete failed
  }

  return false;
}
