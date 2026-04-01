// KCode - Embedding Generator
// Generates vector embeddings locally without external APIs.
// Supports multiple backends: Ollama, llama.cpp, and TF-IDF fallback.
// Also exports a pluggable EmbedderInterface + LocalEmbedder / CloudEmbedder for the RAG pipeline.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger";
import type { EmbeddingBackend, EmbeddingConfig } from "./types";

// ─── Pluggable Embedder Interface ─────────────────────────────

/**
 * Abstract interface for any embedding provider (local or cloud).
 * Used by RagEngine for pluggable embedder injection.
 */
export interface EmbedderInterface {
  /** Generate an embedding vector for a single text */
  embed(text: string): Promise<number[]>;
  /** Generate embeddings for multiple texts in batch */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Dimensionality of the embedding vectors */
  dimensions: number;
}

export interface EmbedderInterfaceConfig {
  type: "local" | "cloud";
  /** For local: Ollama or llama.cpp endpoint (default: http://localhost:11434) */
  endpoint?: string;
  /** For local: model name (default: nomic-embed-text) */
  model?: string;
  /** For cloud: OpenAI API key */
  apiKey?: string;
  /** For cloud: embedding model (default: text-embedding-3-small) */
  cloudModel?: string;
  /** Override dimensions */
  dimensions?: number;
}

/**
 * Generates embeddings via a local Ollama or llama.cpp server.
 */
export class LocalEmbedder implements EmbedderInterface {
  readonly dimensions: number;
  private endpoint: string;
  private model: string;

  constructor(config: EmbedderInterfaceConfig = { type: "local" }) {
    this.endpoint = config.endpoint ?? "http://localhost:11434";
    this.model = config.model ?? "nomic-embed-text";
    this.dimensions = config.dimensions ?? 768;
  }

  async embed(text: string): Promise<number[]> {
    try {
      const res = await fetch(`${this.endpoint}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
      if (!res.ok) {
        log.warn("rag", `Local embed request failed: ${res.status}`);
        return [];
      }
      const data = (await res.json()) as { embedding?: number[] };
      return data.embedding ?? [];
    } catch (err) {
      log.warn("rag", `Local embedder error: ${err}`);
      return [];
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}

/**
 * Generates embeddings via OpenAI's text-embedding API.
 */
export class CloudEmbedder implements EmbedderInterface {
  readonly dimensions: number;
  private apiKey: string;
  private model: string;

  constructor(config: EmbedderInterfaceConfig = { type: "cloud" }) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.model = config.cloudModel ?? "text-embedding-3-small";
    this.dimensions = config.dimensions ?? 1536;
  }

  async embed(text: string): Promise<number[]> {
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: text }),
      });
      if (!res.ok) {
        log.warn("rag", `Cloud embed request failed: ${res.status}`);
        return [];
      }
      const data = (await res.json()) as {
        data?: { embedding: number[] }[];
      };
      return data.data?.[0]?.embedding ?? [];
    } catch (err) {
      log.warn("rag", `Cloud embedder error: ${err}`);
      return [];
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
      if (!res.ok) {
        log.warn("rag", `Cloud batch embed request failed: ${res.status}`);
        return texts.map(() => []);
      }
      const data = (await res.json()) as {
        data?: { embedding: number[]; index: number }[];
      };
      if (!data.data) return texts.map(() => []);
      const sorted = data.data.sort((a, b) => a.index - b.index);
      return sorted.map((d) => d.embedding);
    } catch (err) {
      log.warn("rag", `Cloud batch embedder error: ${err}`);
      return texts.map(() => []);
    }
  }
}

/**
 * Factory: create an EmbedderInterface based on configuration.
 */
export function createEmbedder(config: EmbedderInterfaceConfig): EmbedderInterface {
  if (config.type === "cloud") {
    return new CloudEmbedder(config);
  }
  return new LocalEmbedder(config);
}

// ─── Backend Priority ──────────────────────────────────────────

const BACKEND_PRIORITY: EmbeddingBackend[] = ["ollama", "llama-cpp", "bge-micro", "tfidf"];

// ─── TF-IDF Embedder ──────────────────────────────────────────

/**
 * Pure TypeScript TF-IDF embedder.
 * No external model needed — works on any machine.
 * Quality is inferior to neural embeddings but better than keyword match.
 */
export class TFIDFEmbedder {
  private vocabulary: Map<string, number> = new Map();
  private idf: Map<string, number> = new Map();
  dimensions: number = 0;
  private fitted = false;

  /** Tokenize text into lowercased words */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2 && t.length <= 40);
  }

  /** Build vocabulary from corpus of documents */
  fit(documents: string[]): void {
    const docFreq: Map<string, number> = new Map();
    const termFreq: Map<string, number> = new Map();

    for (const doc of documents) {
      const tokens = this.tokenize(doc);
      const seen = new Set<string>();

      for (const token of tokens) {
        termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
        if (!seen.has(token)) {
          docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
          seen.add(token);
        }
      }
    }

    // Select top 10,000 tokens by frequency
    const sorted = [...termFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10_000);

    this.vocabulary.clear();
    this.idf.clear();

    const N = documents.length || 1;

    for (let i = 0; i < sorted.length; i++) {
      const [token] = sorted[i]!;
      this.vocabulary.set(token, i);
      const df = docFreq.get(token) ?? 1;
      this.idf.set(token, Math.log(N / df));
    }

    this.dimensions = this.vocabulary.size;
    this.fitted = true;
  }

  /** Generate TF-IDF vector for a text */
  embed(text: string): number[] {
    if (!this.fitted || this.dimensions === 0) {
      return [];
    }

    const tokens = this.tokenize(text);
    const tf: Map<string, number> = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    // Normalize TF
    const maxTf = Math.max(...tf.values(), 1);
    const vector = new Array<number>(this.dimensions).fill(0);

    for (const [token, freq] of tf) {
      const idx = this.vocabulary.get(token);
      if (idx !== undefined) {
        const normalizedTf = freq / maxTf;
        const idfVal = this.idf.get(token) ?? 0;
        vector[idx] = normalizedTf * idfVal;
      }
    }

    // L2 normalize
    let norm = 0;
    for (const v of vector) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i]! /= norm;
      }
    }

    return vector;
  }

  /** Batch embed multiple texts */
  embedBatch(texts: string[]): number[][] {
    return texts.map((t) => this.embed(t));
  }

  /** Serialize vocabulary to JSON */
  serialize(): string {
    return JSON.stringify({
      vocabulary: [...this.vocabulary.entries()],
      idf: [...this.idf.entries()],
      dimensions: this.dimensions,
    });
  }

  /** Deserialize vocabulary from JSON */
  deserialize(json: string): void {
    const data = JSON.parse(json);
    this.vocabulary = new Map(data.vocabulary);
    this.idf = new Map(data.idf);
    this.dimensions = data.dimensions;
    this.fitted = true;
  }
}

// ─── Ollama Embedding ──────────────────────────────────────────

async function embedWithOllama(
  texts: string[],
  model: string = "nomic-embed-text",
): Promise<number[][]> {
  const resp = await fetch("http://localhost:11434/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Ollama embedding failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as { embeddings: number[][] };
  return data.embeddings;
}

// ─── llama.cpp Embedding ───────────────────────────────────────

async function embedWithLlamaCpp(
  texts: string[],
  endpoint: string = "http://localhost:10091",
): Promise<number[][]> {
  const resp = await fetch(`${endpoint}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "embedding", input: texts }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`llama.cpp embedding failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
  return data.data.map((d) => d.embedding);
}

// ─── Auto-Detection ────────────────────────────────────────────

/** Detect the best available embedding backend */
export async function detectBestBackend(): Promise<EmbeddingBackend> {
  // 1. Check Ollama for embedding models
  try {
    const r = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    const data = (await r.json()) as { models?: Array<{ name: string }> };
    const hasEmbedModel = data.models?.some(
      (m) => m.name.includes("embed") || m.name.includes("nomic") || m.name.includes("minilm"),
    );
    if (hasEmbedModel) return "ollama";
  } catch {
    /* continue */
  }

  // 2. Check llama.cpp embedding endpoint
  try {
    const r = await fetch("http://localhost:10091/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "test", model: "embedding" }),
      signal: AbortSignal.timeout(2000),
    });
    if (r.ok) return "llama-cpp";
  } catch {
    /* continue */
  }

  // 3. Check for bundled BGE-micro ONNX model
  if (existsSync(join(homedir(), ".kcode/models/bge-micro-v2.onnx"))) {
    return "bge-micro";
  }

  // 4. Fallback: TF-IDF (always available)
  return "tfidf";
}

// ─── Unified Embedder ──────────────────────────────────────────

const DEFAULT_CONFIG: EmbeddingConfig = {
  backend: "auto",
  model: "",
  dimensions: 0,
  batchSize: 32,
};

/**
 * Unified embedding interface that delegates to the best available backend.
 */
export class Embedder {
  private config: EmbeddingConfig;
  private backend: EmbeddingBackend | null = null;
  private tfidf: TFIDFEmbedder | null = null;
  private _dimensions: number = 0;

  constructor(config: Partial<EmbeddingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Initialize the embedder — detects backend if set to auto */
  async init(): Promise<EmbeddingBackend> {
    if (this.config.backend === "auto") {
      this.backend = await detectBestBackend();
    } else {
      this.backend = this.config.backend;
    }

    // Set default dimensions per backend
    if (this.config.dimensions > 0) {
      this._dimensions = this.config.dimensions;
    } else {
      switch (this.backend) {
        case "ollama":
          this._dimensions = 768; // nomic-embed-text default
          break;
        case "llama-cpp":
          this._dimensions = 768;
          break;
        case "bge-micro":
          this._dimensions = 384;
          break;
        case "tfidf":
          this._dimensions = 0; // set after fit()
          break;
      }
    }

    log.info("rag-embedder", `Using backend: ${this.backend}, dimensions: ${this._dimensions}`);
    return this.backend;
  }

  /** Get current backend */
  getBackend(): EmbeddingBackend | null {
    return this.backend;
  }

  /** Get vector dimensions */
  getDimensions(): number {
    return this._dimensions;
  }

  /**
   * For TF-IDF backend: fit the vocabulary on a corpus.
   * No-op for neural backends.
   */
  fitTFIDF(documents: string[]): void {
    if (this.backend !== "tfidf") return;

    if (!this.tfidf) {
      this.tfidf = new TFIDFEmbedder();
    }
    this.tfidf.fit(documents);
    this._dimensions = this.tfidf.dimensions;
  }

  /** Get the TF-IDF instance (for serialization) */
  getTFIDF(): TFIDFEmbedder | null {
    return this.tfidf;
  }

  /** Set a pre-built TF-IDF instance */
  setTFIDF(tfidf: TFIDFEmbedder): void {
    this.tfidf = tfidf;
    this._dimensions = tfidf.dimensions;
  }

  /** Embed a single text */
  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0]!;
  }

  /** Embed multiple texts in batches */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.backend) {
      await this.init();
    }

    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += this.config.batchSize) {
      const batch = texts.slice(i, i + this.config.batchSize);
      const embeddings = await this.embedChunk(batch);
      results.push(...embeddings);
    }

    return results;
  }

  /** Embed a single batch using the active backend */
  private async embedChunk(texts: string[]): Promise<number[][]> {
    switch (this.backend) {
      case "ollama":
        return embedWithOllama(texts, this.config.model || "nomic-embed-text");
      case "llama-cpp":
        return embedWithLlamaCpp(texts, this.config.model || "http://localhost:10091");
      case "tfidf": {
        if (!this.tfidf) {
          this.tfidf = new TFIDFEmbedder();
          // If not fitted yet, fit on the input texts as a bootstrap
          this.tfidf.fit(texts);
          this._dimensions = this.tfidf.dimensions;
        }
        return this.tfidf.embedBatch(texts);
      }
      case "bge-micro":
        // BGE-micro would use ONNX runtime — fall back to TF-IDF for now
        log.warn("rag-embedder", "BGE-micro not yet implemented, falling back to TF-IDF");
        this.backend = "tfidf";
        return this.embedChunk(texts);
      default:
        throw new Error(`Unknown embedding backend: ${this.backend}`);
    }
  }
}
