// KCode - Kodi Animation Engine
// Layered sprite system with state machine, transitions, jitter scheduler.
// Designed for terminal (Ink/React) — low frame rate, high expressiveness.
// Pure tick-based: NO setTimeout, NO Date.now() — fully deterministic.

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
  face: string;        // eyes + mouth line — FIXED 11 chars
  body: string;        // torso + arms — FIXED 9 chars
  legs: string;        // legs — FIXED 9 chars
  effectL: string;     // particle left — FIXED 2 chars
  effectR: string;     // particle right — FIXED 2 chars
  accessory: string;   // top-right icon — FIXED 2 chars (padded)
  bubble: string;
  moodColor: string;
  intensity: number;   // 0-1
}

// ─── Fixed-Width Helpers ────────────────────────────────────────

/** Pad or truncate a string to exactly `width` visible characters. */
function padFixed(s: string, width: number): string {
  // For terminal: most chars are width 1, emoji are width 2.
  // We use a simple heuristic: count codepoints, not bytes.
  const chars = [...s];
  if (chars.length >= width) return chars.slice(0, width).join("");
  return s + " ".repeat(width - chars.length);
}

// Fixed widths for each layer (characters)
const W_FACE = 11;     // " │ xxxxx │"
const W_BODY = 9;
const W_LEGS = 9;
const W_EFFECT = 2;
const W_ACC = 2;

// ─── Sprite Layers ──────────────────────────────────────────────

// All eye sprites use only ASCII + box-drawing (no ambiguous-width Unicode).
// This guarantees stable column alignment across all terminals and locales.
const EYES: Record<KodiMood, string[]> = {
  idle:         ["o  .o", "o  _o", "o  .o", "o   o"],
  happy:        ["^  .^", "^  _^", "^  -^"],
  excited:      ["* . *", "* v *", "o . o"],
  thinking:     ["o  _ o", "o  -o", "o  -o"],
  reasoning:    ["O   O", "O  _O", "O   O"],
  working:      ["o  :o", "o  :o", "-  :-"],
  worried:      ["o  ~o", "o  ~o", ";  _;"],
  sleeping:     ["-  _-", "_  __", "-  _-"],
  celebrating:  ["* v *", "^ v ^", "^ v ^"],
  curious:      ["o  .o", "o  -o", "o  .o"],
  mischievous:  [">  ->", "<  -<", ">  -~"],
  crazy:        ["@  .o", "* v @", "o . O"],
  angry:        ["># <#", ">  _<", ">  ^<"],
  smug:         ["~  -~", "- -- ", "^ -^ "],
};

const BODY: Record<KodiMood, string[]> = {
  idle:         ["   /|\\  ", "   /|\\  ", "   /|\\  "],
  happy:        ["  \\|/   ", "   /|\\  ", "   /|\\  "],
  excited:      [" \\(|)/ ", "  \\|/   ", " \\(|)/ "],
  thinking:     ["   /|   ", "    |\\  ", "   /|   "],
  reasoning:    ["   /|\\  ", "    |\\  ", "   /|   "],
  working:      ["   /|\\ |", "   /|\\ |", "   /|\\  "],
  worried:      ["   /|\\  ", " .-|-.  ", "  \\|    "],
  sleeping:     ["   /|\\  ", "  \\|    ", "  __|__ "],
  celebrating:  [" \\(|)/ +", " \\(|)/  ", " \\(|)/  "],
  curious:      ["   /|   ", "    |\\  ", "   /|   "],
  mischievous:  ["  /|--. ", " .-|/   ", " _/|\\   "],
  crazy:        ["~\\(|)/~", " /(|)\\  ", "~\\(|)/~"],
  angry:        [" =/|\\=  ", " [/|\\]  ", " =/|\\=  "],
  smug:         [" ._/|\\  ", " -/|--  ", " ._/|\\ "],
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
  crazy:        ["  </ \\> ", " ~/   \\~", " _/   \\_"],
  angry:        ["   / \\  ", "  _/ \\_ "],
  smug:         ["   / \\  "],
};

// Accessories — all entries must be 1-2 chars; padded to W_ACC in output
const ACCESSORIES: Record<KodiMood, string[]> = {
  idle:         [" ", " ", " ", " ", " ", " ", " ", "."],
  happy:        ["<3", "  ", "  "],
  excited:      ["! ", "! ", "* "],
  thinking:     ["? ", "  ", "  "],
  reasoning:    ["@ ", "@ ", "! "],
  working:      ["! ", "* ", "> "],
  worried:      ["  ", "! ", ". "],
  sleeping:     ["z ", "Z ", "zZ"],
  celebrating:  ["+ ", "* ", "! "],
  curious:      ["? ", "? ", "  "],
  mischievous:  ["  ", "~ ", "  "],
  crazy:        ["! ", "?!", "!!"],
  angry:        ["  ", "! ", "!!"],
  smug:         ["  ", "* ", "~ "],
};

// Effect particles
const EFFECTS_L: Record<AnimPhase, Record<AnimRhythm, string[]>> = {
  idle:         { slow: ["  ", "  ", " ."], medium: ["  ", "  "], fast: ["  "] },
  anticipation: { slow: [" >"], medium: [" >", " >"], fast: [" >", ">>"] },
  performing:   { slow: [" ."], medium: [" :", " ."], fast: [" !", " .", " :"] },
  settling:     { slow: [" .", "  "], medium: [" .", "  "], fast: [" .", "  "] },
  cooldown:     { slow: ["  ", "  "], medium: ["  "], fast: ["  "] },
};

const EFFECTS_R: Record<AnimPhase, Record<AnimRhythm, string[]>> = {
  idle:         { slow: ["  ", "  ", ". "], medium: ["  ", "  "], fast: ["  "] },
  anticipation: { slow: ["< "], medium: ["< ", "< "], fast: ["< ", "<<"] },
  performing:   { slow: [". "], medium: [": ", ". "], fast: ["! ", ". ", ": "] },
  settling:     { slow: [". ", "  "], medium: [". ", "  "], fast: [". ", "  "] },
  cooldown:     { slow: ["  ", "  "], medium: ["  "], fast: ["  "] },
};

// ─── Speech Chips ───────────────────────────────────────────────

export const SPEECH_CHIPS: Record<string, string[]> = {
  tool_start:    ["on it", "working", "sec...", "got it"],
  tool_done:     ["done!", "ok", "good", "ok!"],
  tool_error:    ["oops", "hmm", "uh oh", "retry?"],
  thinking:      ["hmm...", "thinking", "..."],
  reasoning:     ["deep...", "brain", "analyzing"],
  streaming:     ["writing", "...", "typing"],
  idle:          ["ready", "...", "~", ""],
  turn_end:      ["done!", "your turn", "ok"],
  compaction:    ["cleanup", "compacting"],
  agent_spawn:   ["team!", "+agent"],
  error:         ["broke!", "!!", "help"],
  commit:        ["saved!", "commit!"],
  test_pass:     ["green!", "tests ok", "ship it"],
  test_fail:     ["red!", "tests!", "bugs"],
};

// ─── Mood Rhythm ────────────────────────────────────────────────

const MOOD_RHYTHM: Record<KodiMood, AnimRhythm> = {
  idle: "slow", sleeping: "slow",
  thinking: "medium", curious: "medium", reasoning: "medium",
  happy: "medium", smug: "medium", mischievous: "medium",
  working: "fast", excited: "fast", celebrating: "fast", crazy: "fast",
  worried: "medium", angry: "fast",
};

// ─── Phase durations (ms, consumed by tick accumulator) ─────────

const PHASE_DURATION: Record<AnimPhase, number> = {
  idle: Infinity,         // stays until externally changed
  anticipation: 200,      // bridge mood display time
  performing: 800,        // main expression hold
  settling: 300,          // fade back
  cooldown: 400,          // quiet before idle
};

// ─── Transition Map ─────────────────────────────────────────────

const TRANSITIONS: Array<{ from: KodiMood[]; to: KodiMood[]; via: KodiMood; durationMs: number }> = [
  { from: ["idle", "happy"],         to: ["thinking", "reasoning"],  via: "curious",  durationMs: 200 },
  { from: ["thinking", "reasoning"], to: ["working"],                via: "curious",  durationMs: 150 },
  { from: ["working"],               to: ["celebrating", "happy"],   via: "excited",  durationMs: 200 },
  { from: ["idle", "happy"],         to: ["worried", "angry"],       via: "curious",  durationMs: 180 },
  { from: ["working", "thinking"],   to: ["worried"],                via: "worried",  durationMs: 120 },
];

function findTransition(from: KodiMood, to: KodiMood): { via: KodiMood; durationMs: number } | null {
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
  private bubbleTimer = 0;   // counts down

  // Context
  runningAgents = 0;
  contextPressure = 0;

  /** Advance engine by deltaMs. Pure — no setTimeout, no Date.now(). */
  tick(deltaMs: number): KodiAnimState {
    this.tickCount++;
    const rhythm = this.getEffectiveRhythm();

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
    const bodyIdx = (this.breathPhase + (this.phase === "performing" ? 1 : 0)) % bodyVariants.length;

    const legsVariants = LEGS[displayMood];
    const legsIdx = (this.phase === "performing" || this.phase === "anticipation")
      ? Math.min(1, legsVariants.length - 1) : 0;

    const accVariants = ACCESSORIES[displayMood];
    const accIdx = this.frameIndex % accVariants.length;

    const effectPhase = this.transitioning ? "anticipation" : this.phase;
    const effectsL = EFFECTS_L[effectPhase]?.[rhythm] ?? ["  "];
    const effectsR = EFFECTS_R[effectPhase]?.[rhythm] ?? ["  "];

    return {
      mood: displayMood,
      phase: this.transitioning ? "anticipation" : this.phase,
      face:      padFixed(` │ ${eyes[eyeIdx]} │`, W_FACE),
      body:      padFixed(bodyVariants[bodyIdx]!, W_BODY),
      legs:      padFixed(legsVariants[legsIdx]!, W_LEGS),
      effectL:   padFixed(effectsL[this.frameIndex % effectsL.length]!, W_EFFECT),
      effectR:   padFixed(effectsR[this.frameIndex % effectsR.length]!, W_EFFECT),
      accessory: padFixed(accVariants[accIdx]!, W_ACC),
      bubble: this.bubble,
      moodColor: displayMood,
      intensity: this.intensity,
    };
  }

  // ── Phase Machine ──

  private enterPhase(phase: AnimPhase): void {
    this.phase = phase;
    this.phaseTimer = PHASE_DURATION[phase];
  }

  private advancePhase(): void {
    switch (this.phase) {
      case "anticipation": this.enterPhase("performing"); break;
      case "performing":   this.enterPhase("settling"); break;
      case "settling":     this.enterPhase("cooldown"); break;
      case "cooldown":     this.enterPhase("idle"); break;
      case "idle":         break; // stays
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

  /** Show a speech chip for a duration (consumed via tick). */
  say(text: string, durationMs = 3000): void {
    this.bubble = text;
    this.bubbleTimer = durationMs;
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
        this.setMood("worried"); this.intensity = 0.8; this.say(chip, 3000); break;
      case "test_pass":
        this.setMood("celebrating"); this.intensity = 0.9; this.say("tests ok!", 3000); break;
      case "test_fail":
        this.setMood("angry"); this.intensity = 0.8; this.say("tests!", 3000); break;
      case "thinking":
        this.setMood("reasoning"); this.intensity = 0.6; this.say(chip, 4000); break;
      case "streaming":
        this.setMood("happy"); this.intensity = 0.5; this.say(chip, 2000); break;
      case "compaction":
        this.setMood("thinking"); this.intensity = 0.5; this.say(chip, 3000); break;
      case "agent_spawn":
        this.setMood("excited"); this.intensity = 0.8; this.say(chip, 3000); break;
      case "commit":
        this.setMood("celebrating"); this.intensity = 0.9; this.say("saved!", 3000); break;
      case "error":
        this.setMood("worried"); this.intensity = 0.7; this.say(chip, 3000); break;
      case "turn_end":
        this.setMood("idle"); this.intensity = 0.3; this.say(chip, 2000); break;
      case "idle":
        this.setMood("idle"); this.intensity = 0.2; break;
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
