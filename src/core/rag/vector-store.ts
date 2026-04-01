// KCode - Vector Store
// Stores embeddings in SQLite using BLOB for vectors.
// Brute-force cosine similarity search — sufficient for <100K chunks (<100ms).

import type { Database } from "bun:sqlite";
import type { CodeChunk, SearchFilters, SearchResult, VectorStoreStats } from "./types";

// ─── Cosine Similarity ─────────────────────────────────────────

/** Optimized cosine similarity for Float32Array */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Vector Store ──────────────────────────────────────────────

export class VectorStore {
  private db: Database;
  private dimensions: number;

  constructor(db: Database, dimensions: number) {
    this.db = db;
    this.dimensions = dimensions;
    this.createSchema();
  }

  /** Create the rag_chunks table if it doesn't exist */
  private createSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS rag_chunks (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      language TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      signature TEXT,
      start_line INTEGER,
      end_line INTEGER,
      embedding BLOB,
      token_estimate INTEGER,
      indexed_at TEXT DEFAULT (datetime('now')),
      file_modified_at TEXT
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_rag_file ON rag_chunks(file_path)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_rag_type ON rag_chunks(type)");
  }

  /** Insert or update chunks with embeddings */
  upsert(chunks: Array<CodeChunk & { embedding: number[] }>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO rag_chunks
      (id, file_path, relative_path, language, type, name, content, signature,
       start_line, end_line, embedding, token_estimate, file_modified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.transaction(() => {
      for (const chunk of chunks) {
        const embeddingBlob = Buffer.from(new Float32Array(chunk.embedding).buffer);
        stmt.run(
          chunk.id,
          chunk.filePath,
          chunk.relativePath,
          chunk.language,
          chunk.type,
          chunk.name,
          chunk.content,
          chunk.signature,
          chunk.startLine,
          chunk.endLine,
          embeddingBlob,
          chunk.tokenEstimate,
          new Date().toISOString(),
        );
      }
    });

    txn();
  }

  /** Semantic search: top-K chunks most similar to query embedding */
  search(queryEmbedding: number[], limit: number = 10, filters?: SearchFilters): SearchResult[] {
    let sql =
      "SELECT id, file_path, relative_path, name, type, content, start_line, end_line, embedding, token_estimate FROM rag_chunks";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.language) {
      conditions.push("language = ?");
      params.push(filters.language);
    }
    if (filters?.type) {
      conditions.push("type = ?");
      params.push(filters.type);
    }
    if (filters?.filePaths && filters.filePaths.length > 0) {
      conditions.push(`file_path IN (${filters.filePaths.map(() => "?").join(",")})`);
      params.push(...filters.filePaths);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      file_path: string;
      relative_path: string;
      name: string;
      type: CodeChunk["type"];
      content: string;
      start_line: number;
      end_line: number;
      embedding: Buffer;
      token_estimate: number;
    }>;

    const queryVec = new Float32Array(queryEmbedding);
    const scored: SearchResult[] = [];

    for (const row of rows) {
      if (!row.embedding || row.embedding.length === 0) continue;

      const embedding = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      const similarity = cosineSimilarity(queryVec, embedding);

      scored.push({
        chunkId: row.id,
        filePath: row.file_path,
        relativePath: row.relative_path,
        name: row.name,
        type: row.type,
        content: row.content,
        startLine: row.start_line,
        endLine: row.end_line,
        similarity,
        tokenEstimate: row.token_estimate,
      });
    }

    return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  /** Remove all chunks for a given file path */
  removeByFile(filePath: string): void {
    this.db.prepare("DELETE FROM rag_chunks WHERE file_path = ?").run(filePath);
  }

  /** Remove all chunks from the store */
  clear(): void {
    this.db.exec("DELETE FROM rag_chunks");
  }

  /** Get index statistics */
  stats(): VectorStoreStats {
    const row = this.db
      .prepare(`
      SELECT COUNT(*) as total,
             COUNT(DISTINCT file_path) as files,
             COALESCE(SUM(token_estimate), 0) as totalTokens
      FROM rag_chunks
    `)
      .get() as VectorStoreStats;
    return row;
  }

  /** Get the number of stored chunks */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM rag_chunks").get() as { cnt: number };
    return row.cnt;
  }
}
