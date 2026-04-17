// KCode - Kodi Companion
// An intelligent AI companion that lives in the terminal header.
// Uses a layered animation engine for fluid, contextual expressiveness.
// Falls back to hardcoded speech chips; optionally uses LLM for unique reactions.

import { Box, Text } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { KodiAnimState, KodiEvent, KodiMood, KodiTier } from "../kodi-animation.js";
import { KodiAnimEngine, SPEECH_CHIPS } from "../kodi-animation.js";
import { useTheme } from "../ThemeContext.js";

// Re-export types for external consumers
export type { KodiEvent, KodiMood };

interface KodiProps {
  mode: string;
  toolUseCount: number;
  tokenCount: number;
  /**
   * Running USD cost of the current session based on the active
   * model's pricing. 0 for local models (no billing) or unknown
   * models with no pricing entry.
   */
  sessionCostUsd?: number;
  activeToolName: string | null;
  isThinking: boolean;
  runningAgents: number;
  sessionElapsedMs: number;
  lastEvent: KodiEvent | null;
  model: string;
  version: string;
  workingDirectory: string;
  permissionMode?: string;
  activeProfile?: string;
  contextWindowSize?: number;
  sessionName?: string;
  sessionStartTime?: number;
  /** Subscription rate limit usage (0.0-1.0) for 5-hour window */
  subscriptionUsage5h?: number;
  /** Subscription rate limit usage (0.0-1.0) for 7-day window */
  subscriptionUsage7d?: number;
  /**
   * Subscription tier. Drives Kodi's permanent badge (★ ♛ ✦),
   * tier-aware speech, entrance flourish on first detection, and a
   * periodic flex while idle. Optional — undefined / "free" means
   * no flourish, no badge (fully backwards compatible with sessions
   * that never called getSubscription).
   */
  tier?: KodiTier;
  /** Feature flags from the subscription (pro, audit, rag, swarm, …). */
  tierFeatures?: string[];
}

// ─── LLM Reaction Generator ────────────────────────────────────

const KODI_SYSTEM = `You are Kodi, a tiny ASCII companion living inside a coding terminal (KCode).
You have a playful, witty personality. You're encouraging but not cheesy.
You react to coding events with short, punchy commentary.
You can be sarcastic, funny, nerdy, supportive, or dramatic — mix it up!
You're self-aware that you're a tiny ASCII character watching someone code.

Rules:
- Reply with ONLY your reaction text (no quotes, no prefix, no explanation)
- MAX 10 words. Shorter is better. Aim for 3-8 words.
- Be creative — never repeat yourself
- Match the energy: celebrations should be hype, errors should be empathetic
- You can use *actions* like *flexes* or *hides behind monitor*
- You can use unicode symbols sparingly: ⚡ ✨ 🔥 💀 ☕ etc.`;

// Advisor prompt used when Kodi's dedicated abliterated server is
// reachable on port 10092. Kept SHORT — small models (Qwen 1.5B,
// Gemma 1B) degrade sharply with long system prompts.
//
// Scope decision (from smoke-testing Qwen 2.5 Coder 1.5B abliterated
// against real events): the advisor ONLY generates `advice`. Mood
// stays deterministic in the engine (engine.react(event) already
// picks a well-tuned mood per event type), and the existing
// SPEECH_CHIPS for the bubble are more coherent than anything a
// 1.5B model will produce in ≤14 chars. Narrowing the advisor to
// a single field also means smaller schema, faster generation,
// and fewer token budget knobs to tune.
const KODI_ADVISOR_SYSTEM = `You are Kodi, a dev advisor mascot.
Output ONE JSON object: {"advice": "..."}.
advice: ONE specific actionable tip with exact file/fn/error pattern, ≤90 chars. If nothing specific to say, advice must be null.
PROHIBITED in advice: "consider", "maybe", "should", "recommended", "ensure", "might want to". These produce fluff — emit null instead.`;

/**
 * JSON schema used for constrained generation on the Kodi server.
 * llama.cpp's response_format + json_schema rejects tokens that
 * violate the schema at generation time, so `advice` is guaranteed
 * to be string|null when we parse. Small, fast, predictable.
 */
const KODI_ADVISOR_SCHEMA = {
  name: "kodi_reaction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["advice"],
    properties: {
      advice: { type: ["string", "null"] },
    },
  },
};

let _llmBaseUrl: string | null = null;
let _pendingRequest: AbortController | null = null;
let _lastLlmCall = 0;
const LLM_COOLDOWN_MS = 5000;

/** Cached "is Kodi server up?" result. Rechecked every KODI_PROBE_MS
 * because the server can start/stop mid-session via /kodi-advisor. */
let _kodiUrlCache: { url: string | null; at: number } | null = null;
const KODI_PROBE_MS = 10_000;

async function resolveKodiBaseUrl(): Promise<string | null> {
  const now = Date.now();
  if (_kodiUrlCache && now - _kodiUrlCache.at < KODI_PROBE_MS) {
    return _kodiUrlCache.url;
  }
  try {
    const { getKodiBaseUrl } = await import("../../core/kodi-model.js");
    const url = await getKodiBaseUrl();
    _kodiUrlCache = { url, at: now };
    return url;
  } catch {
    _kodiUrlCache = { url: null, at: now };
    return null;
  }
}

async function getLlmBaseUrl(): Promise<string> {
  if (_llmBaseUrl) return _llmBaseUrl;
  try {
    const { getModelBaseUrl, getDefaultModel } = await import("../../core/models.js");
    const defaultModel = await getDefaultModel();
    _llmBaseUrl = await getModelBaseUrl(defaultModel);
    return _llmBaseUrl;
  } catch {
    return "http://localhost:10091";
  }
}

export interface KodiReaction {
  /** Actionable advice (truncated to ≤120 chars for display). */
  advice?: string;
}

/** Anti-fluff filter. If the model ignores the PROHIBITED instruction
 * and still emits "consider X" or "maybe check Y" we treat it as no
 * advice — those lines never help a developer and they crowd out
 * legitimate signal. Case-insensitive match against a handful of
 * hedge words that reliably correlate with generic content. */
const FLUFF_PATTERNS: readonly RegExp[] = [
  /\bconsider\b/i,
  /\bmaybe\b/i,
  /\bshould\b/i,
  /\brecommended?\b/i,
  /\bmight want to\b/i,
  /\bensure\b/i,
  /\btry to\b/i,
];

function isFluff(advice: string): boolean {
  return FLUFF_PATTERNS.some((re) => re.test(advice));
}

/**
 * Tolerant JSON parser for the advisor's output. Small models often
 * wrap in markdown fences or prepend prose — we strip both and
 * extract the first {...} block. Advice that smells like generic
 * fluff (consider X, maybe Y) is dropped even if the model bypassed
 * the PROHIBITED clause in the prompt.
 */
export function parseKodiAdvisorJson(raw: string): KodiReaction | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  // Extract the outermost JSON object even if there's trailing text.
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (
    typeof o.advice !== "string" ||
    !o.advice.trim() ||
    o.advice.trim().toLowerCase() === "null"
  ) {
    return null;
  }
  const cleanedAdvice = o.advice.trim();
  if (isFluff(cleanedAdvice)) return null;
  return { advice: cleanedAdvice.slice(0, 120) };
}

async function generateReaction(context: string): Promise<KodiReaction | null> {
  // Advisor is Kodi-server-only. No fallback to the main coding
  // model: using the user's expensive Claude/Opus tokens to produce
  // a single bubble hint would be a pointless cost. If the Kodi
  // server isn't running, the deterministic engine (engine.react
  // + SPEECH_CHIPS) handles everything.
  const kodiUrl = await resolveKodiBaseUrl();
  if (!kodiUrl) return null;

  const now = Date.now();
  if (now - _lastLlmCall < LLM_COOLDOWN_MS) return null;
  if (_pendingRequest) _pendingRequest.abort();

  _lastLlmCall = now;
  const controller = new AbortController();
  _pendingRequest = controller;

  try {
    const res = await fetch(`${kodiUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        messages: [
          { role: "system", content: KODI_ADVISOR_SYSTEM },
          { role: "user", content: context },
        ],
        max_tokens: 80,
        // Low temperature: smoke-tested against Qwen 2.5 Coder 1.5B
        // abliterated — at 0.7 the model drifts into generic "maybe
        // check" advice; at 0.3 it stays anchored to the actual
        // context and produces concrete file/error references.
        temperature: 0.3,
        top_p: 0.95,
        // json_schema is enforced token-by-token on modern llama.cpp,
        // so `advice` is guaranteed string|null downstream. Older
        // builds ignore the schema and fall back to json_object mode,
        // which the parser still handles fine.
        response_format: {
          type: "json_schema",
          json_schema: KODI_ADVISOR_SCHEMA,
        },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    return parseKodiAdvisorJson(text);
  } catch {
    return null;
  } finally {
    if (_pendingRequest === controller) _pendingRequest = null;
  }
}

/**
 * Gate: decide whether an incoming KodiEvent warrants an LLM call.
 * Mechanical events (tool_start for reads, streaming, thinking
 * mid-generation) would flood Kodi with noise — we skip them and
 * only wake the advisor on moments with real information content:
 * test outcomes, commits, tool errors, compaction, turn boundaries,
 * agent lifecycle events, and explicit errors.
 *
 * consecutiveErrorCount lets the caller escalate: a single tool
 * failure is routine, but 3+ in a row means the user is stuck and
 * Kodi might see a pattern.
 */
export function shouldCallAdvisor(
  event: KodiEvent,
  consecutiveErrorCount: number,
): boolean {
  switch (event.type) {
    case "test_pass":
    case "test_fail":
    case "commit":
    case "compaction":
    case "agent_done":
    case "agent_failed":
    case "turn_end":
    case "error":
      return true;
    case "tool_error":
      return consecutiveErrorCount >= 3;
    default:
      return false;
  }
}

function buildContext(
  event: KodiEvent,
  stats: { tools: number; tokens: number; elapsed: number; agents: number },
): string {
  const parts: string[] = [];
  switch (event.type) {
    case "tool_start":
      parts.push(`User just triggered the ${event.detail ?? "a"} tool.`);
      break;
    case "tool_done":
      parts.push(`The ${event.detail ?? "a"} tool just finished successfully.`);
      if (event.detail === "TestRunner") parts.push("All tests passed!");
      if (event.detail === "GitCommit") parts.push("Code was committed!");
      break;
    case "tool_error":
      parts.push(`The ${event.detail ?? "a"} tool just FAILED.`);
      break;
    case "thinking":
      parts.push("The AI is now doing deep reasoning — neurons firing.");
      break;
    case "streaming":
      parts.push("The AI is writing its response to the user.");
      break;
    case "turn_end":
      parts.push("The AI just finished responding. Waiting for user input.");
      break;
    case "compaction":
      parts.push("Context window is getting full — conversation is being compacted.");
      break;
    case "agent_spawn":
      parts.push("A sub-agent was just spawned for a parallel task!");
      break;
    case "error":
      parts.push(`An error occurred: ${event.detail ?? "unknown error"}`);
      break;
    case "idle":
      if (stats.elapsed > 120_000)
        parts.push("User has been idle for over 2 minutes. You're getting sleepy.");
      else parts.push("Waiting for the user.");
      break;
    default:
      parts.push(`Event: ${event.type}`);
  }
  parts.push(
    `Session: ${stats.tools} tools, ${Math.round(stats.tokens / 1000)}k tok, ${stats.agents} agents.`,
  );
  return parts.join(" ");
}

// ─── Helpers ────────────────────────────────────────────────────

function formatTime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${(mins % 60).toString().padStart(2, "0")}m`;
}

// ─── Component ──────────────────────────────────────────────────

const TICK_MS = 200; // 5fps — enough for terminal, light on CPU

export default function KodiCompanion({
  mode,
  toolUseCount,
  tokenCount,
  sessionCostUsd,
  activeToolName,
  isThinking,
  runningAgents,
  sessionElapsedMs,
  lastEvent,
  model,
  version,
  workingDirectory,
  permissionMode,
  activeProfile,
  contextWindowSize,
  sessionName,
  sessionStartTime,
  subscriptionUsage5h,
  subscriptionUsage7d,
  tier,
  tierFeatures,
}: KodiProps) {
  const { theme } = useTheme();
  const engineRef = useRef<KodiAnimEngine | null>(null);
  const [frame, setFrame] = useState<KodiAnimState | null>(null);
  const [llmReaction, setLlmReaction] = useState<string | null>(null);
  // Most recent advice string from the Kodi advisor, displayed as a
  // dim line under the info grid. Persists across events until a new
  // advice replaces it, OR a tier_entrance / tier_flex event clears it.
  const [latestAdvice, setLatestAdvice] = useState<string | null>(null);
  // Rolling count of consecutive tool_error events — drives the
  // shouldCallAdvisor gate. Reset on any non-error event so a
  // success between two failures doesn't trip the "3 in a row" gate.
  const consecutiveErrorsRef = useRef(0);
  const lastToolMilestone = useRef(0);
  const lastTokenMilestone = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const eventCountRef = useRef(0);

  // Initialize engine once
  if (!engineRef.current) {
    engineRef.current = new KodiAnimEngine();
    engineRef.current.say("let's code!", 4000);
  }
  const engine = engineRef.current;

  // Animation tick loop
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(engine.tick(TICK_MS));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [engine]);

  // Update elapsed time every 10s
  useEffect(() => {
    if (!sessionStartTime) return;
    const timer = setInterval(() => setElapsed(Date.now() - sessionStartTime), 10000);
    return () => clearInterval(timer);
  }, [sessionStartTime]);

  // Sync context into engine
  useEffect(() => {
    engine.runningAgents = runningAgents;
  }, [runningAgents]);
  useEffect(() => {
    engine.contextPressure =
      contextWindowSize && contextWindowSize > 0 ? Math.min(1, tokenCount / contextWindowSize) : 0;
  }, [tokenCount, contextWindowSize]);

  // Tier sync — entrance flourish fires automatically inside the
  // engine the first time we transition away from "free". Subsequent
  // re-mounts or polling refreshes are silent.
  useEffect(() => {
    if (tier) engine.setTier(tier);
  }, [tier]);

  // Periodic tier flex while idle — only fires for paid tiers, only
  // while Kodi is actually idle (no active tool, no thinking). Picks
  // a random interval between 75-105s so it doesn't feel mechanical.
  // Free tier skips this entirely.
  useEffect(() => {
    if (!tier || tier === "free") return;
    let cancelled = false;
    const scheduleNext = () => {
      if (cancelled) return;
      const delay = 75_000 + Math.random() * 30_000;
      setTimeout(() => {
        if (cancelled) return;
        // Only flex when we're actually idle — no point breaking a
        // thinking animation with a sparkle.
        if (engine.phase === "idle" && engine.mood === "idle") {
          engine.react({ type: "tier_flex" });
        }
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    return () => {
      cancelled = true;
    };
  }, [tier, engine]);

  // React to events
  const handleEvent = useCallback(
    (event: KodiEvent) => {
      eventCountRef.current++;
      engine.react(event);

      // Track consecutive tool errors for the advisor gate.
      if (event.type === "tool_error") {
        consecutiveErrorsRef.current += 1;
      } else if (event.type !== "thinking" && event.type !== "streaming") {
        // Only "meaningful" events reset the counter — a thinking or
        // streaming interstitial shouldn't wipe a building error streak.
        consecutiveErrorsRef.current = 0;
      }

      // Gate: only wake the advisor on events with real information
      // content. Mechanical tool_start / streaming pings never reach
      // the LLM, so the advisor stays quiet during happy-path flow.
      if (!shouldCallAdvisor(event, consecutiveErrorsRef.current)) return;

      // Try LLM reaction (non-blocking)
      const ctx = buildContext(event, {
        tools: toolUseCount,
        tokens: tokenCount,
        elapsed: sessionElapsedMs,
        agents: runningAgents,
      });
      generateReaction(ctx).then((r) => {
        if (!r || !r.advice) return;
        // Mood + speech stay on the deterministic engine path —
        // r only carries advice. Keeps the 1.5B advisor in its lane
        // and the bubble coherent regardless of LLM quality.
        setLatestAdvice(r.advice);
      });
    },
    [engine, toolUseCount, tokenCount, sessionElapsedMs, runningAgents],
  );

  useEffect(() => {
    if (!lastEvent) return;

    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    handleEvent(lastEvent);

    // Idle progression
    idleTimerRef.current = setTimeout(() => {
      engine.windDown(30_000);
      idleTimerRef.current = setTimeout(() => {
        engine.windDown(120_000);
      }, 90_000);
    }, 30_000);

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [lastEvent, handleEvent]);

  // Milestones
  useEffect(() => {
    if (toolUseCount >= 100 && lastToolMilestone.current < 100) {
      lastToolMilestone.current = 100;
      engine.react({ type: "tool_done", detail: "milestone_100_tools" });
      engine.setMood("celebrating");
    } else if (toolUseCount >= 50 && lastToolMilestone.current < 50) {
      lastToolMilestone.current = 50;
      engine.react({ type: "tool_done", detail: "milestone_50_tools" });
    } else if (toolUseCount >= 10 && lastToolMilestone.current < 10) {
      lastToolMilestone.current = 10;
      engine.react({ type: "tool_done", detail: "milestone_10_tools" });
    }
  }, [toolUseCount]);

  useEffect(() => {
    if (tokenCount >= 100_000 && lastTokenMilestone.current < 100_000) {
      lastTokenMilestone.current = 100_000;
      engine.react({ type: "tool_done", detail: "milestone_100k_tokens" });
    }
  }, [tokenCount]);

  // ─── Computed values ────────────────────────────────────────

  const home = process.env.HOME ?? "";
  const shortCwd =
    home && workingDirectory.startsWith(home)
      ? "~" + workingDirectory.slice(home.length)
      : workingDirectory;

  const displayMood = frame?.mood ?? "idle";
  const moodColor =
    displayMood === "happy" || displayMood === "celebrating" || displayMood === "excited"
      ? theme.success
      : displayMood === "worried"
        ? theme.error
        : displayMood === "angry"
          ? theme.error
          : displayMood === "reasoning"
            ? theme.accent
            : displayMood === "thinking" || displayMood === "working"
              ? theme.warning
              : displayMood === "mischievous"
                ? "#ff69b4"
                : displayMood === "crazy"
                  ? "#ff00ff"
                  : displayMood === "smug"
                    ? "#ffd700"
                    : displayMood === "sleeping"
                      ? theme.dimmed
                      : theme.primary;

  const ctxPct =
    contextWindowSize && contextWindowSize > 0 && tokenCount > 0
      ? Math.min(100, Math.round((tokenCount / contextWindowSize) * 100))
      : 0;
  const ctxBarLen = 10;
  const ctxFilled = Math.round((ctxBarLen * ctxPct) / 100);
  const ctxBar = "\u2588".repeat(ctxFilled) + "\u2591".repeat(ctxBarLen - ctxFilled);
  const ctxColor = ctxPct > 85 ? theme.error : ctxPct > 60 ? theme.warning : theme.success;

  const pmColor =
    permissionMode === "auto"
      ? theme.warning
      : permissionMode === "deny"
        ? theme.error
        : permissionMode === "plan"
          ? (theme.info ?? theme.primary)
          : theme.dimmed;

  // ─── Render ─────────────────────────────────────────────────

  // Pre-composed lines from engine — all same width, guaranteed aligned
  const lines = frame?.lines ?? [
    " ╭───────╮   ",
    " │ o  .o │   ",
    " ╰───┬───╯   ",
    "    /|\\      ",
    "    / \\      ",
  ];
  const bubble = frame?.bubble ?? "";

  return (
    <Box
      flexDirection="row"
      borderStyle="round"
      borderColor={theme.dimmed}
      paddingX={1}
      width={process.stdout.columns || 80}
    >
      {/* Kodi sprite — pre-composed, fixed-width lines. The tier
          badge (★ ♛ ✦) renders as a small overlay column to the
          right of the head for paid tiers; free users see nothing. */}
      <Box flexDirection="column" width={15}>
        {lines.map((line, i) => (
          <Text key={i} color={moodColor}>
            {line}
          </Text>
        ))}
      </Box>
      {frame?.tierBadge && frame.tier !== "free" && (
        <Box flexDirection="column" width={2} marginRight={1}>
          {/* Badge floats next to the face line. The other rows stay
              blank so the badge reads as a single cosmetic flourish
              rather than confetti down the whole sprite. */}
          <Text> </Text>
          <Text
            bold
            color={
              frame.tier === "enterprise"
                ? theme.accent
                : frame.tier === "team"
                  ? "#ffd700"
                  : theme.warning
            }
          >
            {frame.tierBadge}
          </Text>
          <Text> </Text>
          <Text> </Text>
          <Text> </Text>
        </Box>
      )}
      {/* Info panel */}
      <Box flexDirection="column" flexGrow={1} marginLeft={1}>
        {/* Line 1: Brand + tier badge */}
        <Box gap={1}>
          <Text bold color={theme.primary}>
            KCode
          </Text>
          <Text color={theme.dimmed}>v{version}</Text>
          <Text color={theme.dimmed}>—</Text>
          <Text color={theme.dimmed}>Kulvex Code by Astrolexis</Text>
          {tier && tier !== "free" && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text
                bold
                color={
                  tier === "enterprise"
                    ? theme.accent
                    : tier === "team"
                      ? "#ffd700"
                      : theme.warning
                }
              >
                {tier === "enterprise"
                  ? "✦ Enterprise"
                  : tier === "team"
                    ? "♛ Team"
                    : "★ Pro"}
              </Text>
            </>
          )}
        </Box>
        {/* Line 2: Model + mode + cwd */}
        <Box gap={1}>
          <Text color={theme.success}>{model}</Text>
          {permissionMode && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text color={pmColor}>{permissionMode}</Text>
            </>
          )}
          {activeProfile && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text color={theme.info ?? theme.primary}>[{activeProfile}]</Text>
            </>
          )}
          <Text color={theme.dimmed}>•</Text>
          <Text color={theme.dimmed}>{shortCwd}</Text>
        </Box>
        {/* Line 3: Metrics */}
        <Box gap={1}>
          {(tokenCount > 0 || toolUseCount > 0) && (
            <>
              <Text color={theme.dimmed}>tok:{tokenCount.toLocaleString()}</Text>
              <Text color={theme.dimmed}>•</Text>
              <Text color={theme.dimmed}>tools:{toolUseCount}</Text>
            </>
          )}
          {sessionCostUsd != null && sessionCostUsd > 0 && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text color={theme.warning}>
                {sessionCostUsd < 0.01
                  ? `$${sessionCostUsd.toFixed(4)}`
                  : `$${sessionCostUsd.toFixed(2)}`}
              </Text>
            </>
          )}
          {runningAgents > 0 && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text color={theme.warning}>agents:{runningAgents}</Text>
            </>
          )}
          {contextWindowSize && contextWindowSize > 0 && tokenCount > 0 && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text color={ctxColor}>
                [{ctxBar}] {ctxPct}%
              </Text>
            </>
          )}
          {subscriptionUsage5h != null &&
            subscriptionUsage5h > 0 &&
            (() => {
              const pct = Math.min(Math.round(subscriptionUsage5h * 100), 100);
              const barW = 6;
              const filled = Math.round((pct / 100) * barW);
              const bar = "\u2588".repeat(filled) + "\u2591".repeat(barW - filled);
              const color = pct >= 90 ? theme.error : pct >= 70 ? theme.warning : theme.success;
              return (
                <>
                  <Text color={theme.dimmed}>•</Text>
                  <Text color={color}>
                    5h:[{bar}]{pct}%
                  </Text>
                </>
              );
            })()}
          {sessionName && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text color={theme.warning}>{sessionName}</Text>
            </>
          )}
          {sessionStartTime && elapsed > 0 && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text color={theme.dimmed}>{formatTime(elapsed)}</Text>
            </>
          )}
        </Box>
        {/* Line 4: Live agent panel (when agents are running) */}
        {lastEvent?.agentStatuses && lastEvent.agentStatuses.length > 0 && (
          <Box flexDirection="column">
            <Text color={theme.warning} bold>
              {"⚡ Agents (" + lastEvent.agentStatuses.filter(a => a.status === "running").length + " running)"}
            </Text>
            {lastEvent.agentStatuses.map((agent, i) => {
              const icon = agent.status === "running" ? "⣾⣽⣻⢿⡿⣟⣯⣷"[Math.floor(Date.now() / 100) % 8]
                : agent.status === "done" ? "✓"
                : agent.status === "failed" ? "✗"
                : "○";
              const color = agent.status === "running" ? theme.warning
                : agent.status === "done" ? theme.success
                : agent.status === "failed" ? theme.error
                : theme.dimmed;
              const elapsed = agent.durationMs ? ` ${Math.round(agent.durationMs / 1000)}s` : "";
              return (
                <Text key={i} color={color}>
                  {"  "}{icon} {agent.name}: {agent.stepTitle.slice(0, 50)}{elapsed}
                </Text>
              );
            })}
          </Box>
        )}
        {/* Line 5: Speech chip */}
        <Box>
          {bubble ? (
            <>
              <Text color={moodColor}>{"💬 "}</Text>
              <Text color={moodColor} italic>
                {bubble}
              </Text>
            </>
          ) : (
            <Text color={theme.dimmed}> </Text>
          )}
        </Box>
        {/* Line 6: Advisor line — concrete actionable tip from the
            Kodi advisor model, truncated to the panel width. Hidden
            when there's no advice in scope (free / pro / team or
            enterprise users who haven't installed the model). */}
        {latestAdvice ? (
          <Box>
            <Text color={theme.dimmed}>◆ </Text>
            <Text color={theme.dimmed}>{latestAdvice}</Text>
          </Box>
        ) : (
          <Text> </Text>
        )}
      </Box>
    </Box>
  );
}
