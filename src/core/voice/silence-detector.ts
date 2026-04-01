// KCode - Silence Detector
// Tracks audio levels and detects sustained silence for voice input auto-stop.

// ─── Types ─────────────────────────────────────────────────────

export interface SilenceDetectorConfig {
  /** Duration of silence (in ms) before detection triggers. Default: 2000 */
  thresholdMs: number;
  /** Audio level below this value is considered silence. Default: 0.01 */
  silenceLevel: number;
}

const DEFAULT_CONFIG: SilenceDetectorConfig = {
  thresholdMs: 2000,
  silenceLevel: 0.01,
};

// ─── Silence Detector ──────────────────────────────────────────

export class SilenceDetector {
  private config: SilenceDetectorConfig;
  private silenceStartMs: number | null = null;

  constructor(config?: Partial<SilenceDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Feed an audio level sample.
   * @param level - Current audio level (RMS energy, typically 0.0 to 1.0)
   * @returns true if silence has been sustained for the configured threshold duration
   */
  feed(level: number): boolean {
    const now = Date.now();

    if (level < this.config.silenceLevel) {
      // Below silence threshold
      if (this.silenceStartMs === null) {
        this.silenceStartMs = now;
      }
      return now - this.silenceStartMs >= this.config.thresholdMs;
    }

    // Noise detected — reset the timer
    this.silenceStartMs = null;
    return false;
  }

  /** Reset the detector state. */
  reset(): void {
    this.silenceStartMs = null;
  }

  /** Get the current silence duration in ms, or 0 if not silent. */
  getSilenceDuration(): number {
    if (this.silenceStartMs === null) return 0;
    return Date.now() - this.silenceStartMs;
  }

  /** Get the configured threshold in ms. */
  getThresholdMs(): number {
    return this.config.thresholdMs;
  }
}
