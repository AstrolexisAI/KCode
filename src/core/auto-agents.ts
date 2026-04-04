// KCode - Auto Agent Spawner
// Detects when a plan has multiple independent pending steps and auto-spawns
// background agents to work on them in parallel. Reports progress to the UI
// via a callback so the Kodi panel can show live agent logs.

import { log } from "./logger";
import { findKCodeBinary } from "./swarm";
import type { KCodeConfig } from "./types";

// ─── Types ──────────────────────────────────────────────────────

export interface AutoAgentConfig {
  /** Minimum pending steps to trigger auto-spawning */
  minPendingSteps: number;
  /** Maximum agents to spawn at once */
  maxAgents: number;
  /** Working directory for agents */
  cwd: string;
  /** Model to use (inherits from main session) */
  model: string;
  /** Config for API key inheritance */
  config: KCodeConfig;
}

export interface AgentStatus {
  id: string;
  name: string;
  stepId: string;
  stepTitle: string;
  status: "spawning" | "running" | "done" | "failed";
  output?: string;
  error?: string;
  startTime: number;
  durationMs?: number;
}

export type AgentProgressCallback = (agents: AgentStatus[]) => void;

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_MIN_PENDING = 3;
const DEFAULT_MAX_AGENTS = 4;
const AGENT_TIMEOUT_MS = 180_000; // 3 minutes per agent

// ─── Auto Agent Manager ─────────────────────────────────────────

export class AutoAgentManager {
  private agents: Map<string, AgentStatus> = new Map();
  private onProgress: AgentProgressCallback;
  private cfg: AutoAgentConfig;
  private active = false;

  constructor(cfg: Partial<AutoAgentConfig> & { cwd: string; model: string; config: KCodeConfig }, onProgress: AgentProgressCallback) {
    this.cfg = {
      minPendingSteps: cfg.minPendingSteps ?? DEFAULT_MIN_PENDING,
      maxAgents: cfg.maxAgents ?? DEFAULT_MAX_AGENTS,
      ...cfg,
    };
    this.onProgress = onProgress;
  }

  /**
   * Check if auto-spawning should trigger based on the current plan.
   * Returns the steps that would be assigned to agents.
   */
  async evaluate(): Promise<{ shouldSpawn: boolean; steps: Array<{ id: string; title: string }> }> {
    try {
      const { getActivePlan } = await import("../tools/plan.js");
      const plan = getActivePlan();
      if (!plan) return { shouldSpawn: false, steps: [] };

      const pendingSteps = plan.steps.filter((s) => s.status === "pending");
      if (pendingSteps.length < this.cfg.minPendingSteps) {
        return { shouldSpawn: false, steps: [] };
      }

      // Take up to maxAgents steps
      const steps = pendingSteps.slice(0, this.cfg.maxAgents).map((s) => ({
        id: s.id,
        title: s.title,
      }));

      return { shouldSpawn: true, steps };
    } catch {
      return { shouldSpawn: false, steps: [] };
    }
  }

  /**
   * Spawn background agents for the given plan steps.
   * Non-blocking — agents run in background and report via onProgress callback.
   */
  async spawn(steps: Array<{ id: string; title: string }>, masterContext: string): Promise<void> {
    if (this.active) {
      log.warn("auto-agents", "Already running — skipping spawn");
      return;
    }

    this.active = true;
    this.agents.clear();

    const kcodeBin = findKCodeBinary();
    const { execFile } = await import("node:child_process");

    log.info("auto-agents", `Spawning ${steps.length} agents for plan steps`);

    const promises = steps.map(async (step, i) => {
      const agentId = `auto-${Date.now()}-${i}`;
      const agentName = `agent-${step.id}`;

      const status: AgentStatus = {
        id: agentId,
        name: agentName,
        stepId: step.id,
        stepTitle: step.title,
        status: "spawning",
        startTime: Date.now(),
      };
      this.agents.set(agentId, status);
      this.notifyProgress();

      const prompt = [
        `You are working on plan step: "${step.title}"`,
        `Context from the main session:\n${masterContext.slice(0, 2000)}`,
        `Complete this step thoroughly. When done, output a brief summary of what you did.`,
      ].join("\n\n");

      const args = ["--print", "--permission", "auto", "--max-turns", "15", prompt];

      // Inherit API keys from parent
      const env: Record<string, string | undefined> = { ...process.env };
      if (this.cfg.config.apiKey) env.KCODE_API_KEY = this.cfg.config.apiKey;
      if (this.cfg.config.anthropicApiKey) env.ANTHROPIC_API_KEY = this.cfg.config.anthropicApiKey;

      return new Promise<void>((resolve) => {
        status.status = "running";
        this.notifyProgress();

        execFile(
          kcodeBin,
          args,
          {
            cwd: this.cfg.cwd,
            timeout: AGENT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024, // 1MB
            env,
          },
          (err, stdout, stderr) => {
            status.durationMs = Date.now() - status.startTime;

            if (err) {
              status.status = "failed";
              status.error = (stderr || err.message).slice(0, 500);
              log.warn("auto-agents", `Agent ${agentName} failed: ${status.error}`);
            } else {
              status.status = "done";
              status.output = stdout.trim().slice(0, 5000);
              log.info("auto-agents", `Agent ${agentName} completed in ${status.durationMs}ms`);
            }

            this.notifyProgress();
            resolve();
          },
        );
      });
    });

    // Wait for all agents to complete
    await Promise.allSettled(promises);
    this.active = false;
    this.notifyProgress();

    log.info(
      "auto-agents",
      `All agents done: ${this.getCompletedCount()} done, ${this.getFailedCount()} failed`,
    );
  }

  /** Get all agent statuses */
  getStatuses(): AgentStatus[] {
    return [...this.agents.values()];
  }

  /** Get results from completed agents */
  getResults(): Array<{ stepId: string; stepTitle: string; output: string }> {
    return [...this.agents.values()]
      .filter((a) => a.status === "done" && a.output)
      .map((a) => ({ stepId: a.stepId, stepTitle: a.stepTitle, output: a.output! }));
  }

  isActive(): boolean {
    return this.active;
  }

  private getCompletedCount(): number {
    return [...this.agents.values()].filter((a) => a.status === "done").length;
  }

  private getFailedCount(): number {
    return [...this.agents.values()].filter((a) => a.status === "failed").length;
  }

  private notifyProgress(): void {
    try {
      this.onProgress(this.getStatuses());
    } catch (err) {
      log.debug("auto-agents", `Progress callback error: ${err}`);
    }
  }
}
