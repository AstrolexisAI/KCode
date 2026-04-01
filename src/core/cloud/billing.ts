// KCode - Cloud Billing and Usage Tracking
// Monitors team usage against plan limits and generates formatted reports.

import type { CloudClient } from "./client";
import type { CloudTeam } from "./types";

/** Threshold at which to generate usage warnings (80% of limit) */
const WARNING_THRESHOLD = 0.8;

export class BillingManager {
  private client: CloudClient;

  constructor(client: CloudClient) {
    this.client = client;
  }

  /**
   * Get current team usage from the cloud service.
   */
  async getUsage(): Promise<CloudTeam["usage"]> {
    const team = await this.client.getTeam();
    return team.usage;
  }

  /**
   * Check current usage against plan limits.
   * Returns whether usage is within limits and any warnings
   * for metrics approaching their thresholds.
   */
  async checkLimits(): Promise<{ within: boolean; warnings: string[] }> {
    const team = await this.client.getTeam();
    return {
      within: this.isWithinLimits(team.usage, team.limits),
      warnings: this.generateWarnings(team.usage, team.limits),
    };
  }

  /**
   * Generate a formatted usage report string showing current
   * consumption against plan limits.
   */
  formatUsage(usage: CloudTeam["usage"], limits: CloudTeam["limits"]): string {
    const lines: string[] = [];
    lines.push("Cloud Usage Report");
    lines.push("==================");
    lines.push("");

    lines.push(
      `Sessions:  ${usage.sessionsThisMonth} / ${limits.maxSessions} ` +
        `(${this.pct(usage.sessionsThisMonth, limits.maxSessions)})`,
    );
    lines.push(
      `Tokens:    ${this.formatNumber(usage.tokensThisMonth)} / ${this.formatNumber(limits.maxTokensPerMonth)} ` +
        `(${this.pct(usage.tokensThisMonth, limits.maxTokensPerMonth)})`,
    );
    lines.push(
      `Storage:   ${usage.storageUsedMb} MB / ${limits.maxStorageMb} MB ` +
        `(${this.pct(usage.storageUsedMb, limits.maxStorageMb)})`,
    );

    const warnings = this.generateWarnings(usage, limits);
    if (warnings.length > 0) {
      lines.push("");
      lines.push("Warnings:");
      for (const w of warnings) {
        lines.push(`  - ${w}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Check if all usage metrics are within plan limits.
   */
  isWithinLimits(usage: CloudTeam["usage"], limits: CloudTeam["limits"]): boolean {
    if (usage.sessionsThisMonth > limits.maxSessions) return false;
    if (usage.tokensThisMonth > limits.maxTokensPerMonth) return false;
    if (usage.storageUsedMb > limits.maxStorageMb) return false;
    return true;
  }

  /**
   * Generate warning messages for any metrics that exceed the
   * WARNING_THRESHOLD (80%) of their limit.
   */
  private generateWarnings(usage: CloudTeam["usage"], limits: CloudTeam["limits"]): string[] {
    const warnings: string[] = [];

    if (
      limits.maxSessions > 0 &&
      usage.sessionsThisMonth >= limits.maxSessions * WARNING_THRESHOLD
    ) {
      const pct = this.pct(usage.sessionsThisMonth, limits.maxSessions);
      warnings.push(`Session usage at ${pct} (${usage.sessionsThisMonth}/${limits.maxSessions})`);
    }

    if (
      limits.maxTokensPerMonth > 0 &&
      usage.tokensThisMonth >= limits.maxTokensPerMonth * WARNING_THRESHOLD
    ) {
      const pct = this.pct(usage.tokensThisMonth, limits.maxTokensPerMonth);
      warnings.push(
        `Token usage at ${pct} (${this.formatNumber(usage.tokensThisMonth)}/${this.formatNumber(limits.maxTokensPerMonth)})`,
      );
    }

    if (limits.maxStorageMb > 0 && usage.storageUsedMb >= limits.maxStorageMb * WARNING_THRESHOLD) {
      const pct = this.pct(usage.storageUsedMb, limits.maxStorageMb);
      warnings.push(`Storage usage at ${pct} (${usage.storageUsedMb}MB/${limits.maxStorageMb}MB)`);
    }

    return warnings;
  }

  /**
   * Format a number with commas for readability.
   */
  private formatNumber(n: number): string {
    return n.toLocaleString("en-US");
  }

  /**
   * Calculate percentage string from value/max.
   */
  private pct(value: number, max: number): string {
    if (max === 0) return "0%";
    return Math.round((value / max) * 100) + "%";
  }
}
