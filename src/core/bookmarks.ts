// KCode - Session Bookmarks
// Mark and jump to points in conversation history

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { kcodePath } from "./paths";

const BOOKMARKS_DIR = kcodePath("bookmarks");

export interface Bookmark {
  label: string;
  messageIndex: number;
  timestamp: string;
  preview: string; // First 80 chars of the message at that point
}

function getBookmarksFile(sessionId: string): string {
  if (!existsSync(BOOKMARKS_DIR)) mkdirSync(BOOKMARKS_DIR, { recursive: true });
  return join(BOOKMARKS_DIR, `${sessionId}.json`);
}

function getSessionId(): string {
  // Use current date as session identifier
  return new Date().toISOString().slice(0, 10);
}

export function addBookmark(label: string, messageIndex: number, preview: string): Bookmark {
  const sessionId = getSessionId();
  const file = getBookmarksFile(sessionId);
  const bookmarks = loadBookmarks();

  const bookmark: Bookmark = {
    label,
    messageIndex,
    timestamp: new Date().toISOString(),
    preview: preview.slice(0, 80),
  };

  // Replace if same label exists
  const idx = bookmarks.findIndex(b => b.label === label);
  if (idx >= 0) bookmarks[idx] = bookmark;
  else bookmarks.push(bookmark);

  writeFileSync(file, JSON.stringify(bookmarks, null, 2), "utf-8");
  return bookmark;
}

export function loadBookmarks(): Bookmark[] {
  const sessionId = getSessionId();
  const file = getBookmarksFile(sessionId);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

export function getBookmark(label: string): Bookmark | null {
  const bookmarks = loadBookmarks();
  return bookmarks.find(b => b.label === label) ?? null;
}

export function removeBookmark(label: string): boolean {
  const sessionId = getSessionId();
  const file = getBookmarksFile(sessionId);
  const bookmarks = loadBookmarks();
  const filtered = bookmarks.filter(b => b.label !== label);
  if (filtered.length === bookmarks.length) return false;
  writeFileSync(file, JSON.stringify(filtered, null, 2), "utf-8");
  return true;
}
