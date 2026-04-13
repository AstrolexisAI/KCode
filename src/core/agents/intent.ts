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

import type { Agent, AgentRole } from "./types";
import { ROLES } from "./roles";
import { getAgentPool } from "./pool";
import { dispatchFromInstruction } from "./factory";

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

/**
 * Regex patterns that indicate agent-dispatch intent.
 *
 * Anchored to require an IMPERATIVE or EXHORTATIVE verb at the start
 * of the match. This rules out past-tense references ("deployed 3
 * agents yesterday") and incidental mentions ("the 2 agent accounts
 * are...") that would otherwise trigger spurious dispatches.
 *
 * Allowed openers:
 *   - Spanish: liberemos, larguemos, soltemos, desplegemos, mandemos,
 *     vamos a (liberar/largar/soltar/desplegar/mandar), necesitamos,
 *     quiero, quisiera
 *   - English: spawn, unleash, deploy, dispatch, launch, let's, I want,
 *     we need
 */
const DISPATCH_PATTERNS: RegExp[] = [
  // Spanish imperative/exhortative: "liberemos 3 agentes"
  /(?:^|\s)(?:liberemos|larguemos|soltemos|desplegemos|mandemos|suelta|larga|libera|despliega|manda)\s+(\d+)\s+(?:agente|agent)/i,
  // Spanish analytic: "vamos a liberar 3 agentes", "necesitamos 3 agentes"
  /(?:^|\s)(?:vamos\s+a\s+(?:liberar|largar|soltar|desplegar|mandar|crear|dividir)|necesitamos|quiero|quisiera)\s+(\d+)\s+(?:agente|agent)/i,
  // English imperative: "spawn 3 agents", "launch 5 workers"
  /(?:^|\s)(?:spawn|unleash|deploy|dispatch|launch|fire\s+up)\s+(\d+)\s+(?:agent|worker|bot)/i,
  // English exhortative: "let's spawn/have/launch 3 agents", "let us deploy 5"
  /(?:^|\s)(?:let'?s\s+(?:spawn|have|launch|deploy|dispatch|unleash|form|create)|let\s+us\s+(?:spawn|have|launch|deploy))\s+(\d+)\s+(?:agent|worker|bot)/i,
  // "I want/need N agents to X" — requires forward intent
  /(?:^|\s)(?:i\s+(?:want|need)|we\s+(?:want|need))\s+(\d+)\s+(?:agent|worker)\s+(?:to|for)/i,
  // Group formation: "formemos grupo Alfa", "let's form team Beta"
  /(?:^|\s)(?:formemos|creemos|crear|let'?s\s+form|let\s+us\s+form|let'?s\s+create)\s+(?:un\s+|a\s+)?(?:grupo|group|team|squad)\s+(\w+)/i,
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
    // dispatchFromInstruction → dispatch() now picks role-appropriate
    // executors per spec via executorForRole(), so we don't need to
    // re-invoke executors manually. The pool's runAgent handles
    // lifecycle (events, retire, queue drain, group completion).
    const spawned = dispatchFromInstruction(message, {
      cwd,
      maxAgents: requestedCount,
      groupName,
      pool,
    });

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
