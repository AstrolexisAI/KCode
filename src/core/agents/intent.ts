// KCode — Agent intent detection
//
// Parses natural-language user messages for agent-dispatch intent:
//
//   "liberemos 3 agentes para auditar backend"
//   "unleash 5 agents to refactor the auth module"
//   "formemos grupo Alfa con 2 agentes para security"
//
// and turns them into a dispatch call. Returns null when the
// message contains no agent-dispatch intent so the regular
// conversation flow proceeds unchanged.

import type { Agent, AgentRole, AgentSpec } from "./types";
import { roleFromTask, ROLES } from "./roles";
import { getAgentPool } from "./pool";
import { dispatchFromInstruction } from "./factory";
import { executorForRole } from "./executor";

/**
 * Result returned to the conversation loop when agent intent is
 * detected. The caller should display `message` to the user,
 * optionally skip the LLM call for this turn (if `consumed` is true),
 * and let the spawned agents run in the background.
 */
export interface AgentIntentResult {
  /** Detected that the message asks to spawn agents. */
  detected: boolean;
  /** Whether the conversation loop should skip the LLM call for this turn. */
  consumed: boolean;
  /** Human-readable summary message to display inline in the assistant response. */
  message: string;
  /** The agents that were actually spawned (may be fewer than requested if pool is full). */
  spawned: Agent[];
}

/** Regex patterns that indicate agent-dispatch intent. */
const DISPATCH_PATTERNS: RegExp[] = [
  // Spanish: "liberemos/liberar/larguemos/soltemos N agentes"
  /\b(?:liberemos|liberar|larguemos|larga|suelt[ae]|soltemos|desplegemos|desplegar|manda|mandemos|mand[ae])\s+(\d+)\s+(?:agente|agent|worker|bot)/i,
  // English: "spawn/unleash/deploy/send N agents"
  /\b(?:spawn|unleash|deploy|dispatch|send|launch|fire\s+up)\s+(\d+)\s+(?:agent|worker|bot)/i,
  // Spanish: "N agentes para"
  /\b(\d+)\s+(?:agente|agent)s?\s+(?:para|to)\b/i,
  // English: "let's have N agents"
  /\b(?:let'?s\s+have|let\s+us\s+have)\s+(\d+)\s+(?:agent|worker)/i,
  // "formemos/let's form a team/group of N"
  /\b(?:formemos|let'?s\s+form|crear|create)\s+(?:un\s+)?(?:grupo|group|team)\s+(\w+)/i,
];

/** Keywords that strongly suggest this message is about agents. */
const INTENT_KEYWORDS = /\b(?:agente|agent|worker|bot|team|grupo|group|swarm|parallel)/i;

/**
 * Detect agent-dispatch intent in a user message. Returns null if
 * none is found. Otherwise dispatches agents through the pool and
 * returns a result describing what happened.
 *
 * Called from the conversation loop before the regular LLM turn.
 * When detected, the caller typically shows `message` to the user
 * and lets the conversation continue normally — the LLM will see
 * the new agent pool state via the system-prompt fragment on its
 * next turn.
 */
export function detectAgentIntent(
  message: string,
  cwd: string,
): AgentIntentResult | null {
  // Fast path: skip pattern matching for messages that don't even
  // mention agents. Saves ~10 regex runs per non-agent turn.
  if (!INTENT_KEYWORDS.test(message)) return null;

  // Parse "N agentes"
  let requestedCount: number | undefined;
  let groupName: string | undefined;

  for (const rex of DISPATCH_PATTERNS) {
    const match = message.match(rex);
    if (match) {
      // The first numeric capture group is the count (patterns 1-4)
      const numMatch = match[1]?.match(/^\d+$/);
      if (numMatch) {
        requestedCount = parseInt(match[1]!, 10);
      }
      // Pattern 5 (group) captures the group name in group 1
      if (!numMatch && match[1]) {
        groupName = match[1];
      }
      if (requestedCount) break;
    }
  }

  // Also look for explicit group names independently of the count
  if (!groupName) {
    const groupMatch = message.match(
      /\b(?:grupo|group|team|squad)\s+([A-Z][A-Za-z]+|\d+|\w{2,})/i,
    );
    if (groupMatch) groupName = groupMatch[1];
  }

  // If we found neither a count nor a group, this isn't a dispatch.
  if (!requestedCount && !groupName) return null;

  // Extract the task text: strip the "N agentes para" prefix if present.
  const taskMatch = message.match(
    /(?:para|to|for)\s+(.+?)(?:[.!?]|$)/i,
  );
  const task = taskMatch ? taskMatch[1]!.trim() : message.trim();

  // Dispatch via the factory.
  try {
    const pool = getAgentPool();
    const spawned = dispatchFromInstruction(message, {
      cwd,
      maxAgents: requestedCount,
      groupName,
      executor: undefined, // factory will call executorForRole per spec — set below
      pool,
    });

    // Re-attach executors per agent (factory.spawn was called without
    // one). We emit events and let the pool's runner handle them.
    // NOTE: the factory's dispatch() uses the pool's defaultExecutor,
    // so if we want role-based executors we need to call spawn()
    // directly here. Simpler: on each spawned agent, kick off a
    // background executor call now that it exists in the pool.
    // The agent is already marked "running" from spawn(), so we
    // just trigger its executor asynchronously.
    for (const agent of spawned) {
      const role = agent.role as AgentRole;
      const exec = executorForRole(role, cwd);
      void (async () => {
        try {
          const result = await exec(agent, (event) => {
            // Forward through the pool's event stream.
            (pool as any).emit?.(event);
          });
          agent.status = "done";
          agent.result = result;
          agent.finishedAt = Date.now();
        } catch (err) {
          agent.status = "error";
          agent.error = err instanceof Error ? err.message : String(err);
          agent.finishedAt = Date.now();
        }
      })();
    }

    const roleBreakdown = new Map<string, number>();
    for (const a of spawned) {
      roleBreakdown.set(a.role, (roleBreakdown.get(a.role) ?? 0) + 1);
    }
    const roleSummary = Array.from(roleBreakdown.entries())
      .map(([r, n]) => `${n}× ${ROLES[r as AgentRole].displayName}`)
      .join(", ");
    const names = spawned.map((a) => a.name).join(", ");

    const lines: string[] = [];
    lines.push(
      `🚀 Dispatched **${spawned.length} agent${spawned.length === 1 ? "" : "s"}** (${roleSummary}): ${names}`,
    );
    if (groupName) {
      lines.push(`   → Group **${groupName}**: ${task}`);
    } else {
      lines.push(`   → Task: ${task}`);
    }
    lines.push(`   Track with /agents.`);

    return {
      detected: true,
      consumed: false, // let the LLM still respond; it will see the pool in its system prompt
      message: lines.join("\n"),
      spawned,
    };
  } catch (err) {
    return {
      detected: true,
      consumed: false,
      message: `Failed to dispatch agents: ${err instanceof Error ? err.message : String(err)}`,
      spawned: [],
    };
  }
}
