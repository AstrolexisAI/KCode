// KCode - Apple Neural Engine (ANE) Embedder
//
// Pro-tier, macOS-arm64-only embedder backed by a Swift helper that
// runs Core ML on the Neural Engine. Compared to LocalEmbedder
// (Ollama / llama.cpp): zero network, zero VRAM contention with the
// main LLM, ~50ms for batch=32, INT8 weights so the bundle is small.
//
// Architecture:
//   1. Helper binary (~/.kcode/ane/ane-embedder) is a long-lived
//      Swift/Core ML process.
//   2. KCode spawns it on first embed() call, keeps it alive for the
//      session, pipes JSON-RPC over stdin/stdout.
//   3. Helper loads the .mlmodelc once, processes embed requests
//      until stdin closes.
//   4. We dispose the process at KCode exit (SIGTERM).
//
// Detection (see embedder-factory.ts):
//   process.platform === "darwin" && process.arch === "arm64"
//   AND helper binary exists at the expected path
//   AND user has Pro license (isPro())
//
// Failure modes (all soft-fail to fallback embedder):
//   - Helper not bundled (Linux / non-Pro install) → factory picks
//     LocalEmbedder or TfIdfEmbedder instead.
//   - Helper crash / EOF mid-session → reset the process, retry once,
//     then surface error to caller.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger";
import type { EmbedderInterface } from "./embedder";

/** Path the build script installs the helper + model at. */
export function aneHelperPath(): string {
  return join(homedir(), ".kcode", "ane", "ane-embedder");
}

export function aneModelPath(): string {
  return join(homedir(), ".kcode", "ane", "BGE-M3.mlmodelc");
}

/**
 * True if the bundled Swift helper + Core ML model are present at
 * the expected paths. Cheap synchronous probe — no spawn until the
 * caller actually constructs an ANEEmbedder.
 */
export function isANEAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  if (process.arch !== "arm64") return false;
  return existsSync(aneHelperPath()) && existsSync(aneModelPath());
}

interface PendingRequest {
  resolve: (vectors: number[][]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 10_000;
// BGE-M3 default. The helper reports actual dim on /health; we use
// that to override if a different model gets dropped in.
const DEFAULT_DIM = 1024;

export class ANEEmbedder implements EmbedderInterface {
  readonly dimensions: number = DEFAULT_DIM;

  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private startError: Error | null = null;

  constructor() {
    // Lazy spawn: first embed() call triggers the helper.
  }

  private ensureProc(): void {
    if (this.proc && !this.proc.killed) return;
    if (this.startError) throw this.startError;

    const helper = aneHelperPath();
    if (!existsSync(helper)) {
      this.startError = new Error(`ANE helper not found at ${helper}`);
      throw this.startError;
    }
    const model = aneModelPath();
    if (!existsSync(model)) {
      this.startError = new Error(`Core ML model not found at ${model}`);
      throw this.startError;
    }

    this.proc = spawn(helper, [model], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    // Detach from the event loop so node can exit when our work is
    // done. Without this, one-shot CLI commands like `kcode rag
    // search` hang for ~5 minutes after printing results because the
    // long-lived helper subprocess keeps node alive (seen 2026-05-09
    // on Mac after introducing the Python tokenizer sidecar; the
    // Python child of the helper compounded the problem). Explicit
    // disposeANEEmbedder() in the finally block still cleans up.
    this.proc.unref();

    this.proc.stdout?.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf-8")));
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      // Surface helper errors at debug level — Swift logs go here.
      log.debug("ane", `helper stderr: ${chunk.toString("utf-8").trim()}`);
    });
    this.proc.on("exit", (code, signal) => {
      log.warn("ane", `helper exited (code=${code}, signal=${signal})`);
      // Reject any in-flight requests so callers don't hang.
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`ANE helper exited mid-request (code=${code}, signal=${signal})`));
      }
      this.pending.clear();
      this.proc = null;
    });
    this.proc.on("error", (err) => {
      log.error("ane", `helper spawn error: ${err.message}`);
      this.startError = err;
      this.proc = null;
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    // Parse line-delimited JSON.
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          result?: number[][];
          error?: string;
        };
        if (typeof msg.id !== "number") continue;
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`ANE helper error: ${msg.error}`));
        } else if (Array.isArray(msg.result)) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(`ANE helper returned malformed payload: ${line.slice(0, 120)}`));
        }
      } catch (err) {
        log.debug("ane", `failed to parse helper line: ${err}`);
      }
    }
  }

  async embed(text: string): Promise<number[]> {
    const out = await this.embedBatch([text]);
    if (out.length === 0) throw new Error("ANE helper returned empty batch");
    return out[0]!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.ensureProc();
    if (!this.proc?.stdin) throw new Error("ANE helper stdin not available");

    const id = this.nextId++;
    return new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`ANE helper request timeout (${REQUEST_TIMEOUT_MS}ms) for id=${id}`));
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const payload = `${JSON.stringify({ id, method: "embed", texts })}\n`;
      try {
        this.proc?.stdin?.write(payload, (err) => {
          if (err) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(new Error(`ANE helper write failed: ${err.message}`));
          }
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Stop the helper process. Idempotent. */
  shutdown(): void {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill("SIGTERM");
      } catch (err) {
        log.debug("ane", `failed to SIGTERM helper: ${err}`);
      }
    }
    this.proc = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("ANE embedder shutdown"));
    }
    this.pending.clear();
  }
}

// ─── Module-level singleton ────────────────────────────────────
//
// Embedders are stateful (the helper process). We share one across
// the session — a single .mlmodelc load instead of N. Caller doesn't
// need to manage lifecycle; KCode shutdown calls disposeANEEmbedder.

let _instance: ANEEmbedder | null = null;

export function getANEEmbedder(): ANEEmbedder {
  if (!_instance) _instance = new ANEEmbedder();
  return _instance;
}

export function disposeANEEmbedder(): void {
  if (_instance) {
    _instance.shutdown();
    _instance = null;
  }
}
