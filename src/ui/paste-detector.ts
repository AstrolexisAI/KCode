// KCode - Paste detection for terminal input
// Distinguishes pasted text (many rapid characters) from fast typing
// by requiring a minimum burst length before activating paste mode.

export interface PasteDetectorOptions {
  /** Max ms between keystrokes to count as rapid input (default: 50) */
  detectMs?: number;
  /** Ms of idle before paste mode expires (default: 100) */
  settleMs?: number;
  /** Minimum rapid consecutive inputs to activate paste mode (default: 5) */
  burstThreshold?: number;
  /** Clock function for testing (default: Date.now) */
  now?: () => number;
}

export class PasteDetector {
  private lastInputTime = 0;
  private burstCount = 0;
  private _active = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly detectMs: number;
  private readonly settleMs: number;
  private readonly burstThreshold: number;
  private readonly now: () => number;

  constructor(opts: PasteDetectorOptions = {}) {
    this.detectMs = opts.detectMs ?? 50;
    this.settleMs = opts.settleMs ?? 100;
    this.burstThreshold = opts.burstThreshold ?? 5;
    this.now = opts.now ?? Date.now;
  }

  /** Whether paste mode is currently active. */
  get isActive(): boolean {
    return this._active;
  }

  /**
   * Record a character input event.
   * Call this on every non-control character keystroke.
   */
  recordInput(): void {
    const now = this.now();
    const elapsed = now - this.lastInputTime;
    this.lastInputTime = now;

    if (elapsed > 0 && elapsed < this.detectMs) {
      this.burstCount++;
      if (this.burstCount >= this.burstThreshold) {
        this._active = true;
      }
    } else {
      this.burstCount = 0;
    }

    if (this._active) this.resetSettleTimer();
  }

  /**
   * Check whether Enter should insert a newline (paste active) or submit.
   * Enter does NOT count toward the burst — it's a control action, not content.
   * Only returns true if paste was already activated by prior character input.
   */
  shouldInsertNewline(): boolean {
    if (this._active) {
      this.lastInputTime = this.now();
      this.resetSettleTimer();
      return true;
    }
    return false;
  }

  /** Reset all state. Call on submit or when clearing input. */
  reset(): void {
    this._active = false;
    this.burstCount = 0;
    this.lastInputTime = 0;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  /** Alias for reset — call on component unmount. */
  dispose(): void {
    this.reset();
  }

  private resetSettleTimer(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this._active = false;
      this.burstCount = 0;
    }, this.settleMs);
  }
}
