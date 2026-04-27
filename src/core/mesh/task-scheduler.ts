// KCode - P2P Agent Mesh Task Scheduler
// Distributes tasks across mesh peers based on scoring (models, VRAM, CPU, latency).

import { log } from "../logger";
import type { PeerDiscovery } from "./discovery";
import type { MeshTransport } from "./transport";
import type {
  MeshResult,
  MeshTask,
  MeshTaskHandle,
  PeerInfo,
  ScoredPeer,
  TaskStatus,
} from "./types";

// ─── Constants ─────────────────────────────────────────────────

const SCORE_HAS_MODEL = 3;
const SCORE_PER_GB_VRAM = 0.2;
const SCORE_PER_CPU_CORE = 0.1;
const PENALTY_BUSY = -1;
const PENALTY_HIGH_LATENCY = -2;
const HIGH_LATENCY_THRESHOLD_MS = 100;

// ─── TaskScheduler ─────────────────────────────────────────────

export class TaskScheduler {
  private discovery: PeerDiscovery;
  private transport: MeshTransport;
  private pendingResults: Map<string, MeshResult> = new Map();
  private localExecutor: LocalExecutor | null = null;

  constructor(discovery: PeerDiscovery, transport: MeshTransport, localExecutor?: LocalExecutor) {
    this.discovery = discovery;
    this.transport = transport;
    this.localExecutor = localExecutor ?? null;
  }

  // ─── Peer Scoring ─────────────────────────────────────────────

  /**
   * Score a single peer for a given task.
   * Higher score = better fit.
   */
  scorePeer(peer: PeerInfo, task: MeshTask, latencyMs: number): number {
    let score = 0;

    // Bonus: peer has the requested model
    if (task.model && peer.capabilities.models.includes(task.model)) {
      score += SCORE_HAS_MODEL;
    }

    // VRAM and CPU bonuses
    score += peer.capabilities.gpuVram * SCORE_PER_GB_VRAM;
    score += peer.capabilities.cpuCores * SCORE_PER_CPU_CORE;

    // Penalties
    if (peer.status === "busy") {
      score += PENALTY_BUSY;
    }
    if (latencyMs > HIGH_LATENCY_THRESHOLD_MS) {
      score += PENALTY_HIGH_LATENCY;
    }

    return score;
  }

  /**
   * Score and rank all available peers for a task.
   * Measures latency to each peer in parallel.
   */
  async rankPeers(task: MeshTask): Promise<ScoredPeer[]> {
    const peers = this.discovery.getAvailablePeers();

    if (peers.length === 0) return [];

    const scored = await Promise.all(
      peers.map(async (peer) => {
        const latency = await this.measureLatency(peer);
        const score = this.scorePeer(peer, task, latency);
        return { peer, score, latency };
      }),
    );

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * Select the best available peer for a task.
   * Throws if no peers are available.
   */
  async schedule(task: MeshTask): Promise<PeerInfo> {
    const ranked = await this.rankPeers(task);

    if (ranked.length === 0) {
      throw new Error("No peers available. Running locally.");
    }

    log.debug(
      "mesh-scheduler",
      `Scheduled task ${task.id} to peer ${ranked[0]!.peer.nodeId} (score: ${ranked[0]!.score.toFixed(2)})`,
    );

    return ranked[0]!.peer;
  }

  // ─── Distributed Execution ────────────────────────────────────

  /**
   * Execute a task across multiple peers + local node.
   * Splits files among available peers and runs in parallel.
   */
  async executeDistributed(task: MeshTask): Promise<MeshResult> {
    const files = task.files ?? [];
    const peers = this.discovery.getAvailablePeers();
    const totalWorkers = peers.length + 1; // +1 for local
    const chunkSize = Math.max(1, Math.ceil(files.length / totalWorkers));

    const assignments: Array<{ peer: PeerInfo | null; files: string[] }> = [];

    for (let i = 0; i < files.length; i += chunkSize) {
      const chunk = files.slice(i, i + chunkSize);
      const peerIndex = Math.floor(i / chunkSize);

      if (peerIndex < peers.length) {
        assignments.push({ peer: peers[peerIndex] ?? null, files: chunk });
      } else {
        assignments.push({ peer: null, files: chunk }); // Local execution
      }
    }

    // If no files, still create one assignment for local execution
    if (assignments.length === 0) {
      assignments.push({ peer: null, files: [] });
    }

    const start = Date.now();
    const results = await Promise.allSettled(
      assignments.map((a) => {
        const subTask: MeshTask = { ...task, files: a.files };
        if (a.peer) {
          return this.transport.sendTask(a.peer, subTask).then(
            (handle) =>
              ({
                taskId: handle.taskId,
                status: "completed" as TaskStatus,
                output: `Delegated to ${handle.assignedTo}`,
                durationMs: Date.now() - start,
                fromNode: handle.assignedTo,
              }) satisfies MeshResult,
          );
        }
        return this.executeLocal(subTask);
      }),
    );

    return this.mergeResults(task.id, results, start);
  }

  // ─── Local Execution ──────────────────────────────────────────

  /**
   * Execute a task on the local node.
   */
  async executeLocal(task: MeshTask): Promise<MeshResult> {
    const start = Date.now();

    try {
      if (this.localExecutor) {
        const output = await this.localExecutor(task);
        return {
          taskId: task.id,
          status: "completed",
          output,
          durationMs: Date.now() - start,
          fromNode: "local",
        };
      }

      // Default: just acknowledge the task
      return {
        taskId: task.id,
        status: "completed",
        output: `Task ${task.id} executed locally (${task.files?.length ?? 0} files)`,
        durationMs: Date.now() - start,
        fromNode: "local",
      };
    } catch (err) {
      return {
        taskId: task.id,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        fromNode: "local",
      };
    }
  }

  // ─── Result Management ────────────────────────────────────────

  /**
   * Store a result received from a peer.
   */
  storeResult(result: MeshResult): void {
    this.pendingResults.set(result.taskId, result);
  }

  /**
   * Retrieve a stored result, or undefined if not yet available.
   */
  getResult(taskId: string): MeshResult | undefined {
    return this.pendingResults.get(taskId);
  }

  /**
   * Merge results from multiple parallel executions into a single result.
   */
  mergeResults(
    taskId: string,
    results: PromiseSettledResult<MeshResult>[],
    startTime: number,
  ): MeshResult {
    const outputs: string[] = [];
    const errors: string[] = [];

    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value.status === "completed" && r.value.output) {
          outputs.push(r.value.output);
        }
        if (r.value.status === "failed" && r.value.error) {
          errors.push(r.value.error);
        }
      } else {
        errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
    }

    const hasSuccess = outputs.length > 0;

    return {
      taskId,
      status: hasSuccess ? "completed" : "failed",
      output: hasSuccess ? outputs.join("\n---\n") : undefined,
      error: errors.length > 0 ? errors.join("; ") : undefined,
      durationMs: Date.now() - startTime,
      fromNode: "merged",
    };
  }

  // ─── Latency Measurement ──────────────────────────────────────

  /**
   * Measure round-trip latency to a peer via the health endpoint.
   */
  async measureLatency(peer: PeerInfo): Promise<number> {
    const latency = await this.transport.ping(peer);
    return latency >= 0 ? latency : Infinity;
  }
}

// ─── Local Executor Type ───────────────────────────────────────

export type LocalExecutor = (task: MeshTask) => Promise<string>;

// ─── Exports ───────────────────────────────────────────────────

export {
  HIGH_LATENCY_THRESHOLD_MS,
  PENALTY_BUSY,
  PENALTY_HIGH_LATENCY,
  SCORE_HAS_MODEL,
  SCORE_PER_CPU_CORE,
  SCORE_PER_GB_VRAM,
};
