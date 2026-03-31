// KCode - Dataset Curator for Model Distillation
// Automatically curates exported datasets: deduplicates, filters, balances, and cleans.

import { log } from "../logger";
import type { CurationReport, BalanceOptions } from "./types";

// ─── Types ─────────────────────────────────────────────────────

/** A single entry in a loaded dataset (generic shape). */
export interface DatasetEntry {
  /** user_query or instruction — the user's request */
  user_query: string;
  /** assistant_response or output — the model's answer */
  assistant_response: string;
  /** Serialized tool chain (JSON string) */
  tool_chain?: string;
  /** Success flag (0/1 or boolean) */
  success?: boolean | number;
  /** Comma-separated tags */
  tags?: string;
  /** Quality score */
  quality?: number;
}

// ─── Constants ─────────────────────────────────────────────────

const MIN_RESPONSE_LENGTH = 20;
const DEFAULT_SIMILARITY_THRESHOLD = 0.95;

// ─── DatasetCurator ────────────────────────────────────────────

export class DatasetCurator {
  /**
   * Curate a dataset: filter, deduplicate, balance, and clean.
   * Reads from inputFile, writes the curated result to outputFile.
   */
  async curate(inputFile: string, outputFile: string): Promise<CurationReport> {
    const entries = await this.loadDataset(inputFile);
    const inputCount = entries.length;

    let curated = entries;

    // 1. Deduplicate by query similarity
    const beforeDedup = curated.length;
    curated = this.deduplicateByQuery(curated, DEFAULT_SIMILARITY_THRESHOLD);
    const removedDuplicates = beforeDedup - curated.length;

    // 2. Filter problematic examples
    const beforeFilter = curated.length;
    curated = this.filterProblematic(curated);
    const removedCount = beforeFilter - curated.length;

    // 3. Balance by tags
    const beforeBalance = curated.length;
    curated = this.balanceByTags(curated, {
      maxPerTag: Math.max(Math.ceil(curated.length / 10), 1),
      minPerTag: 5,
    });
    const rebalanced = Math.abs(beforeBalance - curated.length);

    // 4. Clean content
    curated = curated.map((ex) => ({
      ...ex,
      user_query: DatasetCurator.cleanText(ex.user_query),
      assistant_response: DatasetCurator.cleanText(ex.assistant_response),
    }));

    // Write result
    await this.writeDataset(outputFile, curated);

    const report: CurationReport = {
      inputCount,
      outputCount: curated.length,
      removedDuplicates,
      removedShort: removedCount,
      removedBroken: 0, // counted within filterProblematic
      rebalanced,
    };

    log.info(
      "distill",
      `Curated dataset: ${inputCount} -> ${curated.length} examples (${removedDuplicates} dups, ${removedCount} filtered)`,
    );

    return report;
  }

  // ─── Load / Write ──────────────────────────────────────────────

  /**
   * Load a dataset from a JSONL or JSON file.
   */
  async loadDataset(filePath: string): Promise<DatasetEntry[]> {
    const file = Bun.file(filePath);
    const text = await file.text();

    // Try JSONL first (one JSON object per line)
    const lines = text.trim().split("\n");
    if (lines.length > 0) {
      try {
        const first = JSON.parse(lines[0]!);
        // If it parses and it's not an array, it's JSONL
        if (!Array.isArray(first)) {
          return lines
            .filter((line) => line.trim().length > 0)
            .map((line) => this.normalizeEntry(JSON.parse(line)));
        }
      } catch {
        // Not JSONL — fall through to JSON array
      }
    }

    // Try JSON array
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((entry: Record<string, unknown>) =>
        this.normalizeEntry(entry),
      );
    }

    throw new Error(
      `Unsupported dataset format: expected JSONL or JSON array`,
    );
  }

  /**
   * Normalize different dataset shapes into our unified DatasetEntry.
   */
  private normalizeEntry(raw: Record<string, unknown>): DatasetEntry {
    // JSONL Chat / OpenAI format: { messages: [...] }
    if (raw.messages && Array.isArray(raw.messages)) {
      const msgs = raw.messages as Record<string, unknown>[];
      const userMsg = msgs.find((m) => m.role === "user");
      const assistantMsgs = msgs.filter((m) => m.role === "assistant" && m.content);
      const lastAssistant = assistantMsgs[assistantMsgs.length - 1];

      return {
        user_query: String(userMsg?.content ?? ""),
        assistant_response: String(lastAssistant?.content ?? ""),
      };
    }

    // ShareGPT format: { conversations: [...] }
    if (raw.conversations && Array.isArray(raw.conversations)) {
      const convs = raw.conversations as Record<string, unknown>[];
      const human = convs.find((c) => c.from === "human");
      const gpt = convs.find((c) => c.from === "gpt");
      return {
        user_query: String(human?.value ?? ""),
        assistant_response: String(gpt?.value ?? ""),
      };
    }

    // Alpaca format: { instruction, input, output }
    if ("instruction" in raw && "output" in raw) {
      return {
        user_query: String(raw.instruction ?? ""),
        assistant_response: String(raw.output ?? ""),
      };
    }

    // Direct format (our internal shape)
    return {
      user_query: String(raw.user_query ?? raw.query ?? ""),
      assistant_response: String(
        raw.assistant_response ?? raw.response ?? "",
      ),
      tool_chain: raw.tool_chain != null ? String(raw.tool_chain) : undefined,
      success:
        raw.success != null ? Boolean(raw.success) : undefined,
      tags: raw.tags != null ? String(raw.tags) : undefined,
      quality:
        raw.quality != null ? Number(raw.quality) : undefined,
    };
  }

  /**
   * Write curated entries to a file (JSONL format).
   */
  async writeDataset(
    outputFile: string,
    entries: DatasetEntry[],
  ): Promise<void> {
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Bun.write(outputFile, content);
  }

  // ─── Deduplication ─────────────────────────────────────────────

  /**
   * Remove near-duplicate entries by comparing query strings.
   * Uses character-level trigram Jaccard similarity as a fast approximation.
   */
  deduplicateByQuery(
    entries: DatasetEntry[],
    threshold: number,
  ): DatasetEntry[] {
    if (entries.length === 0) return [];

    const seen: DatasetEntry[] = [];

    for (const entry of entries) {
      const isDuplicate = seen.some(
        (s) =>
          DatasetCurator.querySimilarity(s.user_query, entry.user_query) >= threshold,
      );
      if (!isDuplicate) {
        seen.push(entry);
      }
    }

    return seen;
  }

  /**
   * Compute trigram Jaccard similarity between two strings.
   * Returns a value between 0.0 (completely different) and 1.0 (identical).
   */
  static querySimilarity(a: string, b: string): number {
    if (a === b) return 1.0;
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const na = norm(a);
    const nb = norm(b);
    if (na === nb) return 1.0;
    if (na.length < 3 || nb.length < 3) return na === nb ? 1.0 : 0.0;

    const trigramsA = DatasetCurator.trigrams(na);
    const trigramsB = DatasetCurator.trigrams(nb);

    let intersection = 0;
    const setB = new Set(trigramsB);
    for (const t of trigramsA) {
      if (setB.has(t)) intersection++;
    }

    const union = new Set([...trigramsA, ...trigramsB]).size;
    return union === 0 ? 0 : intersection / union;
  }

  /**
   * Extract character trigrams from a string.
   */
  static trigrams(s: string): string[] {
    const result: string[] = [];
    for (let i = 0; i <= s.length - 3; i++) {
      result.push(s.slice(i, i + 3));
    }
    return result;
  }

  // ─── Filtering ─────────────────────────────────────────────────

  /**
   * Filter out problematic examples:
   * - Responses shorter than MIN_RESPONSE_LENGTH
   * - Failed interactions without a fix
   * - Broken tool chain JSON
   */
  filterProblematic(entries: DatasetEntry[]): DatasetEntry[] {
    return entries.filter((ex) => {
      // Not too short
      if (ex.assistant_response.length < MIN_RESPONSE_LENGTH) return false;

      // Not failed without resolution
      if (
        ex.success === false ||
        ex.success === 0
      ) {
        if (!ex.assistant_response.toLowerCase().includes("fix")) return false;
      }

      // Tool chain must be valid JSON (if present)
      if (ex.tool_chain) {
        try {
          JSON.parse(ex.tool_chain);
        } catch {
          return false;
        }
      }

      return true;
    });
  }

  // ─── Balancing ─────────────────────────────────────────────────

  /**
   * Balance entries by their tags so no single tag dominates the dataset.
   */
  balanceByTags(entries: DatasetEntry[], opts: BalanceOptions): DatasetEntry[] {
    if (entries.length === 0) return [];

    // Group entries by their primary tag
    const tagBuckets = new Map<string, DatasetEntry[]>();
    const untagged: DatasetEntry[] = [];

    for (const entry of entries) {
      const primaryTag = (entry.tags ?? "").split(",")[0]?.trim();
      if (!primaryTag) {
        untagged.push(entry);
        continue;
      }
      const bucket = tagBuckets.get(primaryTag) ?? [];
      bucket.push(entry);
      tagBuckets.set(primaryTag, bucket);
    }

    // Cap each bucket at maxPerTag
    const balanced: DatasetEntry[] = [...untagged];
    for (const [, bucket] of tagBuckets) {
      balanced.push(...bucket.slice(0, opts.maxPerTag));
    }

    return balanced;
  }

  // ─── Cleaning ──────────────────────────────────────────────────

  /**
   * Clean text content: normalize whitespace, strip control characters,
   * remove excessive newlines.
   */
  static cleanText(text: string): string {
    return (
      text
        // Strip control characters except newlines and tabs
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
        // Collapse 3+ consecutive newlines into 2
        .replace(/\n{3,}/g, "\n\n")
        // Trim leading/trailing whitespace
        .trim()
    );
  }
}
