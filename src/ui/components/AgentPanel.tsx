// KCode — AgentPanel TUI component
//
// Live-updating grid of active agents in the pool. Subscribes to
// pool.onEvent() and re-renders whenever an agent spawns, moves
// between states, or finishes. Auto-hides when the pool is empty
// so it doesn't consume screen real-estate during normal coding.
//
// Rendered above Kodi in App.tsx. Layout:
//
//   ╭─ Agents (3/10 active, 1 done) — $0.0042 ─────────────────╮
//   │ 🔍 ● Atlas    Auditor  backend/auth         [Read]   12s │
//   │ 🔧 ● Orion    Fixer    lib/crypto.ts        [Edit]   8s  │
//   │ 🧪 ● Vega     Tester   tests/               [Bash]   5s  │
//   │ ✍ ✓ Lyra     Scribe   changelog                     20s │
//   │                                                          │
//   │ Groups: ● Alfa [Atlas, Orion] — security audit          │
//   ╰──────────────────────────────────────────────────────────╯
//
// Color coding per status: running=primary, waiting=warning,
// done=success, error=error, cancelled=dimmed.

import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { getAgentPool } from "../../core/agents/pool.js";
import { ROLES } from "../../core/agents/roles.js";
import type { Agent, PoolEvent, PoolStatus } from "../../core/agents/types.js";
import { useTheme } from "../ThemeContext.js";

interface AgentPanelProps {
  /**
   * Maximum number of agents to render. If the pool has more, the
   * extras are truncated with a "+N more" footer. Default 10.
   */
  maxVisible?: number;
}

/** Format milliseconds as a compact elapsed string. */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m${r}s` : `${m}m`;
}

/** Truncate a string to `len` chars with ellipsis. */
function truncate(s: string, len: number): string {
  if (s.length <= len) return s;
  return s.slice(0, len - 1) + "…";
}

export default function AgentPanel({ maxVisible = 10 }: AgentPanelProps) {
  const { theme } = useTheme();
  // Force a re-render on every pool event by bumping a counter.
  // We don't need the event payload itself — just the tick.
  const [, setTick] = useState(0);

  useEffect(() => {
    const pool = getAgentPool();

    // Single onEvent subscription does both jobs: re-render on event,
    // and ensure the 1s ticker is running only while there's live
    // work. Separate subscriptions would fire the same callbacks
    // twice per event and waste a bit of CPU on every spawn/tool_end.
    let timer: ReturnType<typeof setInterval> | null = null;
    const ensureTimer = () => {
      const status = pool.getStatus();
      const hasLiveWork = status.active.some(
        (a) => a.status === "running" || a.status === "spawning" || a.status === "waiting",
      );
      if (hasLiveWork && !timer) {
        timer = setInterval(() => setTick((t) => t + 1), 1000);
      } else if (!hasLiveWork && timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const unsubscribe = pool.onEvent((_event: PoolEvent) => {
      setTick((t) => t + 1);
      ensureTimer();
    });

    // Initial check — if the pool already has live agents when the
    // panel mounts (e.g., after a /stop + remount), start the ticker.
    ensureTimer();

    return () => {
      unsubscribe();
      if (timer) clearInterval(timer);
    };
  }, []);

  const pool = getAgentPool();
  const status: PoolStatus = pool.getStatus();

  // Auto-hide when nothing is happening. Empty pool + no history =
  // no panel at all. Once agents have run, the panel stays visible
  // to show recent results, but still hides after a short grace
  // period of total inactivity (handled externally via reset()).
  if (status.active.length === 0 && status.done.length === 0 && status.queued.length === 0) {
    return null;
  }

  const visibleAgents = status.active.slice(0, maxVisible);
  const hiddenCount = Math.max(0, status.active.length - visibleAgents.length);

  // Total cost badge — only show if non-zero to keep the header clean.
  const costBadge =
    status.totalCostUsd > 0
      ? ` — ${
          status.totalCostUsd < 0.01
            ? `$${status.totalCostUsd.toFixed(4)}`
            : `$${status.totalCostUsd.toFixed(2)}`
        }`
      : "";

  // Header summary
  const doneCount = status.done.filter((a) => a.status === "done").length;
  const errorCount = status.done.filter((a) => a.status === "error").length;
  const headerParts: string[] = [];
  headerParts.push(`${status.active.length}/${status.maxConcurrent} active`);
  if (status.queued.length > 0) headerParts.push(`${status.queued.length} queued`);
  if (doneCount > 0) headerParts.push(`${doneCount} done`);
  if (errorCount > 0) headerParts.push(`${errorCount} error`);
  const header = `Agents (${headerParts.join(", ")})${costBadge}`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.primary} paddingX={1}>
      <Text bold color={theme.primary}>
        {header}
      </Text>
      {visibleAgents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} />
      ))}
      {hiddenCount > 0 && <Text color={theme.dimmed}> …and {hiddenCount} more</Text>}
      {status.groups.length > 0 && <GroupsList status={status} />}
    </Box>
  );
}

/** Single row for an agent — one line with icon, name, role, target, tool, elapsed. */
function AgentRow({ agent }: { agent: Agent }) {
  const { theme } = useTheme();
  const role = ROLES[agent.role];
  const elapsed = agent.finishedAt
    ? formatElapsed(agent.finishedAt - agent.startedAt)
    : formatElapsed(Date.now() - agent.startedAt);

  // Status badge + its color
  const badge =
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
  const badgeColor =
    agent.status === "running"
      ? theme.primary
      : agent.status === "done"
        ? theme.success
        : agent.status === "error"
          ? theme.error
          : agent.status === "cancelled"
            ? theme.dimmed
            : agent.status === "waiting"
              ? theme.warning
              : theme.dimmed;

  const target = agent.targetPath ? truncate(agent.targetPath, 24) : "";
  const tool = agent.currentTool ? `[${agent.currentTool}]` : "";

  return (
    <Box gap={1}>
      <Text>{role.icon}</Text>
      <Text color={badgeColor} bold>
        {badge}
      </Text>
      <Text bold color={theme.primary}>
        {agent.name.padEnd(10, " ")}
      </Text>
      <Text color={theme.dimmed}>{role.displayName.padEnd(10, " ")}</Text>
      {target && <Text color={theme.dimmed}>{target}</Text>}
      {tool && <Text color={theme.warning}>{tool}</Text>}
      <Text color={theme.dimmed}>{elapsed}</Text>
    </Box>
  );
}

/** Groups section at the bottom of the panel. */
function GroupsList({ status }: { status: PoolStatus }) {
  const { theme } = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={theme.dimmed}>Groups:</Text>
      {status.groups.map((g) => {
        const members = g.agentIds.map((id) => {
          const a = status.active.find((x) => x.id === id) ?? status.done.find((x) => x.id === id);
          return a?.name ?? id.slice(0, 6);
        });
        const icon = g.status === "complete" ? "✓" : g.status === "cancelled" ? "⊘" : "●";
        const iconColor =
          g.status === "complete"
            ? theme.success
            : g.status === "cancelled"
              ? theme.dimmed
              : theme.primary;
        return (
          <Box key={g.name} gap={1}>
            <Text color={iconColor}>{icon}</Text>
            <Text bold>{g.name}</Text>
            <Text color={theme.dimmed}>[{members.join(", ")}]</Text>
            {g.mission && <Text color={theme.dimmed}>— {truncate(g.mission, 40)}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
