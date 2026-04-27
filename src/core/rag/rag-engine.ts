// KCode - RAG Engine (Pipeline Orchestrator)
// Orchestrates the chunk → embed → store → search pipeline
// Uses code-chunker for splitting, pluggable embedder, and SQLite vector store.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { log } from "../logger";
import { chunkFile } from "./code-chunker";
import type { EmbedderInterface } from "./embedder";
import { RagVectorStore } from "./vector-store";

// ─── Types ──────────────────────────────────────────────────────

export interface RagResult {
  filepath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  score: number;
  chunkType: string;
  name: string;
}

export interface IndexStats {
  filesProcessed: number;
  chunksCreated: number;
  duration: number;
  errors: string[];
}

export interface IndexDirectoryOptions {
  extensions?: string[];
  ignore?: string[];
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".cc",
  ".h",
  ".hpp",
];

const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  "coverage",
];

// ─── RagEngine ──────────────────────────────────────────────────

export class RagEngine {
  private store: RagVectorStore;
  private embedder: EmbedderInterface;

  constructor(embedder: EmbedderInterface, db: Database) {
    this.embedder = embedder;
    this.store = new RagVectorStore(db);
  }

  /**
   * Index a single file: chunk → embed → store.
   * Returns the number of chunks created.
   * Incremental: skips files whose checksum hasn't changed.
   */
  async indexFile(filepath: string): Promise<number> {
    try {
      const content = readFileSync(filepath, "utf-8");
      const checksum = createHash("md5").update(content).digest("hex");

      // Skip if unchanged
      if (!this.store.isFileStale(filepath, checksum)) {
        return 0;
      }

      // Remove old vectors for this file
      this.store.deleteByFilepath(filepath);

      const chunks = chunkFile(filepath, content);
      if (chunks.length === 0) return 0;

      // Batch embed
      const texts = chunks.map((c) => c.content);
      const embeddings = await this.embedder.embedBatch(texts);

      for (let i = 0; i < chunks.length; i++) {
        const emb = embeddings[i];
        if (emb && emb.length > 0) {
          this.store.insert(chunks[i]!, emb, checksum);
        }
      }

      return chunks.length;
    } catch (err) {
      log.warn("rag", `Failed to index ${filepath}: ${err}`);
      throw err;
    }
  }

  /**
   * Index an entire directory recursively.
   */
  async indexDirectory(dir: string, options?: IndexDirectoryOptions): Promise<IndexStats> {
    const start = Date.now();
    const extensions = new Set(options?.extensions ?? DEFAULT_EXTENSIONS);
    const ignore = new Set(options?.ignore ?? DEFAULT_IGNORE);
    const errors: string[] = [];
    let filesProcessed = 0;
    let chunksCreated = 0;

    const walk = async (current: string): Promise<void> => {
      let entries: string[];
      try {
        entries = readdirSync(current);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (ignore.has(entry)) continue;
        const fullPath = join(current, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          await walk(fullPath);
        } else if (stat.isFile()) {
          const ext = extname(entry).toLowerCase();
          if (!extensions.has(ext)) continue;
          // Skip very large files (>500KB)
          if (stat.size > 500_000) continue;

          try {
            const count = await this.indexFile(fullPath);
            filesProcessed++;
            chunksCreated += count;
          } catch (err) {
            errors.push(`${fullPath}: ${err}`);
          }
        }
      }
    };

    await walk(dir);

    const duration = Date.now() - start;
    log.info("rag", `Indexed ${filesProcessed} files, ${chunksCreated} chunks in ${duration}ms`);

    return { filesProcessed, chunksCreated, duration, errors };
  }

  /**
   * Search the RAG index for chunks relevant to a query.
   */
  async search(query: string, topK: number = 10): Promise<RagResult[]> {
    const queryEmbedding = await this.embedder.embed(query);
    if (queryEmbedding.length === 0) return [];

    const results = this.store.search(queryEmbedding, topK);
    return results.map((r) => ({
      filepath: r.filepath,
      lineStart: r.lineStart,
      lineEnd: r.lineEnd,
      content: r.content,
      score: r.score,
      chunkType: r.chunkType,
      name: r.name,
    }));
  }

  /**
   * Format search results as context for injection into the system prompt.
   */
  formatAsContext(results: RagResult[]): string {
    if (results.length === 0) return "";

    const lines: string[] = ["## Relevant Code Context (RAG)", ""];
    for (const r of results) {
      lines.push(
        `### ${r.name} (${r.chunkType}) — ${r.filepath}:${r.lineStart}-${r.lineEnd} [score: ${r.score.toFixed(3)}]`,
      );
      lines.push("```");
      lines.push(r.content);
      lines.push("```");
      lines.push("");
    }
    return lines.join("\n");
  }

  /**
   * Get the underlying vector store (for status/stats queries).
   */
  getStore(): RagVectorStore {
    return this.store;
  }
}
