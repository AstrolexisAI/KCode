// KCode - Offline Mode Controller
// Central coordinator for offline operation: detects connectivity, audits local resources,
// and provides a singleton that the rest of the codebase queries.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger";
import type { LocalResources, OfflineSettings, OfflineState } from "./types";

// ─── Defaults ──────────────────────────────────────────────────

const NETWORK_CHECK_INTERVAL_MS = 60_000; // 60 seconds cache for connectivity checks

function defaultState(): OfflineState {
  return {
    forced: false,
    detected: false,
    active: false,
    lastNetworkCheck: 0,
    localResources: {
      hasLocalModel: false,
      hasLocalWhisper: false,
      hasPluginCache: false,
      hasCachedDocs: false,
    },
  };
}

// ─── OfflineMode Class ─────────────────────────────────────────

export class OfflineMode {
  private state: OfflineState;
  /** Configurable settings (loaded from settings.json at startup) */
  private settings: OfflineSettings;
  /** Allow injection of a custom DNS resolver for testing */
  private dnsResolver: (hostname: string) => Promise<unknown>;
  /** Allow injection of a custom fetch for testing */
  private fetchFn: typeof fetch;

  constructor(opts?: {
    settings?: OfflineSettings;
    dnsResolver?: (hostname: string) => Promise<unknown>;
    fetchFn?: typeof fetch;
  }) {
    this.state = defaultState();
    this.settings = opts?.settings ?? {};
    this.dnsResolver = opts?.dnsResolver ?? OfflineMode.defaultDnsResolver;
    this.fetchFn = opts?.fetchFn ?? fetch;

    // If settings say enabled, force it on immediately
    if (this.settings.enabled) {
      this.state.forced = true;
      this.state.active = true;
    }
  }

  // ─── Public API ────────────────────────────────────────────

  /** Activate offline mode manually (e.g. --offline flag) */
  enable(): void {
    this.state.forced = true;
    this.state.active = true;
    log.info("offline", "Offline mode enabled (forced)");
  }

  /** Deactivate manual offline mode (auto-detect still applies) */
  disable(): void {
    this.state.forced = false;
    this.state.active = this.state.detected;
    log.info("offline", `Offline mode disabled (auto-detect: ${this.state.detected})`);
  }

  /** Whether offline mode is currently active (forced or detected) */
  isActive(): boolean {
    return this.state.active;
  }

  /** Return a snapshot of the current state (for diagnostics / doctor) */
  getState(): Readonly<OfflineState> {
    return { ...this.state, localResources: { ...this.state.localResources } };
  }

  /**
   * Check network connectivity (non-blocking, cached for 60 seconds).
   * Returns true if online, false if offline.
   */
  async checkConnectivity(): Promise<boolean> {
    // If forced offline, skip the check
    if (this.state.forced) return false;

    // Use cached result if recent
    if (Date.now() - this.state.lastNetworkCheck < NETWORK_CHECK_INTERVAL_MS) {
      return !this.state.detected;
    }

    try {
      await this.dnsResolver("dns.google");
      this.state.detected = false;
      this.state.active = this.state.forced;
      this.state.lastNetworkCheck = Date.now();
      return true;
    } catch {
      this.state.detected = true;
      this.state.active = true;
      this.state.lastNetworkCheck = Date.now();
      log.info("offline", "Network not available (DNS check failed)");
      return false;
    }
  }

  /** Audit locally available resources */
  async auditLocalResources(): Promise<LocalResources> {
    const resources: LocalResources = {
      hasLocalModel: await this.detectLocalModel(),
      hasLocalWhisper: this.detectWhisper(),
      hasPluginCache: existsSync(join(homedir(), ".kcode", "plugins", "marketplace-cache")),
      hasCachedDocs: existsSync(join(homedir(), ".kcode", "cache", "docs")),
    };
    this.state.localResources = resources;
    return resources;
  }

  /** Generate system prompt section when offline */
  notifySystemPrompt(): string {
    if (!this.state.active) return "";
    return [
      "## Offline Mode Active",
      "You do NOT have internet access. WebFetch and WebSearch tools are unavailable for remote URLs.",
      "Use only local tools: Read, Write, Edit, Bash, Glob, Grep, etc.",
      "If external information is needed, ask the user to look it up manually.",
    ].join("\n");
  }

  // ─── Private Helpers ───────────────────────────────────────

  /** Check if a local inference server is reachable */
  private async detectLocalModel(): Promise<boolean> {
    const endpoints = ["http://localhost:10091/health", "http://localhost:11434/api/tags"];
    for (const url of endpoints) {
      try {
        const r = await this.fetchFn(url, { signal: AbortSignal.timeout(2000) });
        if (r.ok) return true;
      } catch {
        /* continue */
      }
    }
    return false;
  }

  /** Check if whisper-cpp or faster-whisper is in PATH */
  private detectWhisper(): boolean {
    try {
      const r1 = Bun.spawnSync(["which", "whisper-cpp"]);
      if (r1.exitCode === 0) return true;
    } catch {
      /* ignore */
    }
    try {
      const r2 = Bun.spawnSync(["which", "faster-whisper"]);
      if (r2.exitCode === 0) return true;
    } catch {
      /* ignore */
    }
    return false;
  }

  /** Default DNS resolver using Bun.dns */
  private static async defaultDnsResolver(hostname: string): Promise<unknown> {
    // Bun.dns.resolve returns an array of addresses — if it throws, no network
    return (
      (Bun as any).dns?.resolve?.(hostname, "A") ??
      Promise.reject(new Error("Bun.dns not available"))
    );
  }
}

// ─── Singleton ─────────────────────────────────────────────────

let _instance: OfflineMode | null = null;

export function getOfflineMode(): OfflineMode {
  if (!_instance) {
    _instance = new OfflineMode();
  }
  return _instance;
}

/** Initialise the singleton with settings (called once at startup) */
export function initOfflineMode(opts?: {
  settings?: OfflineSettings;
  forced?: boolean;
}): OfflineMode {
  _instance = new OfflineMode({ settings: opts?.settings });
  if (opts?.forced) {
    _instance.enable();
  }
  return _instance;
}

/** Reset the singleton (for testing) */
export function resetOfflineMode(): void {
  _instance = null;
}
