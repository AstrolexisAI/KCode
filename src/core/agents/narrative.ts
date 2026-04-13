// KCode — Agent narrative generator
//
// Helpers that produce natural-language status messages about the
// agent pool. Used by:
//   - The TUI panel (compact display)
//   - The system prompt (so the model can weave agent names into
//     its responses like "waiting for Atlas to finish...")
//   - The /agents slash command output
//
// All functions are pure — given a PoolStatus they return strings
// or structured data. No side effects.

import { ROLES } from "./roles";
import type { Agent, AgentGroup, PoolStatus } from "./types";

/** Format milliseconds as "Xs" or "Xm Ys". */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

/** Color-coded one-line status for a single agent. */
export function formatAgentStatus(agent: Agent): string {
  const role = ROLES[agent.role];
  const icon = role.icon;
  const elapsed = agent.finishedAt
    ? formatElapsed(agent.finishedAt - agent.startedAt)
    : formatElapsed(Date.now() - agent.startedAt);
  const statusBadge =
    agent.status === "running"
      ? "●"
      : agent.status === "done"
        ? "✓"
        : agent.status === "error"
          ? "✗"
          : agent.status === "cancelled"
            ? "⊘"
            : agent.status === "waiting"
              ? "⏸"
              : "○";
  const target = agent.targetPath ? ` on ${agent.targetPath}` : "";
  const tool = agent.currentTool ? ` [${agent.currentTool}]` : "";
  return `${icon} ${statusBadge} ${agent.name} (${role.displayName})${target}${tool} — ${elapsed}`;
}

/** Compact multi-line summary of the whole pool. */
export function formatPoolStatus(status: PoolStatus): string {
  const lines: string[] = [];
  lines.push(
    `Pool: ${status.active.length}/${status.maxConcurrent} active, ${status.queued.length} queued, ${status.done.length} done`,
  );
  if (status.totalTokens > 0) {
    const costStr =
      status.totalCostUsd < 0.01
        ? `$${status.totalCostUsd.toFixed(4)}`
        : `$${status.totalCostUsd.toFixed(2)}`;
    lines.push(`Cost: ${costStr} (${status.totalTokens.toLocaleString()} tokens)`);
  }
  if (status.active.length > 0) {
    lines.push("");
    lines.push("Active:");
    for (const agent of status.active) {
      lines.push("  " + formatAgentStatus(agent));
    }
  }
  if (status.groups.length > 0) {
    lines.push("");
    lines.push("Groups:");
    for (const group of status.groups) {
      lines.push("  " + formatGroupStatus(group, status));
    }
  }
  return lines.join("\n");
}

/** One-line group summary for the /agents panel. */
export function formatGroupStatus(group: AgentGroup, status: PoolStatus): string {
  const members = group.agentIds.map((id) => {
    const a = status.active.find((x) => x.id === id) ?? status.done.find((x) => x.id === id);
    return a?.name ?? id.slice(0, 6);
  });
  const icon = group.status === "complete" ? "✓" : group.status === "cancelled" ? "⊘" : "●";
  return `${icon} ${group.name} [${members.join(", ")}] — ${group.mission}`;
}

/**
 * Build a short system-prompt fragment that tells the model who is
 * currently working. Injected into the conversation prompt when
 * the pool has active agents. Lets the model reference agents by
 * name in its responses.
 *
 * Example output:
 *
 *   You have 3 agents working in parallel:
 *     - Atlas (Auditor) is scanning backend/auth/
 *     - Orion (Fixer) is applying patches to lib/crypto.ts
 *     - Vega (Tester) is running npm test
 *
 *   You can wait for any by name ("waiting for Atlas"), reference a
 *   group ("Security Team is reviewing..."), or spawn more via the
 *   Agent tool with a role.
 */
export function buildAgentSystemPromptFragment(status: PoolStatus): string {
  if (status.active.length === 0 && status.queued.length === 0) return "";
  const lines: string[] = [];
  lines.push("## Active Agent Pool");
  lines.push("");
  if (status.active.length > 0) {
    lines.push(
      `You have ${status.active.length} agent${status.active.length === 1 ? "" : "s"} working in parallel:`,
    );
    for (const agent of status.active) {
      const role = ROLES[agent.role];
      const target = agent.targetPath ? ` on \`${agent.targetPath}\`` : "";
      lines.push(`  - **${agent.name}** (${role.displayName}) is ${agent.task}${target}`);
    }
  }
  if (status.queued.length > 0) {
    lines.push("");
    lines.push(
      `${status.queued.length} task${status.queued.length === 1 ? "" : "s"} queued (pool at capacity).`,
    );
  }
  if (status.groups.length > 0) {
    const active = status.groups.filter((g) => g.status === "active");
    if (active.length > 0) {
      lines.push("");
      lines.push("Groups:");
      for (const g of active) {
        const members = g.agentIds.map((id) => {
          const a = status.active.find((x) => x.id === id) ?? status.done.find((x) => x.id === id);
          return a?.name ?? id.slice(0, 6);
        });
        lines.push(`  - **${g.name}** [${members.join(", ")}]: ${g.mission}`);
      }
    }
  }
  lines.push("");
  lines.push(
    "You can reference agents by name in your responses. Examples: " +
      '"waiting for Atlas to finish", "while Orion fixes the crypto lib, I\'ll review…", ' +
      '"Group Alfa is handling the backend". Use the Agent tool to spawn more ' +
      "(up to 10 concurrent).",
  );
  return lines.join("\n");
}

/**
 * Generate a one-line "waiting for X" message when the user says
 * they want to wait for a specific agent. The model can use this as
 * a template for its response.
 */
export function formatWaitingMessage(agent: Agent): string {
  const role = ROLES[agent.role];
  const elapsed = formatElapsed(Date.now() - agent.startedAt);
  return `⏸ Esperando a ${agent.name} (${role.displayName}): ${agent.task} — ${elapsed} transcurridos`;
}
