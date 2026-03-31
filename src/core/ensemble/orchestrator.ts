// KCode - Ensemble Orchestrator
// Top-level orchestrator that manages ensemble execution, configuration,
// and integration with the conversation loop.

import type { Message } from "../types";
import type {
  EnsembleConfig,
  EnsembleResult,
  EnsembleTrigger,
  ModelExecutor,
} from "./types";
import { DEFAULT_ENSEMBLE_CONFIG } from "./types";
import { executeStrategy } from "./strategies";
import { classifyTask, type TaskType } from "../router";
import { log } from "../logger";

// ─── Ensemble Orchestrator ──────────────────────────────────────

export class EnsembleOrchestrator {
  private config: EnsembleConfig;
  private executor: ModelExecutor;
  private enabled: boolean;

  constructor(executor: ModelExecutor, config?: Partial<EnsembleConfig>) {
    this.executor = executor;
    this.config = { ...DEFAULT_ENSEMBLE_CONFIG, ...config };
    this.enabled = (config as any)?.enabled ?? false;
  }

  // ─── Configuration ──────────────────────────────────────────

  /** Check if ensemble is currently enabled */
  isEnabled(): boolean {
    return this.enabled && this.config.models.length >= 2;
  }

  /** Enable ensemble mode */
  enable(): void {
    this.enabled = true;
  }

  /** Disable ensemble mode */
  disable(): void {
    this.enabled = false;
  }

  /** Update configuration (partial merge) */
  updateConfig(updates: Partial<EnsembleConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /** Get current configuration */
  getConfig(): Readonly<EnsembleConfig> {
    return { ...this.config };
  }

  /** Set the model executor (for testing or runtime replacement) */
  setExecutor(executor: ModelExecutor): void {
    this.executor = executor;
  }

  // ─── Trigger Logic ──────────────────────────────────────────

  /**
   * Determine if ensemble should be triggered for a given message.
   * Returns true if ensemble should run, false for single-model execution.
   */
  shouldTrigger(userMessage: string): boolean {
    if (!this.isEnabled()) return false;

    switch (this.config.triggerOn) {
      case "always":
        return true;

      case "complex": {
        const taskType = classifyTask(userMessage);
        return isComplexTask(taskType);
      }

      case "manual":
        // Manual mode: only triggered by explicit /ensemble command
        return false;

      default:
        return false;
    }
  }

  // ─── Execution ──────────────────────────────────────────────

  /**
   * Run the ensemble on a set of messages.
   * This is the main entry point for ensemble execution.
   */
  async run(messages: Message[]): Promise<EnsembleResult> {
    if (!this.isEnabled()) {
      throw new Error("Ensemble is not enabled or has fewer than 2 models configured");
    }

    log.info("ensemble", `Running ${this.config.strategy} with ${this.config.models.length} models`);

    const start = Date.now();

    try {
      const result = await executeStrategy(messages, this.config, this.executor);

      const totalDuration = Date.now() - start;
      log.info("ensemble", `Ensemble completed in ${totalDuration}ms, strategy: ${result.strategy}`);
      log.info("ensemble", `Reasoning: ${result.reasoning}`);

      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("ensemble", `Ensemble failed: ${errorMsg}`);
      throw err;
    }
  }

  /**
   * Run ensemble only if trigger conditions are met.
   * Returns null if ensemble was not triggered (caller should use single-model).
   */
  async tryRun(messages: Message[], userMessage: string): Promise<EnsembleResult | null> {
    if (!this.shouldTrigger(userMessage)) {
      return null;
    }

    return this.run(messages);
  }
}

// ─── Helper Functions ───────────────────────────────────────────

/**
 * Determine if a task type warrants ensemble execution.
 * "complex" trigger mode activates for reasoning and code tasks.
 */
function isComplexTask(taskType: TaskType): boolean {
  return taskType === "reasoning" || taskType === "code";
}

/**
 * Create an EnsembleOrchestrator from settings JSON.
 * Expected format matches the config schema in the plan.
 */
export function createEnsembleFromSettings(
  raw: Record<string, unknown> | null | undefined,
  executor: ModelExecutor,
): EnsembleOrchestrator {
  if (!raw) {
    return new EnsembleOrchestrator(executor);
  }

  const config: Partial<EnsembleConfig> & { enabled?: boolean } = {};

  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
  if (typeof raw.strategy === "string") config.strategy = raw.strategy as EnsembleConfig["strategy"];
  if (Array.isArray(raw.models)) config.models = raw.models.filter((m: unknown) => typeof m === "string") as string[];
  if (typeof raw.judgeModel === "string") config.judgeModel = raw.judgeModel;
  if (typeof raw.maxParallel === "number") config.maxParallel = raw.maxParallel;
  if (typeof raw.timeout === "number") config.timeout = raw.timeout;
  if (typeof raw.minResponses === "number") config.minResponses = raw.minResponses;
  if (typeof raw.triggerOn === "string") config.triggerOn = raw.triggerOn as EnsembleTrigger;

  return new EnsembleOrchestrator(executor, config);
}
