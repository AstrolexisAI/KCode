// KCode - Cloud Team Memory Management
// Handles syncing team-scoped memories between local storage and cloud,
// plus team analytics and policy management.

import { log } from "../logger";
import type { CloudClient } from "./client";
import type { TeamAnalytics, TeamPolicies } from "./types";

export interface TeamMemoryEntry {
  id: string;
  key: string;
  value: string;
  scope: "team" | "personal";
  updatedAt: string;
  updatedBy: string;
}

export class TeamMemory {
  private client: CloudClient;

  constructor(client: CloudClient) {
    this.client = client;
  }

  /**
   * Synchronize local team-scoped memories with the cloud.
   * Uploads local memories, downloads remote ones, and merges
   * using timestamp-based conflict resolution (newer wins).
   */
  async syncMemories(localMemories: TeamMemoryEntry[]): Promise<TeamMemoryEntry[]> {
    // Upload local memories to cloud
    const remoteMemories = await this.client.request<TeamMemoryEntry[]>(
      "POST",
      "/api/v1/memories/sync",
      { memories: localMemories },
    );

    // Merge local and remote with timestamp-based resolution
    const merged = this.mergeMemories(localMemories, remoteMemories);

    log.debug(
      "cloud-team",
      `Memory sync: ${localMemories.length} local, ${remoteMemories.length} remote, ${merged.length} merged`,
    );

    return merged;
  }

  /**
   * Get team analytics for the specified period.
   * Delegates to the CloudClient.
   */
  async getTeamAnalytics(period: "day" | "week" | "month"): Promise<TeamAnalytics> {
    return this.client.getAnalytics(period);
  }

  /**
   * Get the team's current policies.
   * Delegates to the CloudClient.
   */
  async getTeamPolicies(): Promise<TeamPolicies> {
    return this.client.getPolicies();
  }

  /**
   * Update team policies (partial update).
   * Delegates to the CloudClient.
   */
  async updateTeamPolicies(policies: Partial<TeamPolicies>): Promise<void> {
    return this.client.updatePolicies(policies);
  }

  /**
   * Merge local and remote memories with remote precedence on
   * timestamp conflicts. Entries are matched by their `key` field.
   *
   * Rules:
   * - If a key exists only locally, keep it
   * - If a key exists only remotely, keep it
   * - If a key exists in both, keep the one with the newer updatedAt timestamp
   *   (remote wins on tie)
   */
  mergeMemories(local: TeamMemoryEntry[], remote: TeamMemoryEntry[]): TeamMemoryEntry[] {
    const merged = new Map<string, TeamMemoryEntry>();

    // Add all local entries first
    for (const entry of local) {
      merged.set(entry.key, entry);
    }

    // Overlay remote entries, keeping newer timestamps
    for (const entry of remote) {
      const existing = merged.get(entry.key);
      if (!existing) {
        // Only exists remotely
        merged.set(entry.key, entry);
        continue;
      }

      const localTime = new Date(existing.updatedAt).getTime();
      const remoteTime = new Date(entry.updatedAt).getTime();

      // Remote wins on tie (>=)
      if (remoteTime >= localTime) {
        merged.set(entry.key, entry);
      }
    }

    return Array.from(merged.values());
  }
}
