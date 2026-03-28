// KCode - Kodi Animation Engine
// Layered sprite system with state machine, transitions, jitter scheduler.
// Designed for terminal (Ink/React) — low frame rate, high expressiveness.

// ─── Types ──────────────────────────────────────────────────────

export type KodiMood =
  | "idle" | "happy" | "excited" | "thinking" | "reasoning"
  | "working" | "worried" | "sleeping" | "celebrating"
  | "curious" | "mischievous" | "crazy" | "angry" | "smug";

export type AnimPhase = "idle" | "anticipation" | "performing" | "settling" | "cooldown";

export type AnimRhythm = "slow" | "medium" | "fast";

export interface KodiEvent {
  type: "tool_start" | "tool_done" | "tool_error" | "thinking" | "streaming"
    | "idle" | "turn_end" | "compaction" | "agent_spawn"
    | "test_pass" | "test_fail" | "commit" | "error";
  detail?: string;
}

/** Full animation state — updated every tick, consumed by the renderer. */
export interface KodiAnimState {
  mood: KodiMood;
  phase: AnimPhase;
  // Layered sprite parts
  face: string;        // eyes + mouth line
  body: string;        // torso + arms line
  legs: string;        // legs line
  effectL: string;     // particle/aura left side
  effectR: string;     // particle/aura right side
  accessory: string;   // top-right icon (⚡, ?, !, 🧠, ♪, etc)
  // Speech
  bubble: string;      // short text chip
  // Meta
  moodColor: string;   // hint for the renderer (resolved by theme externally)
  intensity: number;   // 0-1, controls animation speed/amplitude
}

// ─── Sprite Layers ──────────────────────────────────────────────

// Eyes indexed by mood — each mood has 2-3 variants for blink/expression
const EYES: Record<KodiMood, string[]> = {
  idle:         ["•  ◡•", "◦  ◡◦", "•  ◡•", "•   •"],  // 4th = glance
  happy:        ["^  ◡^", "◕  ◡◕", "^  ‿^"],
  excited:      ["★ ◡ ★", "✧ ▽ ✧", "◕ ◡ ◕"],
  thinking:     ["•  _ •", "◦  ‿◦", "•  ‿•"],
  reasoning:    ["◉  ◉", "◉ _◉", "◉  ◉"],
  working:      ["•  ‸•", "◦  ‸◦", "-  ‸-"],
  worried:      ["°  ~°", "•  ~•", ";  _;"],
  sleeping:     ["-  _-", "_  __", "-  _-"],
  celebrating:  ["★ ▽ ★", "◕ ▽ ◕", "^ ▽ ^"],
  curious:      ["•  ᵕ•", "◦  ‿◦", "•  ᵕ•"],
  mischievous:  [">  ‿>", "<  ‿<", ">  ‿~"],
  crazy:        ["@  ◡°", "* ▽ @", "o ◡ O"],
  angry:        ["># <#", ">  _<", "> ^<"],
  smug:         ["~  ‿~", "- ‿- ", "^ ‿^ "],
};

// Body/arms indexed by mood — [rest, active, settle]
const BODY: Record<KodiMood, string[]> = {
  idle:         ["   /|\\  ", "   /|\\  ", "   /|\\  "],
  happy:        ["  \\|/   ", "   /|\\  ", "   /|\\  "],
  excited:      [" \\(|)/ ", "  \\|/   ", "  \\(|)/ "],
  thinking:     ["   /|   ", "    |\\  ", "   /|   "],
  reasoning:    ["   /|\\  ", "    |\\  ", "   /|   "],
  working:      ["   /|\\ ▌", "   /|\\ ▌", "   /|\\  "],
  worried:      ["   /|\\  ", " .-|-.  ", "  \\|    "],
  sleeping:     ["   /|\\  ", "  \\|    ", "  __|__  "],
  celebrating:  [" \\(|)/♪", " \\(|)/ ", " \\(|)/ "],
  curious:      ["   /|   ", "    |\\  ", "   /|   "],
  mischievous:  ["   /|--. ", " .-|/   ", " _/|\\   "],
  crazy:        ["~\\(|)/~ ", " /(|)\\  ", "~\\(|)/~ "],
  angry:        [" =/|\\=  ", " [/|\\]  ", " =/|\\=  "],
  smug:         [" ._/|\\  ", "  -/|--, ", " ._/|\\. "],
};

const LEGS: Record<KodiMood, string[]> = {
  idle:         ["   / \\  "],
  happy:        ["   / \\  "],
  excited:      ["  _/ \\_ ", "   / \\  "],
  thinking:     ["   / \\  "],
  reasoning:    ["   / \\  "],
  working:      ["   / \\  "],
  worried:      ["  </ \\> ", "   / \\  "],
  sleeping:     ["   / \\  "],
  celebrating:  ["  _/ \\_ ", "   / \\  "],
  curious:      ["   / \\  "],
  mischievous:  ["   / \\  ", "  // \\\\  "],
  crazy:        ["  </ \\> ", " ~/   \\~ ", " _/   \\_ "],
  angry:        ["   / \\  ", "  _/ \\_ "],
  smug:         ["   / \\  "],
};

// Accessories by mood (top-right icon)
const ACCESSORIES: Record<KodiMood, string[]> = {
  idle:         [" ", " ", " ", " ", " ", " ", " ", "·"],
  happy:        ["♥", " ", " "],
  excited:      ["!", "!", "✧"],
  thinking:     ["?", "…", " "],
  reasoning:    ["🧠", "🧠", "⚡"],
  working:      ["⚡", "⚙", "▶"],
  worried:      [" ", "!", "."],
  sleeping:     ["z", "Z", "Zz"],
  celebrating:  ["♪", "✨", "🎉"],
  curious:      ["?", "?", " "],
  mischievous:  [" ", "~", " "],
  crazy:        ["!", "?!", "!!"],
  angry:        [" ", "!", "!!"],
  smug:         [" ", "*", "~"],
};

// Effect particles (left/right of body)
const EFFECTS_L: Record<AnimPhase, Record<AnimRhythm, string[]>> = {
  idle:         { slow: ["  ", "  ", " ·"], medium: ["  ", "  "], fast: ["  "] },
  anticipation: { slow: [" ›"], medium: [" ›", " »"], fast: [" »", " »»"] },
  performing:  { slow: [" ·"], medium: [" :", " ·"], fast: [" ⚡", " ·", " :"] },
  settling:    { slow: [" ·", "  "], medium: [" ·", "  "], fast: [" ·", "  "] },
  cooldown:    { slow: ["  "], medium: ["  "], fast: ["  "] },
};

const EFFECTS_R: Record<AnimPhase, Record<AnimRhythm, string[]>> = {
  idle:         { slow: ["  ", "  ", "· "], medium: ["  ", "  "], fast: ["  "] },
  anticipation: { slow: ["‹ "], medium: ["‹ ", "« "], fast: ["« ", "««"] },
  performing:  { slow: ["· "], medium: [": ", "· "], fast: ["⚡", "· ", ": "] },
  settling:    { slow: ["· ", "  "], medium: ["· ", "  "], fast: ["· ", "  "] },
  cooldown:    { slow: ["  "], medium: ["  "], fast: ["  "] },
};

// ─── Speech Chips ───────────────────────────────────────────────

export const SPEECH_CHIPS: Record<string, string[]> = {
  tool_start:    ["on it", "working", "sec...", "got it"],
  tool_done:     ["done!", "✓", "good", "ok!"],
  tool_error:    ["oops", "hmm", "uh oh", "retry?"],
  thinking:      ["hmm...", "thinking", "..."],
  reasoning:     ["deep...", "🧠", "analyzing"],
  streaming:     ["writing", "...", "typing"],
  idle:          ["ready", "...", "~", ""],
  turn_end:      ["done!", "your turn", "✓"],
  compaction:    ["cleanup", "compacting"],
  agent_spawn:   ["team!", "+agent"],
  error:         ["broke!", "!!", "help"],
  commit:        ["saved!", "✓ commit"],
  test_pass:     ["green!", "✓ tests", "ship it"],
  test_fail:     ["red!", "✗ tests", "bugs"],
};

// ─── Mood Rhythm ────────────────────────────────────────────────

const MOOD_RHYTHM: Record<KodiMood, AnimRhythm> = {
  idle: "slow", sleeping: "slow",
  thinking: "medium", curious: "medium", reasoning: "medium",
  happy: "medium", smug: "medium", mischievous: "medium",
  working: "fast", excited: "fast", celebrating: "fast", crazy: "fast",
  worried: "medium", angry: "fast",
};

// ─── Transition Map ─────────────────────────────────────────────

/** Bridge moods for transitions — [from, to] → intermediate mood + duration ms */
const TRANSITIONS: Array<{ from: KodiMood[]; to: KodiMood[]; via: KodiMood; durationMs: number }> = [
  { from: ["idle", "happy"],       to: ["thinking", "reasoning"],  via: "curious",    durationMs: 200 },
  { from: ["thinking", "reasoning"], to: ["working"],              via: "curious",    durationMs: 150 },
  { from: ["working"],              to: ["celebrating", "happy"],  via: "excited",    durationMs: 200 },
  { from: ["idle", "happy"],        to: ["worried", "angry"],      via: "curious",    durationMs: 180 },
  { from: ["working", "thinking"],  to: ["worried"],               via: "worried",    durationMs: 120 },
];

function findTransition(from: KodiMood, to: KodiMood): { via: KodiMood; durationMs: number } | null {
  if (from === to) return null;
  for (const t of TRANSITIONS) {
    if (t.from.includes(from) && t.to.includes(to)) {
      return { via: t.via, durationMs: t.durationMs };
    }
  }
  return null;
}

// ─── Jitter Scheduler ───────────────────────────────────────────

/** Returns a random delay with jitter: base ± jitter */
function jitteredDelay(baseMs: number, jitterMs: number): number {
  return baseMs + (Math.random() * 2 - 1) * jitterMs;
}

// ─── Animation Engine ───────────────────────────────────────────

export class KodiAnimEngine {
  // Core state
  mood: KodiMood = "idle";
  phase: AnimPhase = "idle";
  intensity = 0.5;

  // Blink state
  private blinkOpen = true;
  private nextBlinkMs = jitteredDelay(3000, 1500);
  private blinkTimer = 0;

  // Breathing state (subtle body shift)
  private breathPhase = 0; // 0 or 1
  private nextBreathMs = jitteredDelay(2500, 800);
  private breathTimer = 0;

  // Glance state (occasional side look in idle)
  private glancing = false;
  private nextGlanceMs = jitteredDelay(8000, 4000);
  private glanceTimer = 0;

  // Transition state
  private transitioning = false;
  private transitionMood: KodiMood | null = null;
  private transitionEndMs = 0;
  private transitionTarget: KodiMood = "idle";

  // Frame counters
  private frameIndex = 0;
  private tickCount = 0;

  // Speech
  bubble = "";
  private bubbleExpireMs = 0;

  // Context
  runningAgents = 0;
  contextPressure = 0; // 0-1

  /** Advance time by deltaMs and return the current frame. */
  tick(deltaMs: number): KodiAnimState {
    this.tickCount++;
    const rhythm = this.getEffectiveRhythm();
    const now = Date.now();

    // ── Transition logic ──
    if (this.transitioning && now >= this.transitionEndMs) {
      this.transitioning = false;
      this.mood = this.transitionTarget;
      this.phase = "performing";
      this.transitionMood = null;
      // Auto-settle after performing
      setTimeout(() => {
        if (this.mood === this.transitionTarget && this.phase === "performing") {
          this.phase = "settling";
          setTimeout(() => {
            if (this.phase === "settling") this.phase = "idle";
          }, 300);
        }
      }, 800);
    }

    const displayMood = this.transitioning ? (this.transitionMood ?? this.mood) : this.mood;

    // ── Blink ──
    this.blinkTimer += deltaMs;
    if (this.blinkTimer >= this.nextBlinkMs) {
      this.blinkOpen = !this.blinkOpen;
      this.blinkTimer = 0;
      this.nextBlinkMs = this.blinkOpen
        ? jitteredDelay(3000, 1500)  // time until next blink
        : jitteredDelay(150, 50);     // blink duration (eyes closed)
    }

    // ── Breathing ──
    this.breathTimer += deltaMs;
    if (this.breathTimer >= this.nextBreathMs) {
      this.breathPhase = this.breathPhase === 0 ? 1 : 0;
      this.breathTimer = 0;
      this.nextBreathMs = jitteredDelay(2500, 800);
    }

    // ── Glance (idle only) ──
    if (displayMood === "idle" || displayMood === "sleeping") {
      this.glanceTimer += deltaMs;
      if (this.glanceTimer >= this.nextGlanceMs) {
        this.glancing = !this.glancing;
        this.glanceTimer = 0;
        this.nextGlanceMs = this.glancing
          ? jitteredDelay(800, 300)    // glance duration
          : jitteredDelay(8000, 4000); // time until next glance
      }
    } else {
      this.glancing = false;
      this.glanceTimer = 0;
    }

    // ── Frame cycling ──
    const frameSpeed = rhythm === "fast" ? 6 : rhythm === "medium" ? 10 : 16;
    if (this.tickCount % frameSpeed === 0) this.frameIndex++;

    // ── Build layers ──
    const eyes = EYES[displayMood];
    let eyeIdx = this.frameIndex % eyes.length;
    // Blink override: use idx 0 for open, idx 1 for closed (if available)
    if (!this.blinkOpen && eyes.length >= 2) eyeIdx = 1;
    // Glance: use last variant if available
    if (this.glancing && eyes.length >= 4) eyeIdx = 3;

    const bodyVariants = BODY[displayMood];
    const bodyIdx = (this.breathPhase + (this.phase === "performing" ? 1 : 0)) % bodyVariants.length;

    const legsVariants = LEGS[displayMood];
    const legsIdx = (this.phase === "performing" || this.phase === "anticipation")
      ? Math.min(1, legsVariants.length - 1)
      : 0;

    const accVariants = ACCESSORIES[displayMood];
    const accIdx = this.frameIndex % accVariants.length;

    const effectPhase = this.transitioning ? "anticipation" : this.phase;
    const effectsL = EFFECTS_L[effectPhase]?.[rhythm] ?? ["  "];
    const effectsR = EFFECTS_R[effectPhase]?.[rhythm] ?? ["  "];

    // Bubble expiry
    if (this.bubbleExpireMs > 0 && now >= this.bubbleExpireMs) {
      this.bubble = "";
      this.bubbleExpireMs = 0;
    }

    return {
      mood: displayMood,
      phase: this.transitioning ? "anticipation" : this.phase,
      face: ` │ ${eyes[eyeIdx]} │`,
      body: bodyVariants[bodyIdx]!,
      legs: legsVariants[legsIdx]!,
      effectL: effectsL[this.frameIndex % effectsL.length]!,
      effectR: effectsR[this.frameIndex % effectsR.length]!,
      accessory: accVariants[accIdx]!,
      bubble: this.bubble,
      moodColor: displayMood, // resolved to actual color by the component
      intensity: this.intensity,
    };
  }

  /** Transition to a new mood with anticipation/settling. */
  setMood(target: KodiMood): void {
    if (target === this.mood && !this.transitioning) return;

    const transition = findTransition(this.mood, target);
    if (transition) {
      this.transitioning = true;
      this.transitionMood = transition.via;
      this.transitionTarget = target;
      this.transitionEndMs = Date.now() + transition.durationMs;
      this.phase = "anticipation";
    } else {
      this.mood = target;
      this.phase = "performing";
      // Settle after a beat
      setTimeout(() => {
        if (this.phase === "performing") {
          this.phase = "settling";
          setTimeout(() => {
            if (this.phase === "settling") this.phase = "idle";
          }, 300);
        }
      }, 600);
    }
  }

  /** Show a speech chip for a duration. */
  say(text: string, durationMs = 3000): void {
    this.bubble = text;
    this.bubbleExpireMs = Date.now() + durationMs;
  }

  /** React to an event with appropriate mood + speech. */
  react(event: KodiEvent): void {
    const chips = SPEECH_CHIPS[event.type] ?? SPEECH_CHIPS.idle!;
    const chip = chips[Math.floor(Math.random() * chips.length)]!;

    switch (event.type) {
      case "tool_start":
        this.setMood("working");
        this.intensity = 0.7;
        this.say(event.detail ? `${chip} ${event.detail}` : chip, 2000);
        break;
      case "tool_done":
        if (event.detail === "TestRunner") { this.setMood("smug"); this.say("green!", 3000); }
        else if (event.detail === "GitCommit") { this.setMood("celebrating"); this.say("committed!", 3000); }
        else { this.setMood("happy"); this.say(chip, 2000); }
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
        this.say("✓ tests!", 3000);
        break;
      case "test_fail":
        this.setMood("angry");
        this.intensity = 0.8;
        this.say("✗ tests", 3000);
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
    }

    // Contextual intensity modifiers
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
    // Boost rhythm when agents are running
    if (this.runningAgents > 0 && base === "slow") return "medium";
    return base;
  }
}
