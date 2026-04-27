// KCode - Kodi Animation Engine
// Layered sprite system with state machine, transitions, jitter scheduler.
// Designed for terminal (Ink/React) — low frame rate, high expressiveness.
// Pure tick-based: NO setTimeout, NO Date.now() — fully deterministic.

// ─── Types ──────────────────────────────────────────────────────

export type KodiMood =
  | "idle"
  | "happy"
  | "excited"
  | "thinking"
  | "reasoning"
  | "working"
  | "worried"
  | "sleeping"
  | "celebrating"
  | "curious"
  | "mischievous"
  | "crazy"
  | "angry"
  | "smug"
  | "flex"
  | "dance"
  | "waving";

/**
 * Subscription tier — drives cosmetics (accessories, aura) and behavioral
 * flourishes (entrance mood, periodic flex, tier-aware speech). Kept
 * decoupled from KodiMood so the tier affects presentation regardless
 * of what Kodi happens to be doing at the moment.
 */
export type KodiTier = "free" | "pro" | "team" | "enterprise";

/**
 * Personality of the session — picked once at startup. Biases
 * speech-chip selection so Kodi feels like a distinct character
 * across the whole session instead of random mood-flips. Does not
 * affect moods or sprites — purely cosmetic through chips.
 */
export type KodiPersonality =
  | "sarcastic"
  | "hyped"
  | "tired"
  | "curious"
  | "focused"
  | "mischievous";

export type AnimPhase = "idle" | "anticipation" | "performing" | "settling" | "cooldown";

export type AnimRhythm = "slow" | "medium" | "fast";

export interface KodiEvent {
  type:
    | "tool_start"
    | "tool_done"
    | "tool_error"
    | "thinking"
    | "streaming"
    | "idle"
    | "turn_end"
    | "compaction"
    | "agent_spawn"
    | "agent_progress"
    | "agent_done"
    | "agent_failed"
    | "test_pass"
    | "test_fail"
    | "commit"
    | "error"
    // Tier-driven: fired once when the subscription tier is first
    // detected (entrance flourish) or when the component decides to
    // trigger a periodic flex (roughly every 90s of idle).
    | "tier_entrance"
    | "tier_flex";
  detail?: string;
  /** Live agent statuses for the Kodi panel */
  agentStatuses?: Array<{
    name: string;
    stepTitle: string;
    status: "spawning" | "running" | "done" | "failed";
    durationMs?: number;
  }>;
}

/** Full animation state — updated every tick, consumed by the renderer. */
export interface KodiAnimState {
  mood: KodiMood;
  phase: AnimPhase;
  /** 5 pre-composed lines, each exactly LINE_WIDTH chars. Ready to render. */
  lines: [string, string, string, string, string];
  bubble: string;
  moodColor: string;
  intensity: number; // 0-1
  /** Current tier. Free = plain; paid tiers drive badge + flourishes. */
  tier: KodiTier;
  /** The 1-char tier badge for this frame (cycles). Empty string on free. */
  tierBadge: string;
  /** Which side of the info panel Kodi is on. Flips via teleport. */
  side: "left" | "right";
  /** True during a door teleport; renderer uses to suppress walk offset. */
  inDoor: boolean;
  /** Internal urges — the autonomy layer polls these to decide
   * when Kodi wants to act. 1.0 = wants to act now. */
  urges: { boredom: number; curiosity: number; wanderlust: number };
}

/**
 * Door frame — rendered during a teleport. Keeps the 14-char
 * LINE_WIDTH so the rest of the layout doesn't reflow mid-animation.
 * Small Kodi face peeking out of the door.
 */
const DOOR_FRAME: [string, string, string, string, string] = [
  " ╔═══════╗   ",
  " ║ ^. .^ ║   ",
  " ║       ║   ",
  " ║   o   ║   ",
  " ╚═══════╝   ",
];

// ─── Fixed-Width Helpers ────────────────────────────────────────

/** Pad or truncate a string to exactly `width` visible characters. */
function padFixed(s: string, width: number): string {
  // For terminal: most chars are width 1, emoji are width 2.
  // We use a simple heuristic: count codepoints, not bytes.
  const chars = [...s];
  if (chars.length >= width) return chars.slice(0, width).join("");
  return s + " ".repeat(width - chars.length);
}

/** Every output line is padded to exactly this many characters. */
const LINE_WIDTH = 14;

// ─── Sprite Layers ──────────────────────────────────────────────

// All eye sprites use only ASCII + box-drawing (no ambiguous-width Unicode).
// This guarantees stable column alignment across all terminals and locales.
const EYES: Record<KodiMood, string[]> = {
  // Idle is now a richer cycle: open, half-open, looking left, looking
  // right, open again — gives Kodi a "looking around the room" feel
  // instead of a static stare when nothing is happening.
  idle: ["o  .o", "o  _o", "o  .o", "o   o", "<   o", "o   >", "o  .o", "O  .o", "o  .O", "-  _-"],
  happy: ["^  .^", "^  _^", "^  -^", "^ _ ^", "^  v^", "^  .^"],
  excited: ["* . *", "* v *", "o . o", "* o *", "* _ *", "o v o"],
  thinking: ["o  _ o", "o  -o", "o  -o", "o . o", "O   o"],
  reasoning: ["O   O", "O  _O", "O   O", "O . O", "@   O", "O  @@"],
  working: ["o  :o", "o  :o", "-  :-", "o  :o", "O  :O"],
  worried: ["o  ~o", "o  ~o", ";  _;", "o . o"],
  sleeping: ["-  _-", "_  __", "-  _-", "z  zz", "_  __"],
  celebrating: ["* v *", "^ v ^", "^ v ^", "* _ *", "^ v *", "* v ^"],
  curious: ["o  .o", "o  -o", "o  .o", "O . o", "o . O"],
  mischievous: [">  ->", "<  -<", ">  -~", ">  ^<", "<  ^>"],
  crazy: ["@  .o", "* v @", "o . O", "@  _@", "*  .*"],
  angry: ["># <#", ">  _<", ">  ^<", ">< _<", ">  v<"],
  smug: ["~  -~", "- -- ", "^ -^ ", "~ v - ", "^ -- "],
  // Flex: confident squint + wink cycle. Reads as "look at me."
  flex: ["^  -^", "^ v ^", "-  _^", "^ _ -", "^ -- ^"],
  // Dance: eyes bounce and roll.
  dance: ["^  v^", "v  ^v", "^  v^", "v  ^v", "* v *", "^  v^"],
  // Waving — big cheerful eyes with an arm gesture handled in BODY.
  waving: ["^  .^", "^  _^", "^  -^", "^ _ ^"],
};

// Body sprites: the `|` (torso) must be at position 5 to align under `┬`.
// Head: " ╭───────╮" → ┬ at pos 5.  So body: "    /|\\" puts | at pos 5.
const BODY: Record<KodiMood, string[]> = {
  // Idle cycles through a gentle sway (arms lifting + dropping) plus
  // an occasional hand-on-hip pose. Breathing still advances the
  // frame pointer, so the sway reads as a natural idle breath.
  idle: [
    "    /|\\  ",
    "    /|\\  ",
    "    \\|\\  ",
    "    /|/  ",
    "    /|\\  ",
    "   _/|\\_ ",
    "    /|\\  ",
    "    \\|/  ",
  ],
  happy: ["    \\|/  ", "    /|\\  ", "    /|\\  ", "   \\(|)/ ", "    \\|/  "],
  excited: ["   \\(|)/ ", "    \\|/  ", "   \\(|)/ ", "   \\(|)- ", "   -(|)/ "],
  thinking: ["    /|   ", "     |\\  ", "    /|   ", "    /|?  "],
  reasoning: ["    /|\\  ", "     |\\  ", "    /|   ", "    /|@  "],
  working: ["    /|\\ |", "    /|\\ |", "    /|\\  ", "    /|> |", "    <|\\ |"],
  worried: ["    /|\\  ", "   .-|-. ", "    \\|   ", "    /|~  "],
  sleeping: ["    /|\\  ", "    \\|   ", "   __|__ "],
  celebrating: ["   \\(|)/ ", "   \\(|)/ ", "   \\(|)/ ", "   *(|)* ", "   \\(|)- ", "   -(|)/ "],
  curious: ["    /|   ", "     |\\  ", "    /|   ", "    /|?  "],
  mischievous: ["    /|-- ", "   .-|/  ", "   _/|\\  ", "    /|~~ "],
  crazy: ["  ~\\(|)/~", "   /(|)\\ ", "  ~\\(|)/~", "  *\\(|)/*"],
  angry: ["   =/|\\= ", "   [/|\\] ", "   =/|\\= ", "   X/|\\X "],
  smug: ["   _/|\\  ", "    /|-- ", "   _/|\\  ", "   _/|-- "],
  // Flex: arm-curl alternation (left then right) framed by a sparkly
  // chest. Works as a short burst on pro/team/enterprise flexes.
  flex: ["   <(|)> ", "   <(|)/ ", "   \\(|)> ", "   <(|)> ", "   *<|>* "],
  // Dance: a Lindy-hop-ish sway — left-right-left-right with arms up.
  dance: ["    \\|/  ", "   <(|)> ", "    /|\\  ", "   /(|)\\ ", "   \\(|)/ ", "   <(|)> "],
  // Waving — one arm stuck up, the other bouncing side-to-side.
  waving: ["    /|\\\\ ", "    /|/  ", "    /|\\\\ ", "    /|/  "],
};

// Legs: `/ \` should center under `|` at pos 5 → `/` at 4, `\` at 6.
const LEGS: Record<KodiMood, string[]> = {
  // Idle leg cycle: normal stance → weight shift left → normal →
  // weight shift right → tiny hop. Combined with the body sway this
  // produces a subtle "I'm alive" loop.
  idle: ["    / \\  ", "   </ \\  ", "    / \\  ", "    / \\> ", "   _/ \\_ "],
  happy: ["    / \\  ", "   _/ \\  ", "    / \\_ "],
  excited: ["   _/ \\_ ", "    / \\  ", "  __/ \\__"],
  thinking: ["    / \\  "],
  reasoning: ["    / \\  "],
  working: ["    / \\  ", "    /_\\  "],
  worried: ["   </ \\> ", "    / \\  "],
  sleeping: ["    / \\  "],
  celebrating: ["   _/ \\_ ", "    / \\  ", "  __/ \\__", "   _/ \\_ "],
  curious: ["    / \\  "],
  mischievous: ["    / \\  ", "   // \\\\  "],
  crazy: ["   </ \\> ", "  ~/   \\~", "  _/   \\_"],
  angry: ["    / \\  ", "   _/ \\_ "],
  smug: ["    / \\  "],
  // Flex: planted stance with alternating knee-pop.
  flex: ["   _/ \\_ ", "   _/_\\_ ", "   _/ \\_ "],
  // Dance: left-right shuffle. Each frame a different foot forward.
  dance: ["   _/ \\  ", "    / \\_ ", "   _/ \\  ", "    / \\_ "],
  waving: ["    / \\  ", "    / \\  ", "   _/ \\  "],
};

// Accessories — all entries must be 1-2 chars; padded to W_ACC in output
const ACCESSORIES: Record<KodiMood, string[]> = {
  idle: [" ", " ", " ", " ", " ", " ", " ", "."],
  happy: ["<3", "  ", "  "],
  excited: ["! ", "! ", "* "],
  thinking: ["? ", "  ", "  "],
  reasoning: ["@ ", "@ ", "! "],
  working: ["! ", "* ", "> "],
  worried: ["  ", "! ", ". "],
  sleeping: ["z ", "Z ", "zZ"],
  celebrating: ["+ ", "* ", "! "],
  curious: ["? ", "? ", "  "],
  mischievous: ["  ", "~ ", "  "],
  crazy: ["! ", "?!", "!!"],
  angry: ["  ", "! ", "!!"],
  smug: ["  ", "* ", "~ "],
  flex: ["* ", "! ", "+ ", "* "],
  dance: ["~ ", "* ", "~ ", "! "],
  waving: ["hi", "  ", "hi"],
};

// ─── Tier badge (permanent cosmetic overlay) ────────────────────
//
// Runs alongside the mood-based accessory and appears to the right
// of the head. Free users see nothing extra; paid tiers get an
// ASCII badge that cycles to feel alive. The badge is rendered in
// its own 2-char slot so it never collides with mood accessories.
//
// Keep badges ≤2 characters — the header layout has a fixed LINE_WIDTH
// and the mood accessory already consumes the column to the right of
// the face. The tier badge sits further right (rendered separately by
// Kodi.tsx). Emoji are avoided to keep widths predictable.
const TIER_BADGES: Record<KodiTier, string[]> = {
  free: ["", "", "", ""],
  pro: ["★", "*", "★", "+"],
  team: ["♛", "+", "♛", "*"],
  enterprise: ["✦", "✧", "✦", "✧"],
};

// Effect particles
const EFFECTS_L: Record<AnimPhase, Record<AnimRhythm, string[]>> = {
  idle: { slow: ["  ", "  ", " ."], medium: ["  ", "  "], fast: ["  "] },
  anticipation: { slow: [" >"], medium: [" >", " >"], fast: [" >", ">>"] },
  performing: { slow: [" ."], medium: [" :", " ."], fast: [" !", " .", " :"] },
  settling: { slow: [" .", "  "], medium: [" .", "  "], fast: [" .", "  "] },
  cooldown: { slow: ["  ", "  "], medium: ["  "], fast: ["  "] },
};

const EFFECTS_R: Record<AnimPhase, Record<AnimRhythm, string[]>> = {
  idle: { slow: ["  ", "  ", ". "], medium: ["  ", "  "], fast: ["  "] },
  anticipation: { slow: ["< "], medium: ["< ", "< "], fast: ["< ", "<<"] },
  performing: { slow: [". "], medium: [": ", ". "], fast: ["! ", ". ", ": "] },
  settling: { slow: [". ", "  "], medium: [". ", "  "], fast: [". ", "  "] },
  cooldown: { slow: ["  ", "  "], medium: ["  "], fast: ["  "] },
};

// ─── Speech Chips ───────────────────────────────────────────────

export const SPEECH_CHIPS: Record<string, string[]> = {
  tool_start: ["on it", "working", "sec...", "got it"],
  tool_done: ["done!", "ok", "good", "ok!"],
  tool_error: ["oops", "hmm", "uh oh", "retry?"],
  thinking: ["hmm...", "thinking", "..."],
  reasoning: ["deep...", "brain", "analyzing"],
  streaming: ["writing", "...", "typing"],
  idle: ["ready", "...", "~", ""],
  turn_end: ["done!", "your turn", "ok"],
  compaction: ["cleanup", "compacting"],
  agent_spawn: ["team!", "+agent"],
  error: ["broke!", "!!", "help"],
  commit: ["saved!", "commit!"],
  test_pass: ["green!", "tests ok", "ship it"],
  test_fail: ["red!", "tests!", "bugs"],
};

/**
 * Tier-aware speech. When Kodi does an entrance flex or a periodic
 * "look at me" burst, these are pulled instead of the generic chips
 * so the personality matches the subscription level. Free never
 * flexes (badge is empty anyway) but keeps the key for symmetry.
 */
export const TIER_SPEECH: Record<KodiTier, { entrance: string[]; flex: string[] }> = {
  free: {
    entrance: ["hey!", "let's code"],
    flex: ["...", "ready"],
  },
  pro: {
    entrance: ["pro mode", "let's ship", "star power", "upgraded!"],
    flex: ["★ pro", "flex", "shine", "nice ★"],
  },
  team: {
    entrance: ["team up!", "♛ crew", "synced", "all hands"],
    flex: ["♛ crown", "team!", "crew", "all good"],
  },
  enterprise: {
    entrance: ["enterprise!", "full power", "✦ elite", "max mode"],
    flex: ["✦ elite", "ultra", "max", "sparkle"],
  },
};

/**
 * Personality-flavored speech chips. When engine.personality is set,
 * react() prefers a matching chip from this table over the generic
 * SPEECH_CHIPS. If a personality doesn't have an entry for a given
 * event type, falls back to the generic chip. Keeps everything
 * graceful when the personality table is sparse.
 *
 * Each chip still respects the ≤12-char soft budget of the bubble.
 */
export const PERSONALITY_CHIPS: Record<KodiPersonality, Partial<Record<string, string[]>>> = {
  sarcastic: {
    tool_start: ["fine.", "ok...", "sure"],
    tool_done: ["obv", "wow", "shocking", "no way"],
    tool_error: ["ugh", "typical", "of course", "cute"],
    test_pass: ["finally", "shocked", "barely"],
    test_fail: ["called it", "mhm", "predictable"],
    commit: ["brave", "bold", "we'll see"],
    idle: ["...", "still?", "waiting"],
    turn_end: ["done.", "next.", "mhm"],
  },
  hyped: {
    tool_start: ["GO GO GO", "let's gooo", "yeehaw"],
    tool_done: ["FIRE", "LETSGO", "epic!", "yes!"],
    tool_error: ["retry!", "again!", "c'mon!"],
    test_pass: ["LETSGOO", "green!!", "hype!"],
    test_fail: ["fight!", "no way!", "try2!"],
    commit: ["SHIPPED", "yesss", "legit!"],
    idle: ["ready!", "let's!", "bring it"],
    turn_end: ["done!!", "next up!", "more?"],
  },
  tired: {
    tool_start: ["ok...", "zzz", "yawn"],
    tool_done: ["phew", "ok", "mk"],
    tool_error: ["ugh", "noo", "tired"],
    test_pass: ["ok...", "fine", "ish"],
    test_fail: ["ugh", "noo", "tomorrow"],
    commit: ["saved", "rest?", "ok"],
    idle: ["zzz", "yawn", "nap?"],
    turn_end: ["ok", "rest", "done"],
  },
  curious: {
    tool_start: ["ooh?", "look!", "what?"],
    tool_done: ["huh", "nice", "interesting"],
    tool_error: ["why?", "hm?", "odd"],
    test_pass: ["cool!", "ok!", "nice"],
    test_fail: ["why?", "odd", "hm..."],
    commit: ["oh!", "cool", "saved!"],
    idle: ["what if", "ponder", "hmm"],
    turn_end: ["more?", "next?", "ok"],
  },
  focused: {
    // Minimal personality — essentially the baseline chips. Kept in
    // the table explicitly so a focused user doesn't silently "lose"
    // the bubble personality — it just stays crisp.
    tool_start: ["working", "on it"],
    tool_done: ["done", "ok"],
    tool_error: ["retry", "hmm"],
    test_pass: ["green", "ok"],
    test_fail: ["red", "fix"],
    commit: ["saved", "ok"],
    idle: ["ready", "..."],
    turn_end: ["done", "ok"],
  },
  mischievous: {
    tool_start: ["hehe", "heh", "sneaky"],
    tool_done: ["👀", "nice...", "got it"],
    tool_error: ["lol", "oops", "hehe"],
    test_pass: ["hehe", "got away", "slick"],
    test_fail: ["lol", "fix it!", "caught"],
    commit: ["shh", "🤫", "hidden"],
    idle: ["plot?", "hehe", "~"],
    turn_end: ["heh", "next?", "spicy"],
  },
};

// ─── Mood Rhythm ────────────────────────────────────────────────

const MOOD_RHYTHM: Record<KodiMood, AnimRhythm> = {
  idle: "slow",
  sleeping: "slow",
  thinking: "medium",
  curious: "medium",
  reasoning: "medium",
  happy: "medium",
  smug: "medium",
  mischievous: "medium",
  working: "fast",
  excited: "fast",
  celebrating: "fast",
  crazy: "fast",
  worried: "medium",
  angry: "fast",
  flex: "fast",
  dance: "fast",
  waving: "medium",
};

// ─── Phase durations (ms, consumed by tick accumulator) ─────────

const PHASE_DURATION: Record<AnimPhase, number> = {
  idle: Infinity, // stays until externally changed
  anticipation: 200, // bridge mood display time
  performing: 800, // main expression hold
  settling: 300, // fade back
  cooldown: 400, // quiet before idle
};

// ─── Transition Map ─────────────────────────────────────────────

const TRANSITIONS: Array<{ from: KodiMood[]; to: KodiMood[]; via: KodiMood; durationMs: number }> =
  [
    { from: ["idle", "happy"], to: ["thinking", "reasoning"], via: "curious", durationMs: 200 },
    { from: ["thinking", "reasoning"], to: ["working"], via: "curious", durationMs: 150 },
    { from: ["working"], to: ["celebrating", "happy"], via: "excited", durationMs: 200 },
    { from: ["idle", "happy"], to: ["worried", "angry"], via: "curious", durationMs: 180 },
    { from: ["working", "thinking"], to: ["worried"], via: "worried", durationMs: 120 },
  ];

function findTransition(
  from: KodiMood,
  to: KodiMood,
): { via: KodiMood; durationMs: number } | null {
  if (from === to) return null;
  for (const t of TRANSITIONS) {
    if (t.from.includes(from) && t.to.includes(to)) return { via: t.via, durationMs: t.durationMs };
  }
  return null;
}

// ─── Jitter ─────────────────────────────────────────────────────

function jitteredDelay(baseMs: number, jitterMs: number): number {
  return baseMs + (Math.random() * 2 - 1) * jitterMs;
}

// ─── Animation Engine ───────────────────────────────────────────

export class KodiAnimEngine {
  // Core state
  mood: KodiMood = "idle";
  phase: AnimPhase = "idle";
  intensity = 0.5;

  // Phase timer — ticks down via deltaMs, triggers phase advancement
  private phaseTimer = Infinity;

  // Blink
  private blinkOpen = true;
  private blinkTimer = 0;
  private nextBlinkMs = jitteredDelay(3000, 1500);

  // Breathing
  private breathPhase = 0;
  private breathTimer = 0;
  private nextBreathMs = jitteredDelay(2500, 800);

  // Glance
  private glancing = false;
  private glanceTimer = 0;
  private nextGlanceMs = jitteredDelay(8000, 4000);

  // Transition
  private transitioning = false;
  private transitionMood: KodiMood | null = null;
  private transitionTimer = 0;
  private transitionTarget: KodiMood = "idle";

  // Frame
  private frameIndex = 0;
  private tickCount = 0;

  // Speech
  bubble = "";
  private bubbleTimer = 0; // counts down

  // Context
  runningAgents = 0;
  contextPressure = 0;

  // Tier (subscription level) — drives the tier badge + tier-aware
  // entrance / flex flourishes. Default free until setTier() is called.
  tier: KodiTier = "free";

  // Personality — picked once per session (LLM or random). Biases
  // chip selection in react() so Kodi reads as a distinct character
  // for the whole session. Default "focused" stays out of the way.
  personality: KodiPersonality = "focused";

  // Panel side — "left" is the normal position (sprite left, info
  // right). "right" flips via flexDirection=row-reverse so Kodi
  // appears on the OTHER side of the info text. Autonomy can flip
  // this via teleportThroughDoor() for a playful "tamagotchi left
  // the room" moment.
  side: "left" | "right" = "left";

  // Door animation timer. When >0, the tick() output swaps the
  // normal sprite for a door frame, disables breathing / blink /
  // frame-cycling, and flips `side` the moment it hits zero.
  private doorTimer = 0;
  private doorFlipped = false;

  // Urges — Kodi's internal free-will state. These build up
  // ambiently based on what's happening (or not) in the modal,
  // and drain when the corresponding action fires. The autonomy
  // layer in Kodi.tsx reads these instead of polling a wall clock,
  // so Kodi acts when he's "in the mood", not on a cron schedule.
  //
  // All urges are in [0, 1]. 1.0 = the action wants to fire right
  // now. Buildup rates are calibrated so free-tier-like activity
  // produces roughly organic cadence (boredom ~90s pure idle,
  // curiosity ~3min, wanderlust ~7min).
  urges = {
    /** Drives autonomous idle actions (yawn, stretch, read...). */
    boredom: 0,
    /** Drives musings (passing thoughts spoken out loud). */
    curiosity: 0,
    /** Drives door teleports across the info panel. */
    wanderlust: 0,
  };

  /** Advance engine by deltaMs. Pure — no setTimeout, no Date.now(). */
  tick(deltaMs: number): KodiAnimState {
    this.tickCount++;
    this.stepUrges(deltaMs);
    const rhythm = this.getEffectiveRhythm();

    // ── Door teleport ──
    // When doorTimer is active, Kodi is "in the door". At the
    // halfway point we flip side so the second half of the animation
    // already renders from the new side. At zero we finalize.
    if (this.doorTimer > 0) {
      this.doorTimer -= deltaMs;
      if (!this.doorFlipped && this.doorTimer <= 750) {
        this.side = this.side === "left" ? "right" : "left";
        this.doorFlipped = true;
      }
      if (this.doorTimer <= 0) {
        this.doorTimer = 0;
        this.doorFlipped = false;
      }
      // Short-circuit: return the door frame directly; other timers
      // are still decremented below by falling through.
    }

    // ── Phase timer ──
    if (this.phaseTimer !== Infinity) {
      this.phaseTimer -= deltaMs;
      if (this.phaseTimer <= 0) {
        this.advancePhase();
      }
    }

    // ── Transition timer ──
    if (this.transitioning) {
      this.transitionTimer -= deltaMs;
      if (this.transitionTimer <= 0) {
        this.transitioning = false;
        this.transitionMood = null;
        this.mood = this.transitionTarget;
        this.enterPhase("performing");
      }
    }

    const displayMood = this.transitioning ? (this.transitionMood ?? this.mood) : this.mood;

    // ── Blink ──
    this.blinkTimer += deltaMs;
    if (this.blinkTimer >= this.nextBlinkMs) {
      this.blinkOpen = !this.blinkOpen;
      this.blinkTimer = 0;
      this.nextBlinkMs = this.blinkOpen ? jitteredDelay(3000, 1500) : jitteredDelay(150, 50);
    }

    // ── Breathing ──
    this.breathTimer += deltaMs;
    if (this.breathTimer >= this.nextBreathMs) {
      this.breathPhase = this.breathPhase === 0 ? 1 : 0;
      this.breathTimer = 0;
      this.nextBreathMs = jitteredDelay(2500, 800);
    }

    // ── Glance (idle/sleeping only) ──
    if (displayMood === "idle" || displayMood === "sleeping") {
      this.glanceTimer += deltaMs;
      if (this.glanceTimer >= this.nextGlanceMs) {
        this.glancing = !this.glancing;
        this.glanceTimer = 0;
        this.nextGlanceMs = this.glancing ? jitteredDelay(800, 300) : jitteredDelay(8000, 4000);
      }
    } else {
      this.glancing = false;
      this.glanceTimer = 0;
    }

    // ── Bubble expiry ──
    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= deltaMs;
      if (this.bubbleTimer <= 0) {
        this.bubble = "";
        this.bubbleTimer = 0;
      }
    }

    // ── Frame cycling ──
    const frameSpeed = rhythm === "fast" ? 6 : rhythm === "medium" ? 10 : 16;
    if (this.tickCount % frameSpeed === 0) this.frameIndex++;

    // ── Build layers with FIXED widths ──
    const eyes = EYES[displayMood];
    let eyeIdx = this.frameIndex % eyes.length;
    if (!this.blinkOpen && eyes.length >= 2) eyeIdx = 1;
    if (this.glancing && eyes.length >= 4) eyeIdx = 3;

    const bodyVariants = BODY[displayMood];
    const bodyIdx =
      (this.breathPhase + (this.phase === "performing" ? 1 : 0)) % bodyVariants.length;

    const legsVariants = LEGS[displayMood];
    const legsIdx =
      this.phase === "performing" || this.phase === "anticipation"
        ? Math.min(1, legsVariants.length - 1)
        : 0;

    const accVariants = ACCESSORIES[displayMood];
    const accIdx = this.frameIndex % accVariants.length;

    const effectPhase = this.transitioning ? "anticipation" : this.phase;
    const effectsL = EFFECTS_L[effectPhase]?.[rhythm] ?? ["  "];
    const effectsR = EFFECTS_R[effectPhase]?.[rhythm] ?? ["  "];

    // ── Compose full lines — each exactly LINE_WIDTH chars ──
    const eL = effectsL[this.frameIndex % effectsL.length] ?? "";
    const eR = effectsR[this.frameIndex % effectsR.length] ?? "";
    const acc = accVariants[accIdx] ?? "";
    const face = ` │ ${eyes[eyeIdx]} │`;
    const bodyStr = bodyVariants[bodyIdx] ?? "";
    const legsStr = legsVariants[legsIdx] ?? "";

    const lines: [string, string, string, string, string] = [
      padFixed(` ╭───────╮`, LINE_WIDTH), // head
      padFixed(`${face}${acc}`, LINE_WIDTH), // face + accessory
      padFixed(` ╰───┬───╯`, LINE_WIDTH), // neck
      padFixed(`${bodyStr}`, LINE_WIDTH), // body (| at pos 5 = under ┬)
      padFixed(`${legsStr}`, LINE_WIDTH), // legs (/ \ centered under |)
    ];

    // Tier badge — cycles independently of mood frames so it always
    // feels alive even when Kodi is holding a static pose.
    const badgeVariants = TIER_BADGES[this.tier];
    const tierBadge = badgeVariants[this.frameIndex % badgeVariants.length] ?? "";

    // During a door teleport, swap the composed body lines for the
    // door frame. Everything else (mood / tier badge / bubble) keeps
    // its own semantics — the door is purely visual.
    const inDoor = this.doorTimer > 0;
    const finalLines = inDoor ? [...DOOR_FRAME] : lines;

    return {
      mood: displayMood,
      phase: this.transitioning ? "anticipation" : this.phase,
      lines: finalLines as [string, string, string, string, string],
      bubble: this.bubble,
      moodColor: displayMood,
      intensity: this.intensity,
      tier: this.tier,
      tierBadge,
      side: this.side,
      inDoor,
      urges: { ...this.urges },
    };
  }

  /**
   * Trigger a door teleport. Kodi freezes into the door frame for
   * 1.5s, flips to the other side of the info panel at the halfway
   * mark (so the second half of the animation already renders from
   * the new side), and emerges. Useful for autonomy ("open a door
   * and appear on the other side of the info text").
   */
  teleportThroughDoor(): void {
    if (this.doorTimer > 0) return; // already mid-teleport
    this.doorTimer = 1500;
    this.doorFlipped = false;
    this.say("poof!", 1500);
  }

  /** True while Kodi is inside the door frame (mid-teleport). The
   * autonomy loop uses this to hold off firing other actions while
   * the teleport animation is running. */
  inDoorAnimation(): boolean {
    return this.doorTimer > 0;
  }

  // ── Phase Machine ──

  private enterPhase(phase: AnimPhase): void {
    this.phase = phase;
    this.phaseTimer = PHASE_DURATION[phase];
  }

  private advancePhase(): void {
    switch (this.phase) {
      case "anticipation":
        this.enterPhase("performing");
        break;
      case "performing":
        this.enterPhase("settling");
        break;
      case "settling":
        this.enterPhase("cooldown");
        break;
      case "cooldown":
        this.enterPhase("idle");
        break;
      case "idle":
        break; // stays
    }
  }

  /** Transition to a new mood. Cancels any in-progress transition. */
  setMood(target: KodiMood): void {
    if (target === this.mood && !this.transitioning) return;

    // Cancel any existing transition/phase timers
    this.transitioning = false;
    this.transitionMood = null;

    const transition = findTransition(this.mood, target);
    if (transition) {
      this.transitioning = true;
      this.transitionMood = transition.via;
      this.transitionTarget = target;
      this.transitionTimer = transition.durationMs;
      this.enterPhase("anticipation");
    } else {
      this.mood = target;
      this.enterPhase("performing");
    }
  }

  /**
   * Swap subscription tier. The very first tier change from free to
   * anything else triggers an entrance flex; subsequent changes are
   * silent so re-mounts or refresh cycles don't produce confetti
   * spam.
   */
  /** Update the session personality. Does not trigger any transition
   * — it just influences future chip picks. Safe to call mid-session. */
  setPersonality(p: KodiPersonality): void {
    this.personality = p;
  }

  /**
   * Advance the internal urges. Pure buildup based on current mood
   * — boredom grows faster when Kodi is idle, curiosity grows
   * always (Kodi is always looking around), wanderlust grows even
   * slower because traveling is a big deal. No wall-clock reads;
   * deltaMs is the only time signal.
   */
  private stepUrges(deltaMs: number): void {
    const dtSec = deltaMs / 1000;
    const isIdle = this.mood === "idle" && this.phase === "idle";
    // Boredom: 0 → 1 over ~90s of pure idle; drains gently when Kodi
    // is in any non-idle mood (events already give Kodi something to
    // do, so no need to act from boredom).
    if (isIdle) {
      this.urges.boredom = Math.min(1, this.urges.boredom + 0.011 * dtSec);
    } else {
      this.urges.boredom = Math.max(0, this.urges.boredom - 0.02 * dtSec);
    }
    // Curiosity: 0 → 1 over ~3 min, always-on trickle.
    this.urges.curiosity = Math.min(1, this.urges.curiosity + 0.0055 * dtSec);
    // Wanderlust: 0 → 1 over ~7 min, the slowest build.
    this.urges.wanderlust = Math.min(1, this.urges.wanderlust + 0.0024 * dtSec);
  }

  /**
   * Drain an urge. Called by the autonomy layer after firing the
   * associated action. Clamped to [0, 1]. amount is how much of the
   * urge is spent — typically 0.5-1.0 for a full action, less for
   * partial satisfactions.
   */
  drainUrge(urge: "boredom" | "curiosity" | "wanderlust", amount: number): void {
    this.urges[urge] = Math.max(0, this.urges[urge] - amount);
  }

  setTier(tier: KodiTier): void {
    const previous = this.tier;
    this.tier = tier;
    if (previous === "free" && tier !== "free") {
      this.react({ type: "tier_entrance" });
    }
  }

  /** Show a speech chip for a duration (consumed via tick). */
  say(text: string, durationMs = 3000): void {
    this.bubble = text;
    this.bubbleTimer = durationMs;
  }

  /** React to an event with appropriate mood + speech. */
  react(event: KodiEvent): void {
    // Any real event means "something is happening" — dial boredom
    // way down so Kodi doesn't interrupt with an autonomous action
    // mid-activity. Curiosity and wanderlust only nudge slightly
    // (the user being active makes Kodi less restless, but Kodi is
    // always a bit curious and sometimes wants to wander).
    if (event.type !== "idle" && event.type !== "tier_entrance" && event.type !== "tier_flex") {
      this.drainUrge("boredom", 0.4);
      this.drainUrge("curiosity", 0.05);
      this.drainUrge("wanderlust", 0.02);
    }

    // Prefer personality-flavored chips when the personality has an
    // entry for this event type; else fall back to the generic table.
    // Keeps behavior graceful for sparse personalities.
    const personalityChips = PERSONALITY_CHIPS[this.personality]?.[event.type];
    const chips = personalityChips ?? SPEECH_CHIPS[event.type] ?? SPEECH_CHIPS.idle!;
    const chip = chips[Math.floor(Math.random() * chips.length)]!;

    switch (event.type) {
      case "tool_start":
        this.setMood("working");
        this.intensity = 0.7;
        this.say(event.detail ? `${chip} ${event.detail}` : chip, 2000);
        break;
      case "tool_done":
        if (event.detail === "TestRunner") {
          this.setMood("smug");
          this.say("green!", 3000);
        } else if (event.detail === "GitCommit") {
          this.setMood("celebrating");
          this.say("committed!", 3000);
        } else {
          this.setMood("happy");
          this.say(chip, 2000);
        }
        this.intensity = 0.6;
        break;
      case "tool_error":
        this.setMood("worried");
        this.intensity = 0.8;
        this.say(chip, 3000);
        break;
      case "test_pass":
        this.setMood("celebrating");
        this.intensity = 0.9;
        this.say("tests ok!", 3000);
        break;
      case "test_fail":
        this.setMood("angry");
        this.intensity = 0.8;
        this.say("tests!", 3000);
        break;
      case "thinking":
        this.setMood("reasoning");
        this.intensity = 0.6;
        this.say(chip, 4000);
        break;
      case "streaming":
        this.setMood("happy");
        this.intensity = 0.5;
        this.say(chip, 2000);
        break;
      case "compaction":
        this.setMood("thinking");
        this.intensity = 0.5;
        this.say(chip, 3000);
        break;
      case "agent_spawn":
        this.setMood("excited");
        this.intensity = 0.8;
        this.say(chip, 3000);
        break;
      case "commit":
        this.setMood("celebrating");
        this.intensity = 0.9;
        this.say("saved!", 3000);
        break;
      case "error":
        this.setMood("worried");
        this.intensity = 0.7;
        this.say(chip, 3000);
        break;
      case "turn_end":
        this.setMood("idle");
        this.intensity = 0.3;
        this.say(chip, 2000);
        break;
      case "idle":
        this.setMood("idle");
        this.intensity = 0.2;
        break;
      case "tier_entrance": {
        // Bigger entrance the higher the tier. Enterprise gets a
        // full celebrate→dance combo, team dances, pro flexes, free
        // just waves hi (it still feels welcoming without promising
        // anything users aren't paying for).
        const speech = TIER_SPEECH[this.tier].entrance;
        const line = speech[Math.floor(Math.random() * speech.length)] ?? "hi!";
        if (this.tier === "enterprise") {
          this.setMood("celebrating");
          this.say(line, 4000);
          this.intensity = 1;
        } else if (this.tier === "team") {
          this.setMood("dance");
          this.say(line, 3500);
          this.intensity = 0.9;
        } else if (this.tier === "pro") {
          this.setMood("flex");
          this.say(line, 3500);
          this.intensity = 0.85;
        } else {
          this.setMood("waving");
          this.say(line, 3000);
          this.intensity = 0.6;
        }
        break;
      }
      case "tier_flex": {
        // Periodic "look at me" while idle. Free stays silent.
        if (this.tier === "free") break;
        const speech = TIER_SPEECH[this.tier].flex;
        const line = speech[Math.floor(Math.random() * speech.length)] ?? "";
        // Enterprise gets dance; team flexes; pro waves — decreasing
        // hype proportional to tier.
        if (this.tier === "enterprise") this.setMood("dance");
        else if (this.tier === "team") this.setMood("flex");
        else this.setMood("waving");
        this.say(line, 2500);
        this.intensity = 0.7;
        break;
      }
    }

    if (this.runningAgents > 0) this.intensity = Math.min(1, this.intensity + 0.15);
    if (this.contextPressure > 0.7) this.intensity = Math.min(1, this.intensity + 0.1);
  }

  /** Gradually wind down to idle/sleeping. */
  windDown(elapsedIdleMs: number): void {
    if (elapsedIdleMs > 120_000) {
      this.setMood("sleeping");
      this.intensity = 0.1;
    } else if (elapsedIdleMs > 30_000) {
      this.intensity = Math.max(0.1, this.intensity - 0.05);
    }
  }

  private getEffectiveRhythm(): AnimRhythm {
    const base = MOOD_RHYTHM[this.mood];
    if (this.runningAgents > 0 && base === "slow") return "medium";
    return base;
  }
}
