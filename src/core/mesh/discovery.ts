// KCode - P2P Agent Mesh Discovery
// Discover peers on LAN via mDNS multicast, manual config, or shared file directory.

import type { PeerInfo, PeerCapabilities, DiscoveryMethod } from "./types";
import { log } from "../logger";

// ─── Constants ─────────────────────────────────────────────────

const MDNS_MULTICAST_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;
const KCODE_SERVICE_TYPE = "_kcode-mesh._tcp";
const ANNOUNCE_INTERVAL_MS = 30_000;    // Re-announce every 30s
const PEER_TIMEOUT_MS = 90_000;         // Consider peer offline after 90s without heartbeat
const SHARED_FILE_POLL_MS = 10_000;     // Poll shared directory every 10s

// ─── PeerDiscovery ─────────────────────────────────────────────

export class PeerDiscovery {
  private peers: Map<string, PeerInfo> = new Map();
  private localNodeId: string;
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private sharedFilePollTimer: ReturnType<typeof setInterval> | null = null;
  private _stopped = false;

  constructor(localNodeId: string) {
    this.localNodeId = localNodeId;
  }

  // ─── mDNS Discovery (automatic LAN) ──────────────────────────

  /**
   * Start mDNS-based discovery.
   * Publishes this node and listens for other nodes on the LAN.
   *
   * In production this would use Bun.udpSocket for multicast DNS.
   * Currently provides the registration/management layer while the
   * actual UDP multicast binding is handled at the transport level.
   */
  async startMDNS(localInfo: PeerInfo): Promise<void> {
    if (this._stopped) return;

    // Register ourselves
    this.updatePeer(localInfo);

    // Start periodic announcements (transport layer handles actual sending)
    this.announceTimer = setInterval(() => {
      if (this._stopped) return;
      localInfo.lastSeen = Date.now();
      this.updatePeer(localInfo);
    }, ANNOUNCE_INTERVAL_MS);

    // Prune stale peers periodically
    this.pruneTimer = setInterval(() => {
      this.pruneStale();
    }, PEER_TIMEOUT_MS / 3);

    log.debug("mesh-discovery", `mDNS discovery started for node ${this.localNodeId}`);
  }

  // ─── Manual Peer Configuration ────────────────────────────────

  /**
   * Load manually configured peers from settings.
   * Probes each one to get capabilities via /api/v1/capabilities.
   */
  async loadManualPeers(
    peers: Array<{ host: string; port: number }>,
    teamToken: string,
  ): Promise<void> {
    const probeResults = await Promise.allSettled(
      peers.map((p) => this.probePeer(p.host, p.port, teamToken)),
    );

    for (const result of probeResults) {
      if (result.status === "fulfilled" && result.value) {
        this.updatePeer(result.value);
      }
    }

    log.debug(
      "mesh-discovery",
      `Manual peer load: ${peers.length} configured, ${this.peers.size} reachable`,
    );
  }

  /**
   * Probe a single peer to get its info.
   * Returns null if the peer is unreachable.
   */
  async probePeer(
    host: string,
    port: number,
    teamToken: string,
  ): Promise<PeerInfo | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      const response = await fetch(
        `http://${host}:${port}/api/v1/capabilities`,
        {
          headers: { "X-Team-Token": teamToken },
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);

      if (!response.ok) return null;

      const info = (await response.json()) as PeerInfo;
      info.lastSeen = Date.now();
      info.status = "online";
      return info;
    } catch (err) {
      log.debug("mesh-discovery", `Probe failed for ${host}:${port}: ${err}`);
      return null;
    }
  }

  // ─── Shared File Discovery ────────────────────────────────────

  /**
   * Start shared-file discovery.
   * Each node writes its info to {dirPath}/{nodeId}.json.
   * Polls the directory for other node files.
   */
  async startSharedFile(dirPath: string, localInfo: PeerInfo): Promise<void> {
    if (this._stopped) return;

    // Write our own info file
    await this.writeSharedInfo(dirPath, localInfo);

    // Read all peer files once immediately
    await this.readSharedPeers(dirPath);

    // Poll periodically
    this.sharedFilePollTimer = setInterval(async () => {
      if (this._stopped) return;
      // Refresh our own file
      localInfo.lastSeen = Date.now();
      await this.writeSharedInfo(dirPath, localInfo);
      await this.readSharedPeers(dirPath);
    }, SHARED_FILE_POLL_MS);

    log.debug("mesh-discovery", `Shared-file discovery started at ${dirPath}`);
  }

  private async writeSharedInfo(dirPath: string, info: PeerInfo): Promise<void> {
    try {
      const filePath = `${dirPath}/${info.nodeId}.json`;
      await Bun.write(filePath, JSON.stringify(info, null, 2));
    } catch (err) {
      log.debug("mesh-discovery", `Failed to write shared info: ${err}`);
    }
  }

  private async readSharedPeers(dirPath: string): Promise<void> {
    try {
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(dirPath).filter((f) => f.endsWith(".json"));

      for (const file of files) {
        try {
          const content = await Bun.file(`${dirPath}/${file}`).text();
          const peer = JSON.parse(content) as PeerInfo;
          if (peer.nodeId && peer.nodeId !== this.localNodeId) {
            this.updatePeer(peer);
          }
        } catch {
          // Skip malformed files
        }
      }
    } catch (err) {
      log.debug("mesh-discovery", `Failed to read shared peers: ${err}`);
    }
  }

  // ─── Peer Management ──────────────────────────────────────────

  /**
   * Register or update a peer's info.
   */
  updatePeer(info: PeerInfo): void {
    this.peers.set(info.nodeId, { ...info });
  }

  /**
   * Remove a peer by ID.
   */
  removePeer(nodeId: string): boolean {
    return this.peers.delete(nodeId);
  }

  /**
   * Mark a peer as offline.
   */
  markOffline(nodeId: string): void {
    const peer = this.peers.get(nodeId);
    if (peer) {
      peer.status = "offline";
    }
  }

  /**
   * Get a peer by ID, or undefined if not known.
   */
  getPeer(nodeId: string): PeerInfo | undefined {
    return this.peers.get(nodeId);
  }

  /**
   * Get all known peers (including offline ones).
   */
  getAllPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  /**
   * Get available (online) peers sorted by GPU VRAM descending.
   * Excludes the local node.
   */
  getAvailablePeers(): PeerInfo[] {
    return Array.from(this.peers.values())
      .filter(
        (p) => p.status === "online" && p.nodeId !== this.localNodeId,
      )
      .sort((a, b) => b.capabilities.gpuVram - a.capabilities.gpuVram);
  }

  /**
   * Prune peers that haven't been seen within the timeout window.
   */
  pruneStale(): number {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    let pruned = 0;

    for (const [nodeId, peer] of this.peers) {
      if (nodeId === this.localNodeId) continue;
      if (peer.lastSeen < cutoff) {
        peer.status = "offline";
        pruned++;
      }
    }

    if (pruned > 0) {
      log.debug("mesh-discovery", `Pruned ${pruned} stale peers`);
    }
    return pruned;
  }

  /**
   * Stop all discovery mechanisms and clean up timers.
   */
  stop(): void {
    this._stopped = true;
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.sharedFilePollTimer) {
      clearInterval(this.sharedFilePollTimer);
      this.sharedFilePollTimer = null;
    }
    log.debug("mesh-discovery", "Discovery stopped");
  }

  /** Total number of known peers (all statuses) */
  get size(): number {
    return this.peers.size;
  }

  get stopped(): boolean {
    return this._stopped;
  }
}

// ─── Exports ───────────────────────────────────────────────────

export {
  MDNS_MULTICAST_ADDR,
  MDNS_PORT,
  KCODE_SERVICE_TYPE,
  ANNOUNCE_INTERVAL_MS,
  PEER_TIMEOUT_MS,
  SHARED_FILE_POLL_MS,
};
