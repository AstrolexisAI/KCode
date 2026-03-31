// KCode - Model Distillation Pipeline Types
// Shared type definitions for the distillation subsystem.

// ─── Export Formats ────────────────────────────────────────────

/** Supported dataset export formats for fine-tuning. */
export type ExportFormat = "jsonl-chat" | "sharegpt" | "alpaca" | "openai";

/** Configuration for dataset export. */
export interface ExportConfig {
  format: ExportFormat;
  /** Minimum quality score to include (0.0-2.0, default: 0.5) */
  minQuality: number;
  /** Maximum number of examples to export (default: 5000) */
  maxExamples: number;
  /** Include tool call sequences in training data (default: true) */
  includeToolCalls: boolean;
  /** Include thinking/reasoning blocks (default: false) */
  includeThinking: boolean;
  /** Filter to only these projects */
  filterProjects?: string[];
  /** Filter to only examples with these tags */
  filterTags?: string[];
  /** Output directory (default: ~/.kcode/datasets/) */
  outputPath: string;
}

/** Report returned after a dataset export. */
export interface ExportReport {
  outputFile: string;
  examplesExported: number;
  format: ExportFormat;
  totalTokens: number;
}

// ─── Curation ──────────────────────────────────────────────────

/** Report returned after dataset curation. */
export interface CurationReport {
  inputCount: number;
  outputCount: number;
  removedDuplicates: number;
  removedShort: number;
  removedBroken: number;
  rebalanced: number;
}

/** Options for the balanceByTags step. */
export interface BalanceOptions {
  maxPerTag: number;
  minPerTag: number;
}

// ─── Training ──────────────────────────────────────────────────

/** Supported fine-tuning backends. */
export type TrainingBackend = "unsloth" | "axolotl" | "llamafactory" | "mlx-lm";

/** Configuration for a fine-tuning run. */
export interface TrainingConfig {
  backend: TrainingBackend;
  /** HuggingFace model ID or local path, e.g. "unsloth/Qwen2.5-Coder-7B-Instruct" */
  baseModel: string;
  /** Path to the JSONL training dataset */
  datasetPath: string;
  /** Output directory for checkpoints and final model (default: ~/.kcode/models/finetuned/) */
  outputDir: string;
  /** Number of training epochs (default: 3) */
  epochs: number;
  /** Batch size per device (default: 4) */
  batchSize: number;
  /** Learning rate (default: 2e-5) */
  learningRate: number;
  /** LoRA rank (default: 16) */
  loraRank: number;
  /** LoRA alpha (default: 32) */
  loraAlpha: number;
  /** Maximum sequence length (default: 4096) */
  maxSeqLength: number;
  /** Quantization mode (default: "4bit") */
  quantization: "4bit" | "8bit" | "none";
  /** CUDA device(s) to use (default: "0") */
  cudaDevices?: string;
}

/** Handle to a running training process. */
export interface TrainingHandle {
  pid: number;
  logFile: string;
  outputDir: string;
  status: "running" | "completed" | "failed";
}

// ─── Evaluation ────────────────────────────────────────────────

/** Configuration for model evaluation. */
export interface EvalConfig {
  /** Path to the GGUF or model directory */
  modelPath: string;
  /** Optional base model to compare against */
  baseModelPath?: string;
  /** Benchmark task set to use */
  benchmark: "coding-tasks" | "general" | "tool-use";
  /** Number of evaluation prompts (default: 50) */
  numPrompts: number;
  /** API base URL for the inference server */
  apiBase?: string;
}

/** A single evaluation task prompt. */
export interface EvalTask {
  id: string;
  prompt: string;
  expectedPattern?: string;
  category: string;
}

/** Result of a single evaluation task. */
export interface EvalTaskResult {
  taskId: string;
  passed: boolean;
  responseLength: number;
  latencyMs: number;
  tokensUsed: number;
}

/** Aggregate evaluation report. */
export interface EvalReport {
  modelPath: string;
  benchmark: string;
  totalTasks: number;
  passed: number;
  failed: number;
  avgLatencyMs: number;
  avgTokens: number;
  passRate: number;
  taskResults: EvalTaskResult[];
}

// ─── Deployment ────────────────────────────────────────────────

/** Configuration for deploying a distilled model. */
export interface DeployConfig {
  /** Path to the GGUF model file */
  modelPath: string;
  /** Name to register in models.json */
  name: string;
  /** Optional description */
  description?: string;
  /** Whether to set as default model */
  setAsDefault: boolean;
}

/** Report after deployment. */
export interface DeployReport {
  modelName: string;
  registeredAt: string;
  setAsDefault: boolean;
  modelPath: string;
}

// ─── Shared DB Row ─────────────────────────────────────────────

/** Row shape from the distilled_examples table (snake_case columns). */
export interface DistilledExampleRow {
  id: number;
  user_query: string;
  assistant_response: string;
  tool_chain: string;
  tool_count: number;
  success: number; // 0 | 1 in SQLite
  project: string;
  tags: string;
  quality: number;
  use_count: number;
  created_at: string;
}
