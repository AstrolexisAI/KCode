// KCode - Kodi Companion
// An intelligent AI companion that lives in the terminal header.
// Uses a layered animation engine for fluid, contextual expressiveness.
// Falls back to hardcoded speech chips; optionally uses LLM for unique reactions.

import { Box, Text } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { KodiAnimState, KodiEvent, KodiMood, KodiTier } from "../kodi-animation.js";
import { KodiAnimEngine, SPEECH_CHIPS } from "../kodi-animation.js";
import { useModelDisplayLabel } from "../hooks/useModelDisplayLabel.js";
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
  /** Per-model session cost breakdown — aggregated from TurnCostEntry */
  sessionModelBreakdown?: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    turns: number;
  }>;
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

/** Anti-fluff filter. Two categories of reject:
 *   1. Hedge words — generic advice ("consider X", "maybe check Y")
 *   2. Meta-chatter — model-as-chatbot babble ("please provide more
 *      context", "I don't have enough information"). These surface
 *      when the advisor LLM falls back on its assistant persona
 *      instead of observing the event, and are spectacularly useless
 *      as a mascot bubble. Observed live from Qwen 2.5 Coder 1.5B
 *      abliterated on sparse contexts.
 */
const FLUFF_PATTERNS: readonly RegExp[] = [
  // Hedge words
  /\bconsider\b/i,
  /\bmaybe\b/i,
  /\bshould\b/i,
  /\brecommended?\b/i,
  /\bmight want to\b/i,
  /\bensure\b/i,
  /\btry to\b/i,
  // Meta-chatter / assistant persona leakage
  /\bplease (?:provide|clarify|specify|share)\b/i,
  /\bi don'?t have (?:enough|any|sufficient)\b/i,
  /\bcould you (?:clarify|specify|provide)\b/i,
  /\bi (?:can|would) (?:help|assist|be happy)\b/i,
  /\bmore (?:context|information|details) (?:or|please|would)\b/i,
  /\bspecific question\b/i,
  /\bfeel free to\b/i,
  /\blet me know\b/i,
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
  // model: burning expensive cloud-API tokens to produce a single
  // bubble hint would be a pointless cost. If the Kodi server
  // isn't running, the deterministic engine (engine.react +
  // SPEECH_CHIPS) handles everything.
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

// ─── Mini-Kodi animated component ──────────────────────────────

const MINI_TICK_MS = 150; // slightly faster than main Kodi for lively feel
// Compact face expressions — no box, no body, just the face chars
const MINI_FACES: Record<string, string[]> = {
  local:     ["(^_^)", "(^v^)", "(^-^)", "(^.^)", "(^w^)", "(^_^)"],
  reasoning: ["(O_O)", "(O.O)", "(@_@)", "(O_O)", "(0_0)", "(*_*)"],
  fast:      ["(-_-)", "(o_o)", "(>_<)", "(-.-)", "(o_o)", "(^_-)"],
  analysis:  ["(._.)","(o.o)", "(-.o)", "(o_o)", "(°.°)", "(._-)"],
  default:   ["(o_o)", "(-.o)", "(o.o)", "(o_o)", "(*.*)", "(o_o)"],
};
const MINI_MOODS: Record<string, KodiMood[]> = {
  local:     ["idle", "happy", "waving", "idle", "curious"],
  reasoning: ["reasoning", "thinking", "reasoning", "curious", "reasoning"],
  fast:      ["working", "excited", "working", "happy", "working"],
  analysis:  ["thinking", "curious", "thinking", "reasoning", "curious"],
  default:   ["idle", "thinking", "working", "happy", "idle"],
};

function getMiniPersonality(modelName: string): string {
  if (modelName === "mark7" || modelName.includes("mnemo") || modelName.includes("local")) return "local";
  if (modelName.includes("reasoning") || modelName.includes("o1") || modelName.includes("o3")) return "reasoning";
  if (modelName.includes("fast") || modelName.includes("mini") || modelName.includes("haiku") || modelName.includes("flash")) return "fast";
  if (modelName.includes("opus") || modelName.includes("sonnet") || modelName.includes("grok-4.20")) return "analysis";
  return "default";
}

function MiniKodi({ modelName, costUsd }: { modelName: string; costUsd: number }) {
  const { theme } = useTheme();
  const personality = getMiniPersonality(modelName);
  const faces = MINI_FACES[personality] ?? MINI_FACES.default;
  const moods = MINI_MOODS[personality] ?? MINI_MOODS.default;

  const [faceIdx, setFaceIdx] = useState(() => Math.floor(Math.random() * faces.length));
  const [moodIdx, setMoodIdx] = useState(() => Math.floor(Math.random() * moods.length));
  const [walkOffset, setWalkOffset] = useState(() => Math.floor(Math.random() * 3));

  useEffect(() => {
    // Each mini-Kodi has its own randomized tick interval — they desync naturally
    const interval = MINI_TICK_MS + Math.floor(Math.random() * 100);
    let frameCount = 0;
    const id = setInterval(() => {
      frameCount++;
      setFaceIdx((i) => (i + 1) % faces.length);
      if (frameCount % 7 === 0) setMoodIdx((i) => (i + 1) % moods.length);
      // Walk: drift left/right randomly within 0-3 cols
      if (frameCount % 5 === 0) setWalkOffset((w) => Math.max(0, Math.min(3, w + (Math.random() > 0.5 ? 1 : -1))));
    }, interval);
    return () => clearInterval(id);
  }, [faces.length, moods.length]);

  const faceColor: Record<string, string | undefined> = {
    local: theme.success, reasoning: theme.accent, fast: theme.warning,
    analysis: theme.primary, default: theme.dimmed,
  };
  const color = faceColor[personality] ?? theme.dimmed;
  const pad = " ".repeat(walkOffset);
  const face = faces[faceIdx]!;
  const shortName = modelName.length > 13 ? modelName.slice(0, 13) : modelName;

  return (
    <Box flexDirection="column" alignItems="flex-start" width={14}>
      <Text color={color}>{pad + face}</Text>
      <Text color={theme.dimmed}>{shortName}</Text>
      <Text color={theme.warning}>{`$${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(3)}`}</Text>
    </Box>
  );
}

// ─── Main Kodi component ─────────────────────────────────────────

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
  sessionModelBreakdown = [],
}: KodiProps) {
  const { theme } = useTheme();
  const displayModel = useModelDisplayLabel(model);
  const engineRef = useRef<KodiAnimEngine | null>(null);
  const [frame, setFrame] = useState<KodiAnimState | null>(null);
  const [multimodelEnabled, setMultimodelEnabled] = useState(false);

  // Poll multimodel state from settings (TTL: 2s)
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const { isMultimodelEnabled } = await import("../../core/router.js");
        if (!cancelled) setMultimodelEnabled(isMultimodelEnabled());
      } catch { /* ignore */ }
    };
    check();
    const id = setInterval(check, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
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

  // Autonomy state — Phase 3.
  // Walking: position drifts inside the 14-char sprite box so Kodi
  // looks alive during long idle stretches. Pure deterministic step.
  const walkStateRef = useRef<{ position: number; direction: -1 | 0 | 1 }>({
    position: 0,
    direction: 0,
  });
  const [walkPosition, setWalkPosition] = useState(0);
  // Idle-action history for LLM variety + timestamps for scheduling.
  const recentActionsRef = useRef<string[]>([]);
  const lastActivityRef = useRef(Date.now());

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

  // Abort any in-flight advisor LLM request on unmount. Without this,
  // /quit can hang for seconds waiting for a 80-token completion
  // that's already irrelevant (the TUI is gone).
  useEffect(() => {
    return () => {
      if (_pendingRequest) {
        _pendingRequest.abort();
        _pendingRequest = null;
      }
    };
  }, []);

  // ── Phase 3d — session personality ──
  // One LLM call at startup picks a personality that biases Kodi's
  // chips for the whole session. Falls back to random on any error.
  // Fires only when the Kodi server is up (paid tiers who installed
  // the advisor model). Free / declined users keep "focused".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { pickSessionPersonality } = await import("../kodi-autonomy.js");
        const p = await pickSessionPersonality();
        if (!cancelled) engine.setPersonality(p);
      } catch {
        /* stay on default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine]);

  // ── Phase 3b — walking ──
  // Walk step runs every 4s — visible but gentle. State is on a ref,
  // but we push to React state so the sprite re-renders with the new
  // horizontal offset. Cleaned up with clearInterval on unmount.
  useEffect(() => {
    const id = setInterval(async () => {
      const { stepWalk } = await import("../kodi-autonomy.js");
      const next = stepWalk(walkStateRef.current);
      walkStateRef.current = next;
      setWalkPosition(next.position);
    }, 4000);
    return () => clearInterval(id);
  }, []);

  // ── Free-will loop — urge-driven autonomy ──
  // Kodi acts on his OWN impulses (engine.urges), not on wall-clock
  // schedules. Every 5s this loop polls the current urges and fires
  // whichever action is ripest:
  //
  //   boredom    → autonomous idle action (yawn, stretch, flip, ...)
  //   curiosity  → musing (passing thought in bubble)
  //   wanderlust → door teleport (appear on the other side of info)
  //
  // Urges build ambiently in engine.stepUrges() and drain on any
  // event via engine.react(). Net behavior: when the user is active,
  // Kodi stays quiet. When left alone, Kodi acts — not because a
  // timer said so, but because he's accumulated the impulse.
  //
  // This replaces three separate setTimeout-based schedulers (idle
  // action / musing / teleport) with a single impulse-polling loop.
  useEffect(() => {
    const inFlightRef = { current: false };
    const id = setInterval(async () => {
      // Never step on a foreground mood / event animation.
      if (engine.phase !== "idle" || engine.mood !== "idle") return;
      if (inFlightRef.current) return;

      // Pick the most-built urge above its threshold. Thresholds
      // are tuned so the slowest-building urge (wanderlust) still
      // fires eventually even when the others are always being
      // drained by activity.
      const u = engine.urges;
      const ready = [
        { name: "boredom" as const, value: u.boredom, threshold: 0.9 },
        { name: "curiosity" as const, value: u.curiosity, threshold: 0.95 },
        { name: "wanderlust" as const, value: u.wanderlust, threshold: 0.98 },
      ]
        .filter((r) => r.value >= r.threshold)
        .sort((a, b) => b.value - a.value);
      if (ready.length === 0) return;

      inFlightRef.current = true;
      const pick = ready[0]!;
      try {
        if (pick.name === "boredom") {
          const { askForIdleAction, pickRandomIdleAction } = await import(
            "../kodi-autonomy.js"
          );
          const dispatch =
            (await askForIdleAction(
              engine.personality,
              0, // urges, not elapsed-seconds, drive the decision now
              recentActionsRef.current as any,
            )) ?? pickRandomIdleAction(recentActionsRef.current as any);
          engine.setMood(dispatch.mood);
          engine.say(dispatch.speech, 3000);
          recentActionsRef.current = [
            ...recentActionsRef.current.slice(-4),
            dispatch.action,
          ];
          engine.drainUrge("boredom", 1.0);
        } else if (pick.name === "curiosity") {
          const { askForMusing } = await import("../kodi-autonomy.js");
          const thought = await askForMusing(engine.personality);
          if (thought) {
            engine.setMood("thinking");
            engine.say(thought, 5500);
          }
          // Drain whether or not the thought passed the filter —
          // the urge was spent looking for a thought, even if the
          // LLM returned fluff and we dropped it.
          engine.drainUrge("curiosity", 0.7);
        } else if (pick.name === "wanderlust") {
          engine.teleportThroughDoor();
          engine.drainUrge("wanderlust", 1.0);
        }
      } catch {
        /* swallow — autonomy never bubbles errors to the UI */
      } finally {
        inFlightRef.current = false;
      }
    }, 5000);
    return () => clearInterval(id);
  }, [engine]);

  // ── Phase 3c — proactive observations ──
  // Every 60s, snapshot session signals and check thresholds. If any
  // observation tripped (with per-type cooldown), ask the LLM to
  // phrase it — otherwise show the raw detail. Sets latestAdvice so
  // the existing advice render line picks it up.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const { collectObservations, renderObservation } = await import(
          "../kodi-autonomy.js"
        );
        const signals = {
          idleMs: Date.now() - lastActivityRef.current,
          sessionMs: sessionStartTime ? Date.now() - sessionStartTime : 0,
          contextPressure:
            contextWindowSize && contextWindowSize > 0
              ? Math.min(1, tokenCount / contextWindowSize)
              : 0,
          toolUses: toolUseCount,
          msSinceCommit: Number.POSITIVE_INFINITY, // no commit signal yet
        };
        const obs = collectObservations(signals);
        if (obs.length === 0) return;
        // Render the first observation; if multiple fire in the same
        // tick, the next one will show on the next cycle.
        const line = await renderObservation(obs[0]!);
        setLatestAdvice(line);
      } catch {
        /* swallow */
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [sessionStartTime, contextWindowSize, tokenCount, toolUseCount]);

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

  // Balance for the active model's billing provider. Refreshes on every
  // turn (tokenCount bump) and when the model is switched. Null when the
  // model has no billing provider (local inference) or the user hasn't
  // registered a starting credit.
  const [balance, setBalance] = useState<{
    label: string;
    remaining: number | null;
    starting: number | null;
    spent: number;
    fractionRemaining: number | null;
    /** Live balance fetched from provider API (Kimi, OpenRouter) */
    liveAvailable?: number | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { getStatusForModel } = await import("../../core/balance/index.js");
        const status = await getStatusForModel(model);
        if (cancelled) return;
        if (!status) {
          setBalance(null);
          return;
        }
        const base = {
          label: status.label,
          remaining: status.remaining,
          starting: status.starting,
          spent: status.spent,
          fractionRemaining: status.fractionRemaining,
          liveAvailable: undefined as number | null | undefined,
        };
        setBalance(base);
        // Attempt live balance fetch (Kimi, OpenRouter) — non-blocking
        try {
          const { fetchLiveBalance } = await import("../../core/balance/live-fetch.js");
          const { loadUserSettingsRaw } = await import("../../core/config.js");
          const settings = loadUserSettingsRaw() as Record<string, unknown>;
          const keyMap: Record<string, string> = {
            kimi: String(settings.kimiApiKey ?? ""),
            openrouter: String(settings.openrouterApiKey ?? ""),
          };
          const live = await fetchLiveBalance(status.provider, keyMap[status.provider] ?? "");
          if (!cancelled && live) {
            setBalance((prev) => prev ? { ...prev, liveAvailable: live.available } : prev);
          }
        } catch { /* live fetch optional */ }
      } catch {
        if (!cancelled) setBalance(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [model, tokenCount]);

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
  //
  // Load-bearing: we clearTimeout on unmount, not just flip a
  // cancelled flag. An unfired setTimeout keeps Bun's event loop
  // alive until it triggers — a pending flex scheduled 90s out was
  // the biggest contributor to /quit taking seconds to exit.
  useEffect(() => {
    if (!tier || tier === "free") return;
    let cancelled = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleNext = () => {
      if (cancelled) return;
      const delay = 75_000 + Math.random() * 30_000;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
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
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    };
  }, [tier, engine]);

  // React to events
  const handleEvent = useCallback(
    (event: KodiEvent) => {
      eventCountRef.current++;
      engine.react(event);
      // Any incoming event counts as "user is active" — resets the
      // idle clock used by Phase 3a/3c to decide when to wake up
      // autonomous behaviors.
      lastActivityRef.current = Date.now();

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

  // Side drives which end of the panel Kodi sits on. The engine
  // flips this at the midpoint of a door-teleport animation so the
  // second half of the door frame already shows on the new side —
  // creating the "Kodi went through a door and came out on the
  // other side of the info text" effect the user asked for.
  const panelSide: "row" | "row-reverse" =
    frame?.side === "right" ? "row-reverse" : "row";

  // Narrow-screen breakpoint (Termux on Android typically sits at
  // ~35–45 cols). The Kodi sprite eats 21 cols and the horizontal
  // info panel needs ~60 cols to not word-wrap mid-phrase ("KCode
  // v2.10.135 — Kulvex Code by Astrolexis" shatters into 4 broken
  // lines at 35 cols). On narrow we hide the sprite, drop the long
  // subtitle, and let the essential info take the full width.
  const cols = process.stdout.columns || 80;
  const isNarrow = cols < 60;

  return (
    <Box
      flexDirection={panelSide}
      borderStyle="round"
      borderColor={theme.dimmed}
      paddingX={1}
      width={cols}
    >
      {/* Kodi sprite — pre-composed, fixed-width lines. The tier
          badge (★ ♛ ✦) renders as a small overlay column to the
          right of the head for paid tiers; free users see nothing.
          walkPosition (Phase 3b) shifts the sprite horizontally via
          a left-pad spacer so Kodi visibly drifts inside its box
          during long idle stretches. walkPosition is in
          [-WALK_RANGE, +WALK_RANGE], we render with an offset of
          `walkPosition + WALK_RANGE` columns of leading whitespace
          so the sprite traverses a 2·WALK_RANGE-wide lane.
          Hidden on narrow terminals to free the 21 cols for the
          info panel. */}
      {!isNarrow && (
        <Box flexDirection="column" width={15 + 6}>
          {lines.map((line, i) => (
            <Text key={i} color={moodColor}>
              {frame?.inDoor ? "" : " ".repeat(Math.max(0, walkPosition + 3))}
              {line}
            </Text>
          ))}
        </Box>
      )}
      {!isNarrow && frame?.tierBadge && frame.tier !== "free" && (
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
      <Box flexDirection="column" flexGrow={1} marginLeft={isNarrow ? 0 : 1}>
        {/* Line 1: Brand + tier badge. On narrow terminals we drop the
            "— Kulvex Code by Astrolexis" subtitle (redundant with
            the brand) and collapse the tier badge to its glyph only
            so the line fits in one row. */}
        <Box gap={1}>
          <Text bold color={theme.primary}>
            KCode
          </Text>
          <Text color={theme.dimmed}>v{version}</Text>
          {!isNarrow && (
            <>
              <Text color={theme.dimmed}>—</Text>
              <Text color={theme.dimmed}>Kulvex Code by Astrolexis</Text>
            </>
          )}
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
                {isNarrow
                  ? tier === "enterprise"
                    ? "✦"
                    : tier === "team"
                      ? "♛"
                      : "★"
                  : tier === "enterprise"
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
          <Text color={theme.success}>{displayModel}</Text>
          {multimodelEnabled && (
            <Text color={theme.accent} bold>{"🔀"}</Text>
          )}
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
          {balance &&
            (() => {
              // Show the remaining balance when the user has registered
              // a starting credit; otherwise fall back to "spent $X" so
              // they still see the per-provider meter accumulating.
              if (balance.starting != null && balance.remaining != null) {
                const pct =
                  balance.fractionRemaining != null
                    ? Math.round(balance.fractionRemaining * 100)
                    : 0;
                const color =
                  pct <= 5
                    ? theme.error
                    : pct <= 20
                      ? theme.warning
                      : theme.success;
                return (
                  <>
                    <Text color={theme.dimmed}>•</Text>
                    <Text color={color}>
                      {balance.label}: ${balance.remaining.toFixed(2)} ({pct}%)
                    </Text>
                  </>
                );
              }
              if (balance.spent > 0) {
                return (
                  <>
                    <Text color={theme.dimmed}>•</Text>
                    <Text color={theme.dimmed}>
                      {balance.label}: spent ${balance.spent.toFixed(2)}
                    </Text>
                  </>
                );
              }
              return null;
            })()}
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
        {/* Session economy: per-model cost breakdown + live balance */}
        {/* Unified multi-model panel: columns per model when multimodel ON,
            simple list when multimodel OFF */}
        {sessionModelBreakdown.length > 0 && (() => {
          const maxCost = Math.max(...sessionModelBreakdown.map(x => x.costUsd), 0.0001);
          const totalSpent = sessionModelBreakdown.reduce((s, m) => s + m.costUsd, 0);
          const balanceVal = balance ? (balance.liveAvailable ?? balance.remaining ?? null) : null;

          if (multimodelEnabled && sessionModelBreakdown.length > 1) {
            // Wide columnar layout — one column per model
            const cols = Math.min(sessionModelBreakdown.length, 4);
            const colW = Math.max(14, Math.floor((Math.min(cols * 80, process.stdout.columns || 80) - 4) / cols));
            return (
              <Box flexDirection="column" marginTop={0} marginLeft={1}>
                <Text color={theme.accent} bold>
                  {"─── 🔀 Multi-Model "}
                  <Text color={theme.dimmed}>{"─".repeat(Math.max(0, (colW * cols) - 18))}</Text>
                </Text>
                {/* Row 1: animated faces */}
                <Box flexDirection="row" marginLeft={1}>
                  {sessionModelBreakdown.slice(0, cols).map((m) => (
                    <Box key={m.model} width={colW}>
                      <MiniKodi modelName={m.model} costUsd={m.costUsd} />
                    </Box>
                  ))}
                </Box>
                {/* Row 2: cost + bar + turns per model */}
                <Box flexDirection="row" marginLeft={1} marginTop={0}>
                  {sessionModelBreakdown.slice(0, cols).map((m) => {
                    const bar = Math.round((m.costUsd / maxCost) * 4);
                    const barStr = "█".repeat(bar) + "░".repeat(4 - bar);
                    const cost = m.costUsd === 0 ? "local" : `$${m.costUsd < 0.01 ? m.costUsd.toFixed(4) : m.costUsd.toFixed(3)}`;
                    return (
                      <Box key={m.model} width={colW}>
                        <Text color={m.costUsd === 0 ? theme.success : theme.warning}>{cost}</Text>
                        <Text color={theme.dimmed}>{` ${barStr} ${m.turns}t`}</Text>
                      </Box>
                    );
                  })}
                </Box>
                {/* Balance footer */}
                <Box marginLeft={1} marginTop={0}>
                  <Text color={theme.dimmed}>
                    {balanceVal != null
                      ? `Balance: $${balanceVal.toFixed(2)} · session: $${totalSpent.toFixed(4)}`
                      : `Session total: $${totalSpent.toFixed(4)}`}
                  </Text>
                </Box>
              </Box>
            );
          }

          // Single-model mode: compact list (no mini-Kodis)
          return (
            <Box flexDirection="column" marginTop={0} marginLeft={2}>
              <Text color={theme.dimmed} bold>{"─ Economy ─"}</Text>
              {sessionModelBreakdown.slice(0, 5).map((m) => {
                const bar = Math.round((m.costUsd / maxCost) * 6);
                const barStr = "█".repeat(bar) + "░".repeat(6 - bar);
                const name = m.model.length > 20 ? m.model.slice(0, 20) : m.model.padEnd(20);
                const cost = m.costUsd === 0 ? "local " : `$${m.costUsd < 0.01 ? m.costUsd.toFixed(4) : m.costUsd.toFixed(3)}`;
                return (
                  <Box key={m.model} gap={1}>
                    <Text color={theme.dimmed}>{name}</Text>
                    <Text color={m.costUsd === 0 ? theme.success : theme.warning}>{cost}</Text>
                    <Text color={theme.dimmed}>{barStr}</Text>
                    <Text color={theme.dimmed}>{m.turns}t</Text>
                  </Box>
                );
              })}
              {balanceVal != null && (
                <Text color={theme.dimmed}>{"Balance: "}
                  <Text color={theme.success}>${balanceVal.toFixed(2)}</Text>
                  {" · spent: "}<Text color={theme.warning}>${totalSpent.toFixed(4)}</Text>
                </Text>
              )}
            </Box>
          );
        })()}

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
