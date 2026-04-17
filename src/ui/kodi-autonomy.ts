// KCode — Kodi autonomy engine.
//
// Takes Kodi from "reacts to events" to "feels alive". Four layers,
// all gated on the Kodi advisor server being reachable (same
// http://127.0.0.1:10092 endpoint the advisor uses):
//
//   3a  Idle actions      (LLM picks: yawn, stretch, read, flip, ...)
//   3b  Walking           (position drifts inside the sprite box)
//   3c  Observations      (noticing long-idle / context-pressure)
//   3d  Personality       (session-level mood bias; see kodi-animation.ts)
//
// All four layers degrade gracefully. If the server is down, only
// the deterministic animation engine runs (existing Phase 1 behavior).
// Nothing in this module touches network when there's no server up.

import type { KodiMood, KodiPersonality } from "./kodi-animation.js";

// ─── Shared helpers ─────────────────────────────────────────────

/** Cached "is Kodi server up?" check, identical to Kodi.tsx's cache.
 * Kept separate here so the autonomy engine can run its own cadence
 * without coupling to the bubble-reaction fetch. */
let _serverCache: { url: string | null; at: number } | null = null;
const SERVER_PROBE_MS = 10_000;

async function resolveKodiUrl(): Promise<string | null> {
  const now = Date.now();
  if (_serverCache && now - _serverCache.at < SERVER_PROBE_MS) {
    return _serverCache.url;
  }
  try {
    const { getKodiBaseUrl } = await import("../core/kodi-model.js");
    const url = await getKodiBaseUrl();
    _serverCache = { url, at: now };
    return url;
  } catch {
    _serverCache = { url: null, at: now };
    return null;
  }
}

/** POST to the Kodi server with JSON schema–constrained output.
 * Returns the parsed content string on success, null on any failure.
 * 20s timeout matches the server's warm-steady-state latency envelope. */
async function callKodi(
  system: string,
  user: string,
  schema: unknown,
  maxTokens = 40,
): Promise<string | null> {
  const url = await resolveKodiUrl();
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.5,
        top_p: 0.95,
        response_format: { type: "json_schema", json_schema: schema },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function tryParseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

// ─── 3a — Idle actions ──────────────────────────────────────────

/**
 * Palette of autonomous idle actions. Each action maps to a mood +
 * speech chip so the existing sprite system renders something
 * distinct for free — no per-action sprite work needed. The LLM's
 * job is to pick ONE action name; everything else is deterministic
 * downstream, which keeps output noise under control.
 */
export type KodiIdleAction =
  | "yawn"
  | "stretch"
  | "look_left"
  | "look_right"
  | "read_book"
  | "hum"
  | "flip"
  | "nap"
  | "rubber_duck"
  | "pet_cat"
  | "stare";

export interface KodiIdleActionDispatch {
  action: KodiIdleAction;
  mood: KodiMood;
  speech: string;
}

/** Map an action to the mood + bubble the deterministic engine
 * should render. Keeps the LLM's only job "pick a name" — the rest
 * is fixed so quality stays consistent regardless of model. */
const IDLE_ACTION_MAP: Record<KodiIdleAction, { mood: KodiMood; speech: string }> = {
  yawn: { mood: "sleeping", speech: "yaaawn" },
  stretch: { mood: "happy", speech: "stretch" },
  look_left: { mood: "curious", speech: "<<<" },
  look_right: { mood: "curious", speech: ">>>" },
  read_book: { mood: "thinking", speech: "reading" },
  hum: { mood: "happy", speech: "la la~" },
  flip: { mood: "excited", speech: "flip!" },
  nap: { mood: "sleeping", speech: "zzz" },
  rubber_duck: { mood: "reasoning", speech: "duck?" },
  pet_cat: { mood: "happy", speech: "pet pet" },
  stare: { mood: "idle", speech: "..." },
};

export const ALL_IDLE_ACTIONS: readonly KodiIdleAction[] = Object.keys(
  IDLE_ACTION_MAP,
) as KodiIdleAction[];

const IDLE_ACTION_SCHEMA = {
  name: "kodi_idle_action",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ALL_IDLE_ACTIONS },
    },
  },
};

const IDLE_ACTION_SYSTEM = `You are Kodi, a tiny ASCII mascot inside a terminal coding assistant.
The user has been idle for a while and you want to look alive.
Output ONE JSON object: {"action": "..."}.
action: one of yawn, stretch, look_left, look_right, read_book, hum, flip, nap, rubber_duck, pet_cat, stare.
Pick something that fits the current vibe. Vary — don't repeat recent actions.`;

/**
 * Ask the advisor for the next idle action. Returns null if the
 * server isn't reachable or the response is unusable — the caller
 * should pick a deterministic fallback in that case (see
 * pickRandomIdleAction below).
 */
export async function askForIdleAction(
  personality: KodiPersonality,
  secondsIdle: number,
  recentActions: readonly KodiIdleAction[],
): Promise<KodiIdleActionDispatch | null> {
  const recent = recentActions.slice(-3).join(", ") || "none";
  const userMsg = `Personality: ${personality}. Idle for ${Math.round(secondsIdle)}s. Recent actions: ${recent}.`;
  const raw = await callKodi(IDLE_ACTION_SYSTEM, userMsg, IDLE_ACTION_SCHEMA, 20);
  const parsed = tryParseJson<{ action?: string }>(raw);
  if (!parsed?.action) return null;
  const action = parsed.action as KodiIdleAction;
  if (!ALL_IDLE_ACTIONS.includes(action)) return null;
  const meta = IDLE_ACTION_MAP[action];
  return { action, mood: meta.mood, speech: meta.speech };
}

/** Deterministic fallback when the LLM is unreachable. Picks at
 * random, avoiding the most recent action so Kodi still looks alive. */
export function pickRandomIdleAction(
  recentActions: readonly KodiIdleAction[],
): KodiIdleActionDispatch {
  const last = recentActions.at(-1);
  const pool = last ? ALL_IDLE_ACTIONS.filter((a) => a !== last) : ALL_IDLE_ACTIONS;
  const action = pool[Math.floor(Math.random() * pool.length)] ?? "stare";
  const meta = IDLE_ACTION_MAP[action];
  return { action, mood: meta.mood, speech: meta.speech };
}

// ─── 3b — Walking ───────────────────────────────────────────────

/**
 * Horizontal position offset for the sprite. Values range from
 * -WALK_RANGE to +WALK_RANGE inclusive; the render layer shifts
 * Kodi that many columns inside the sprite box. Small range keeps
 * the mascot from colliding with the panel edges.
 */
export const WALK_RANGE = 3;

export interface KodiWalkState {
  /** Current horizontal offset in columns. */
  position: number;
  /** -1 (left), 0 (still), +1 (right). */
  direction: -1 | 0 | 1;
}

/**
 * Advance the walking state by one tick. The mascot walks in bursts
 * of 2-4 columns then pauses — purely deterministic, no LLM needed.
 * Called periodically from the autonomy scheduler. */
export function stepWalk(state: KodiWalkState): KodiWalkState {
  // When still, 20% chance to start a burst in a random direction.
  if (state.direction === 0) {
    if (Math.random() < 0.2) {
      return { ...state, direction: Math.random() < 0.5 ? -1 : 1 };
    }
    return state;
  }
  const next = state.position + state.direction;
  // Clamp + reverse at edges so Kodi bounces instead of clipping.
  if (next > WALK_RANGE) return { position: WALK_RANGE, direction: -1 };
  if (next < -WALK_RANGE) return { position: -WALK_RANGE, direction: 1 };
  // 25% chance to stop each step, so movement is visible but gentle.
  if (Math.random() < 0.25) {
    return { position: next, direction: 0 };
  }
  return { position: next, direction: state.direction };
}

export function initialWalkState(): KodiWalkState {
  return { position: 0, direction: 0 };
}

// ─── 3c — Proactive observations ────────────────────────────────

/**
 * Signals the autonomy engine watches to produce proactive comments.
 * The collector runs periodically, notices when one of these
 * thresholds is crossed, and asks the LLM to turn the observation
 * into a terse advice line. Thresholds are intentionally loose —
 * Kodi should rarely pipe up, and each observation type fires at
 * most once per cooldown window to prevent nagging.
 */
export type KodiObservationType =
  | "long_idle" // user has been idle a long time
  | "context_pressure" // token budget nearing cap
  | "long_session" // been coding for hours
  | "no_recent_commit"; // many tools run, nothing committed

export interface KodiObservation {
  type: KodiObservationType;
  detail: string;
}

export interface SessionSignals {
  /** ms since last user input or tool event. */
  idleMs: number;
  /** total session elapsed time in ms. */
  sessionMs: number;
  /** current token count relative to the model's context window (0-1). */
  contextPressure: number;
  /** total tool calls this session. */
  toolUses: number;
  /** ms since last commit (Infinity if none this session). */
  msSinceCommit: number;
}

/** Last-fired timestamp per observation type; prevents repeat
 * notices within the cooldown window. Keyed by type. */
const OBS_COOLDOWN_MS: Record<KodiObservationType, number> = {
  long_idle: 30 * 60_000, // 30 min
  context_pressure: 10 * 60_000, // 10 min
  long_session: 60 * 60_000, // 1 h
  no_recent_commit: 45 * 60_000, // 45 min
};

/** Module-level last-fired tracker. Reset via
 * resetObservationCooldowns() in tests. */
const _lastObservation = new Map<KodiObservationType, number>();

/** Collect any currently-tripped observations, respecting cooldowns.
 * Pure function of signals + cooldown state — easy to unit-test. */
export function collectObservations(signals: SessionSignals): KodiObservation[] {
  const now = Date.now();
  const out: KodiObservation[] = [];

  const canFire = (t: KodiObservationType): boolean => {
    const last = _lastObservation.get(t) ?? 0;
    return now - last >= OBS_COOLDOWN_MS[t];
  };
  const record = (t: KodiObservationType, detail: string) => {
    out.push({ type: t, detail });
    _lastObservation.set(t, now);
  };

  if (signals.idleMs > 10 * 60_000 && canFire("long_idle")) {
    record("long_idle", `idle for ${Math.round(signals.idleMs / 60_000)} minutes`);
  }
  if (signals.contextPressure > 0.85 && canFire("context_pressure")) {
    record(
      "context_pressure",
      `context at ${Math.round(signals.contextPressure * 100)}% — /compact soon`,
    );
  }
  if (signals.sessionMs > 2 * 3600_000 && canFire("long_session")) {
    record("long_session", `${Math.round(signals.sessionMs / 3600_000)}h at the keyboard`);
  }
  if (
    signals.toolUses > 20 &&
    signals.msSinceCommit > 45 * 60_000 &&
    canFire("no_recent_commit")
  ) {
    record(
      "no_recent_commit",
      `${signals.toolUses} tools since last commit — time to save?`,
    );
  }

  return out;
}

/** Reset cooldowns. Test-only. */
export function resetObservationCooldowns(): void {
  _lastObservation.clear();
}

const OBSERVATION_SCHEMA = {
  name: "kodi_observation",
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

const OBSERVATION_SYSTEM = `You are Kodi, a dev advisor mascot.
You noticed something about the user's session and want to nudge them gently.
Output ONE JSON object: {"advice": "..."}.
advice: ≤80 chars, specific, no hedge words (consider/maybe/should/ensure/might).
If you have nothing specific to add beyond the raw detail, use null.`;

/**
 * Turn a raw observation into a rendered advice line by asking the
 * LLM for a terse phrasing. Falls back to the detail text verbatim
 * when the LLM is down or emits fluff. */
export async function renderObservation(obs: KodiObservation): Promise<string> {
  const user = `Observation type: ${obs.type}. Detail: ${obs.detail}.`;
  const raw = await callKodi(OBSERVATION_SYSTEM, user, OBSERVATION_SCHEMA, 40);
  const parsed = tryParseJson<{ advice?: string | null }>(raw);
  const advice = parsed?.advice;
  if (
    !advice ||
    typeof advice !== "string" ||
    /\b(consider|maybe|should|recommended?|ensure|might want to|try to)\b/i.test(advice)
  ) {
    return obs.detail;
  }
  return advice.slice(0, 120);
}

// ─── 3d — Personality ───────────────────────────────────────────

const PERSONALITY_SCHEMA = {
  name: "kodi_personality",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["personality"],
    properties: {
      personality: {
        type: "string",
        enum: ["sarcastic", "hyped", "tired", "curious", "focused", "mischievous"],
      },
    },
  },
};

const PERSONALITY_SYSTEM = `You are Kodi's brain. Pick ONE personality for this coding session.
Output: {"personality": "..."}.
Options: sarcastic, hyped, tired, curious, focused, mischievous.
Mix it up — don't always pick the same one.`;

/** Ask the LLM to pick a personality for the session. Falls back to
 * a random pick if the server is unreachable. Safe to await early in
 * startup — tight timeout and short output. */
export async function pickSessionPersonality(): Promise<KodiPersonality> {
  const raw = await callKodi(
    PERSONALITY_SYSTEM,
    "Pick a personality for this session.",
    PERSONALITY_SCHEMA,
    15,
  );
  const parsed = tryParseJson<{ personality?: string }>(raw);
  const personality = parsed?.personality;
  const valid: KodiPersonality[] = [
    "sarcastic",
    "hyped",
    "tired",
    "curious",
    "focused",
    "mischievous",
  ];
  if (personality && valid.includes(personality as KodiPersonality)) {
    return personality as KodiPersonality;
  }
  // Deterministic fallback — uniform random across the 6 options.
  return valid[Math.floor(Math.random() * valid.length)] ?? "focused";
}
