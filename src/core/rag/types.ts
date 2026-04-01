// KCode - RAG Engine Types
// Shared type definitions for the local RAG engine

/** Embedding backend types — ordered by quality/availability */
export type EmbeddingBackend = "ollama" | "llama-cpp" | "bge-micro" | "tfidf";

/** Configuration for the embedding subsystem */
export interface EmbeddingConfig {
  /** Backend to use (default: auto-detect) */
  backend: EmbeddingBackend | "auto";
  /** Model name for the backend (default: depends on backend) */
  model: string;
  /** Vector dimension (default: depends on model) */
  dimensions: number;
  /** Batch size for bulk embedding */
  batchSize: number;
}

/** A chunk of code extracted from a source file */
export interface CodeChunk {
  /** Hash of the content for deduplication */
  id: string;
  /** Absolute file path */
  filePath: string;
  /** Path relative to project root */
  relativePath: string;
  /** Programming language */
  language: string;
  /** Type of code construct */
  type: "function" | "class" | "method" | "module" | "block" | "comment";
  /** Symbol name */
  name: string;
  /** Full code content of the chunk */
  content: string;
  /** 1-based start line */
  startLine: number;
  /** 1-based end line */
  endLine: number;
  /** Function/class signature for quick reference */
  signature: string;
  /** Import paths used by this chunk */
  dependencies: string[];
  /** Estimated token count */
  tokenEstimate: number;
}

/** Filters for vector store search */
export interface SearchFilters {
  language?: string;
  type?: CodeChunk["type"];
  filePaths?: string[];
}

/** A search result from the vector store */
export interface SearchResult {
  chunkId: string;
  filePath: string;
  relativePath: string;
  name: string;
  type: CodeChunk["type"];
  content: string;
  startLine: number;
  endLine: number;
  similarity: number;
  tokenEstimate: number;
}

/** Stats about the vector store index */
export interface VectorStoreStats {
  total: number;
  files: number;
  totalTokens: number;
}

/** Reranker configuration with tunable weights */
export interface RerankerConfig {
  weights: {
    semantic: number;
    recency: number;
    frequency: number;
    proximity: number;
    typeBoost: number;
  };
}

/** Context for the reranker to compute additional signals */
export interface RerankerContext {
  currentFile?: string;
  sessionFiles: string[];
  queryType: "code" | "explanation" | "search";
}

/** Options for RAG search */
export interface RAGSearchOptions {
  limit?: number;
  filters?: SearchFilters;
  currentFile?: string;
  sessionFiles?: string[];
  queryType?: "code" | "explanation" | "search";
  /** Minimum similarity threshold (default 0.1 for tfidf, 0.6 for neural) */
  minSimilarity?: number;
}

/** Report from an indexing operation */
export interface IndexReport {
  filesProcessed: number;
  chunksCreated: number;
  errors: Array<{ file: string; error: string }>;
  durationMs: number;
}

/** RAG configuration stored in settings */
export interface RAGConfig {
  enabled: boolean;
  embeddingBackend: EmbeddingBackend | "auto";
  autoIndex: boolean;
  autoSearch: boolean;
  maxContextTokens: number;
  reindexOnChange: boolean;
  reranker: RerankerConfig["weights"];
}

/** Default RAG configuration */
export const DEFAULT_RAG_CONFIG: RAGConfig = {
  enabled: true,
  embeddingBackend: "auto",
  autoIndex: true,
  autoSearch: true,
  maxContextTokens: 3000,
  reindexOnChange: true,
  reranker: {
    semantic: 0.5,
    recency: 0.15,
    frequency: 0.15,
    proximity: 0.1,
    typeBoost: 0.1,
  },
};
