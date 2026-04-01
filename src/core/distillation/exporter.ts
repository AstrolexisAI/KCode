// KCode - Dataset Exporter for Model Distillation
// Exports distilled_examples from SQLite into fine-tuning dataset formats
// (JSONL Chat, ShareGPT, Alpaca, OpenAI).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../db";
import { log } from "../logger";
import { kcodePath } from "../paths";
import type { DistilledExampleRow, ExportConfig, ExportFormat, ExportReport } from "./types";

// ─── Defaults ──────────────────────────────────────────────────

const DEFAULT_MIN_QUALITY = 0.5;
const DEFAULT_MAX_EXAMPLES = 5000;
const DEFAULT_OUTPUT_PATH = kcodePath("datasets");
const APPROX_TOKENS_PER_CHAR = 0.25; // rough tokenizer estimate

// ─── DatasetExporter ───────────────────────────────────────────

export class DatasetExporter {
  private _dbOverride?: { query: (sql: string) => { all: (...params: unknown[]) => unknown[] } };

  /**
   * Create a DatasetExporter. Optionally pass a Database instance (for testing).
   */
  constructor(dbOverride?: unknown) {
    this._dbOverride = dbOverride as typeof this._dbOverride;
  }

  /**
   * Build a complete ExportConfig with defaults applied.
   */
  static defaults(partial?: Partial<ExportConfig>): ExportConfig {
    return {
      format: partial?.format ?? "jsonl-chat",
      minQuality: partial?.minQuality ?? DEFAULT_MIN_QUALITY,
      maxExamples: partial?.maxExamples ?? DEFAULT_MAX_EXAMPLES,
      includeToolCalls: partial?.includeToolCalls ?? true,
      includeThinking: partial?.includeThinking ?? false,
      filterProjects: partial?.filterProjects,
      filterTags: partial?.filterTags,
      outputPath: partial?.outputPath ?? DEFAULT_OUTPUT_PATH,
    };
  }

  /**
   * Export distilled examples to a dataset file.
   */
  async export(config: ExportConfig): Promise<ExportReport> {
    // 1. Query examples from SQLite with filters
    const examples = this.queryExamples(config);

    // 2. Convert to the requested format
    const formatted = examples.map((ex) => this.formatExample(ex, config));

    // 3. Write output file
    mkdirSync(config.outputPath, { recursive: true });
    const ext = DatasetExporter.getExtension(config.format);
    const outputFile = join(config.outputPath, `dataset_${Date.now()}.${ext}`);
    await this.writeDataset(outputFile, formatted, config.format);

    const totalTokens = this.estimateTokens(formatted);

    log.info(
      "distill",
      `Exported ${formatted.length} examples to ${outputFile} (${config.format})`,
    );

    return {
      outputFile,
      examplesExported: formatted.length,
      format: config.format,
      totalTokens,
    };
  }

  // ─── Query ─────────────────────────────────────────────────────

  /**
   * Query distilled examples from the database, applying filters.
   */
  queryExamples(config: ExportConfig): DistilledExampleRow[] {
    const db = this._dbOverride ?? getDb();

    let sql = `SELECT id, user_query, assistant_response, tool_chain, tool_count,
               success, project, tags, quality, use_count, created_at
               FROM distilled_examples WHERE quality >= ?`;
    const params: (string | number)[] = [config.minQuality];

    if (config.filterProjects && config.filterProjects.length > 0) {
      const placeholders = config.filterProjects.map(() => "?").join(",");
      sql += ` AND project IN (${placeholders})`;
      params.push(...config.filterProjects);
    }

    if (config.filterTags && config.filterTags.length > 0) {
      for (const tag of config.filterTags) {
        sql += ` AND tags LIKE ?`;
        params.push(`%${tag}%`);
      }
    }

    sql += ` ORDER BY quality DESC, use_count DESC LIMIT ?`;
    params.push(config.maxExamples);

    return db.query(sql).all(...params) as DistilledExampleRow[];
  }

  // ─── Format ────────────────────────────────────────────────────

  /**
   * Format a single example according to the export format.
   */
  formatExample(example: DistilledExampleRow, config: ExportConfig): Record<string, unknown> {
    switch (config.format) {
      case "jsonl-chat":
        return this.formatJsonlChat(example, config);
      case "sharegpt":
        return this.formatShareGPT(example);
      case "alpaca":
        return this.formatAlpaca(example);
      case "openai":
        return this.formatOpenAI(example, config);
      default:
        throw new Error(`Unsupported export format: ${config.format}`);
    }
  }

  /**
   * JSONL Chat format (compatible with Unsloth/Axolotl).
   * Multi-turn with system, user, tool calls, and assistant messages.
   */
  private formatJsonlChat(
    example: DistilledExampleRow,
    config: ExportConfig,
  ): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [];

    // System message
    messages.push({
      role: "system",
      content: "You are KCode, an AI coding assistant.",
    });

    // User query
    messages.push({
      role: "user",
      content: example.user_query,
    });

    // Tool calls (if enabled and present)
    if (config.includeToolCalls && example.tool_chain) {
      try {
        const chain = JSON.parse(example.tool_chain);
        if (Array.isArray(chain) && chain.length > 0) {
          for (const tool of chain) {
            messages.push({
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  type: "function",
                  function: {
                    name: tool.name ?? tool.tool ?? "unknown",
                    arguments: JSON.stringify(tool.input ?? tool.inputSummary ?? ""),
                  },
                },
              ],
            });
            messages.push({
              role: "tool",
              content: tool.output ?? tool.inputSummary ?? "Success",
              name: tool.name ?? tool.tool ?? "unknown",
            });
          }
        }
      } catch {
        // Skip malformed tool chains — still include the example without tools
      }
    }

    // Final assistant response
    messages.push({
      role: "assistant",
      content: example.assistant_response,
    });

    return { messages };
  }

  /**
   * ShareGPT format (human/gpt pairs).
   */
  private formatShareGPT(example: DistilledExampleRow): Record<string, unknown> {
    return {
      conversations: [
        { from: "human", value: example.user_query },
        { from: "gpt", value: example.assistant_response },
      ],
    };
  }

  /**
   * Alpaca format (instruction/input/output).
   */
  private formatAlpaca(example: DistilledExampleRow): Record<string, unknown> {
    return {
      instruction: example.user_query,
      input: "",
      output: example.assistant_response,
    };
  }

  /**
   * OpenAI fine-tuning format (messages array, same as JSONL chat but without tool turns).
   */
  private formatOpenAI(
    example: DistilledExampleRow,
    config: ExportConfig,
  ): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [
      { role: "system", content: "You are KCode, an AI coding assistant." },
      { role: "user", content: example.user_query },
    ];

    // Include tool calls if enabled
    if (config.includeToolCalls && example.tool_chain) {
      try {
        const chain = JSON.parse(example.tool_chain);
        if (Array.isArray(chain) && chain.length > 0) {
          for (const tool of chain) {
            messages.push({
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_${Math.random().toString(36).slice(2, 10)}`,
                  type: "function",
                  function: {
                    name: tool.name ?? tool.tool ?? "unknown",
                    arguments: JSON.stringify(tool.input ?? tool.inputSummary ?? ""),
                  },
                },
              ],
            });
            messages.push({
              role: "tool",
              tool_call_id: messages[messages.length - 1]!,
              content: tool.output ?? tool.inputSummary ?? "Success",
            });
          }
        }
      } catch {
        // skip
      }
    }

    messages.push({ role: "assistant", content: example.assistant_response });

    return { messages };
  }

  // ─── I/O Helpers ───────────────────────────────────────────────

  /**
   * Write the formatted dataset to disk.
   */
  async writeDataset(
    outputFile: string,
    data: Record<string, unknown>[],
    format: ExportFormat,
  ): Promise<void> {
    let content: string;

    if (format === "jsonl-chat" || format === "openai") {
      // One JSON object per line
      content = data.map((d) => JSON.stringify(d)).join("\n") + "\n";
    } else {
      // Full JSON array
      content = JSON.stringify(data, null, 2) + "\n";
    }

    await Bun.write(outputFile, content);
  }

  /**
   * Estimate total tokens from serialized examples.
   */
  estimateTokens(data: Record<string, unknown>[]): number {
    let totalChars = 0;
    for (const entry of data) {
      totalChars += JSON.stringify(entry).length;
    }
    return Math.round(totalChars * APPROX_TOKENS_PER_CHAR);
  }

  /**
   * Get the file extension for the given format.
   */
  static getExtension(format: ExportFormat): string {
    switch (format) {
      case "jsonl-chat":
      case "openai":
        return "jsonl";
      case "sharegpt":
      case "alpaca":
        return "json";
      default:
        return "jsonl";
    }
  }
}
