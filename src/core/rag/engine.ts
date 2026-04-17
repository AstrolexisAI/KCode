// KCode - Local RAG Engine
//
// STATUS: Auxiliary (see docs/architecture/modules.md).
// Useful for agentic dev workflows; NOT required by the audit
// engine. Safe to disable / remove without breaking core audit.
//
// Orchestrates embedding, chunking, vector storage, and semantic
// search. Runs entirely locally — no external APIs required
// (TF-IDF fallback).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative } from "node:path";
import { getDb } from "../db";
import { log } from "../logger";
import { CodeChunker } from "./chunker";
import { Embedder } from "./embedder";
import { DEFAULT_RERANKER_CONFIG, rerank } from "./reranker";
import type {
  CodeChunk,
  DEFAULT_RAG_CONFIG,
  IndexReport,
  RAGConfig,
  RAGSearchOptions,
  RerankerConfig,
  SearchResult,
  VectorStoreStats,
} from "./types";
import { VectorStore } from "./vector-store";

// ─── Constants ─────────────────────────────────────────────────

const INDEXABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".vue",
  ".svelte",
]);

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "__pycache__",
  "venv",
  ".next",
  ".nuxt",
  "target",
  "vendor",
  ".kcode",
  ".vscode",
  ".idea",
  "coverage",
  "data",
]);

const MAX_FILE_SIZE = 100_000; // 100KB
const MAX_FILES = 5_000;

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".vue": "vue",
  ".svelte": "svelte",
};

// ─── File Info ─────────────────────────────────────────────────

interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

// ─── RAG Engine ────────────────────────────────────────────────

export class RAGEngine {
  private embedder: Embedder;
  private chunker: CodeChunker;
  private vectorStore: VectorStore | null = null;
  private rerankerConfig: RerankerConfig;
  private indexing: boolean = false;
  private projectDir: string;
  private initialized: boolean = false;

  constructor(projectDir: string, rerankerConfig?: RerankerConfig) {
    this.projectDir = projectDir;
    this.embedder = new Embedder({ backend: "tfidf", batchSize: 32 });
    this.chunker = new CodeChunker(projectDir);
    this.rerankerConfig = rerankerConfig ?? DEFAULT_RERANKER_CONFIG;
  }

  /** Initialize the engine — detects backend, creates vector store */
  async init(): Promise<void> {
    if (this.initialized) return;

    const backend = await this.embedder.init();
    const db = getDb();
    const dims = this.embedder.getDimensions();
    this.vectorStore = new VectorStore(db, dims);

    this.initialized = true;
    log.info("rag-engine", `Initialized with backend=${backend}, dimensions=${dims}`);
  }

  /** Ensure init() has been called */
  private ensureInit(): void {
    if (!this.initialized || !this.vectorStore) {
      throw new Error("RAGEngine not initialized — call init() first");
    }
  }

  /** Get the vector store (for direct queries/stats) */
  getVectorStore(): VectorStore {
    this.ensureInit();
    return this.vectorStore!;
  }

  /** Get the embedder instance */
  getEmbedder(): Embedder {
    return this.embedder;
  }

  // ─── Indexing ────────────────────────────────────────────────

  /** Index the entire project (first time or full rebuild) */
  async indexProject(projectDir?: string): Promise<IndexReport> {
    if (this.indexing) throw new Error("Indexing already in progress");
    this.indexing = true;

    const dir = projectDir ?? this.projectDir;

    try {
      await this.init();
      const report: IndexReport = {
        filesProcessed: 0,
        chunksCreated: 0,
        errors: [],
        durationMs: 0,
      };
      const start = Date.now();

      // 1. List eligible files
      const files = this.listEligibleFiles(dir);

      // 2. Chunk all files
      const allChunks: CodeChunk[] = [];
      for (const file of files) {
        try {
          const content = readFileSync(file.path, "utf-8");
          const language = this.detectLanguage(file.path);
          const chunks = this.chunker.chunk(file.path, content, language);
          allChunks.push(...chunks);
          report.filesProcessed++;
        } catch (e) {
          report.errors.push({ file: file.path, error: (e as Error).message });
        }
      }

      // 3. Fit TF-IDF vocabulary if using that backend
      if (this.embedder.getBackend() === "tfidf") {
        const texts = allChunks.map((c) => this.prepareForEmbedding(c));
        this.embedder.fitTFIDF(texts);
        // Recreate vector store with correct dimensions
        const db = getDb();
        this.vectorStore = new VectorStore(db, this.embedder.getDimensions());
      }

      // 4. Embed in batches and store
      for (const batch of this.batchArray(allChunks, 50)) {
        const texts = batch.map((c) => this.prepareForEmbedding(c));
        const embeddings = await this.embedder.embedBatch(texts);

        const chunksWithEmbeddings = batch.map((c, i) => ({
          ...c,
          embedding: embeddings[i]!,
        }));

        this.vectorStore!.upsert(chunksWithEmbeddings);
        report.chunksCreated += chunksWithEmbeddings.length;
      }

      report.durationMs = Date.now() - start;
      log.info(
        "rag-engine",
        `Indexed ${report.filesProcessed} files, ${report.chunksCreated} chunks in ${report.durationMs}ms`,
      );
      return report;
    } finally {
      this.indexing = false;
    }
  }

  /** Incremental update: only re-index modified files */
  async updateIndex(projectDir?: string): Promise<IndexReport> {
    if (this.indexing) throw new Error("Indexing already in progress");
    this.indexing = true;

    const dir = projectDir ?? this.projectDir;

    try {
      await this.init();
      const report: IndexReport = {
        filesProcessed: 0,
        chunksCreated: 0,
        errors: [],
        durationMs: 0,
      };
      const start = Date.now();

      const files = this.listEligibleFiles(dir);
      const store = this.vectorStore!;

      // Get last indexed times from DB
      const db = getDb();
      const indexedFiles = new Map<string, string>();
      try {
        const rows = db
          .prepare(
            "SELECT DISTINCT file_path, MAX(file_modified_at) as last_mod FROM rag_chunks GROUP BY file_path",
          )
          .all() as Array<{ file_path: string; last_mod: string }>;
        for (const row of rows) {
          indexedFiles.set(row.file_path, row.last_mod);
        }
      } catch {
        // Table might not exist yet — do full index
        return this.indexProject(dir);
      }

      // Find modified files
      const modifiedFiles: FileInfo[] = [];
      const currentPaths = new Set<string>();

      for (const file of files) {
        currentPaths.add(file.path);
        const lastMod = indexedFiles.get(file.path);
        if (!lastMod || new Date(lastMod).getTime() < file.mtimeMs) {
          modifiedFiles.push(file);
        }
      }

      // Remove deleted files
      for (const [path] of indexedFiles) {
        if (!currentPaths.has(path)) {
          store.removeByFile(path);
        }
      }

      if (modifiedFiles.length === 0) {
        report.durationMs = Date.now() - start;
        return report;
      }

      // Re-chunk and re-embed modified files
      const allChunks: CodeChunk[] = [];
      for (const file of modifiedFiles) {
        store.removeByFile(file.path);
        try {
          const content = readFileSync(file.path, "utf-8");
          const language = this.detectLanguage(file.path);
          const chunks = this.chunker.chunk(file.path, content, language);
          allChunks.push(...chunks);
          report.filesProcessed++;
        } catch (e) {
          report.errors.push({ file: file.path, error: (e as Error).message });
        }
      }

      // Re-fit TF-IDF if needed (must include existing corpus)
      if (this.embedder.getBackend() === "tfidf") {
        const existingTexts: string[] = [];
        try {
          const rows = db
            .prepare("SELECT content, relative_path, name FROM rag_chunks")
            .all() as Array<{
            content: string;
            relative_path: string;
            name: string;
          }>;
          for (const row of rows) {
            existingTexts.push(`${row.relative_path}: ${row.name}\n\n${row.content}`);
          }
        } catch {
          /* empty store */
        }

        const newTexts = allChunks.map((c) => this.prepareForEmbedding(c));
        this.embedder.fitTFIDF([...existingTexts, ...newTexts]);
        this.vectorStore = new VectorStore(db, this.embedder.getDimensions());
      }

      for (const batch of this.batchArray(allChunks, 50)) {
        const texts = batch.map((c) => this.prepareForEmbedding(c));
        const embeddings = await this.embedder.embedBatch(texts);

        const chunksWithEmbeddings = batch.map((c, i) => ({
          ...c,
          embedding: embeddings[i]!,
        }));

        this.vectorStore!.upsert(chunksWithEmbeddings);
        report.chunksCreated += chunksWithEmbeddings.length;
      }

      report.durationMs = Date.now() - start;
      log.info(
        "rag-engine",
        `Updated ${report.filesProcessed} files, ${report.chunksCreated} chunks in ${report.durationMs}ms`,
      );
      return report;
    } finally {
      this.indexing = false;
    }
  }

  // ─── Search ──────────────────────────────────────────────────

  /** Semantic search with re-ranking */
  async search(query: string, options?: RAGSearchOptions): Promise<SearchResult[]> {
    await this.init();

    // 1. Generate query embedding
    const queryEmbedding = await this.embedder.embed(query);
    if (!queryEmbedding || queryEmbedding.length === 0) return [];

    // 2. Search vector store
    const limit = (options?.limit ?? 10) * 2; // fetch extra for re-ranking
    const candidates = this.vectorStore!.search(queryEmbedding, limit, options?.filters);

    if (candidates.length === 0) return [];

    // 3. Re-rank with contextual signals
    const reranked = rerank(
      candidates,
      {
        currentFile: options?.currentFile,
        sessionFiles: options?.sessionFiles ?? [],
        queryType: options?.queryType ?? "code",
      },
      this.rerankerConfig,
    );

    // 4. Filter by minimum similarity and return top-K
    const minSim = options?.minSimilarity ?? 0.01;
    return reranked.filter((r) => r.similarity >= minSim).slice(0, options?.limit ?? 10);
  }

  /** Format search results as context for injection into prompts */
  formatAsContext(results: SearchResult[], maxTokens: number = 3000): string {
    if (results.length === 0) return "";

    const sections: string[] = ["## Relevant codebase context (RAG)"];
    let tokens = 10; // header

    for (const r of results) {
      const header = `### ${r.relativePath}:${r.startLine}-${r.endLine} (${r.name})`;
      const headerTokens = Math.ceil(header.length / 4);
      const contentTokens = r.tokenEstimate;

      if (tokens + headerTokens + contentTokens > maxTokens) {
        // Try to fit a truncated version
        const remaining = maxTokens - tokens - headerTokens - 5;
        if (remaining > 50) {
          const truncated = r.content.slice(0, remaining * 4);
          sections.push(header);
          sections.push("```");
          sections.push(truncated + "\n// ...");
          sections.push("```");
          tokens += headerTokens + Math.ceil(truncated.length / 4) + 5;
        }
        break;
      }

      sections.push(header);
      sections.push("```");
      sections.push(r.content);
      sections.push("```");
      tokens += headerTokens + contentTokens + 3;
    }

    return sections.join("\n");
  }

  /** Get index statistics */
  stats(): VectorStoreStats {
    if (!this.vectorStore) {
      return { total: 0, files: 0, totalTokens: 0 };
    }
    return this.vectorStore.stats();
  }

  /** Clear the entire index */
  clear(): void {
    if (this.vectorStore) {
      this.vectorStore.clear();
    }
  }

  /** Check if the engine is currently indexing */
  isIndexing(): boolean {
    return this.indexing;
  }

  // ─── Helpers ─────────────────────────────────────────────────

  /** Prepare chunk text for embedding */
  private prepareForEmbedding(chunk: CodeChunk): string {
    const header = `${chunk.relativePath}: ${chunk.signature || chunk.name}`;
    return `${header}\n\n${chunk.content}`;
  }

  /** Detect language from file extension */
  detectLanguage(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    return LANGUAGE_MAP[ext] ?? "unknown";
  }

  /** List eligible files for indexing */
  listEligibleFiles(dir: string): FileInfo[] {
    const files: FileInfo[] = [];
    this.walkDir(dir, files, 0);
    return files;
  }

  private walkDir(dir: string, files: FileInfo[], depth: number): void {
    if (depth > 10 || files.length >= MAX_FILES) return;

    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;

      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !IGNORE_DIRS.has(entry.name)) {
          this.walkDir(join(dir, entry.name), files, depth + 1);
        }
        continue;
      }

      const ext = extname(entry.name);
      if (!INDEXABLE_EXTENSIONS.has(ext)) continue;

      const fullPath = join(dir, entry.name);
      try {
        const stat = statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;
        files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Skip unreadable files
      }
    }
  }

  /** Split array into batches */
  private batchArray<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }
}

// ─── Singleton ─────────────────────────────────────────────────

let _engine: RAGEngine | null = null;

/**
 * Get the shared RAG engine instance for a project directory.
 * Lazily creates and initializes on first call.
 */
export function getRAGEngine(projectDir: string): RAGEngine {
  if (!_engine || (_engine as unknown as { projectDir: string }).projectDir !== projectDir) {
    _engine = new RAGEngine(projectDir);
  }
  return _engine;
}

/** Reset the singleton (for tests) */
export function resetRAGEngine(): void {
  _engine = null;
}
