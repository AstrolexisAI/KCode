// KCode - Voice Activity Detection
// Detects speech start/end using RMS energy analysis with adaptive threshold.

import { log } from "../logger";
import type { VADConfig, VADEvent } from "./types";
import { DEFAULT_VAD_CONFIG } from "./types";

const SENSITIVITY_MULTIPLIERS: Record<string, number> = {
  low: 5,
  medium: 3,
  high: 2,
};

export class VoiceActivityDetector {
  private config: VADConfig;
  private baseline = 0;
  private calibrationSamples: number[] = [];
  private calibrated = false;
  private state: "silence" | "speech" = "silence";
  private speechFrames = 0;
  private silenceFrames = 0;

  // Frame thresholds (computed from config + sample rate)
  private minSpeechFrames: number;
  private minSilenceFrames: number;

  constructor(config?: Partial<VADConfig>, sampleRate = 16000, chunkSamples = 320) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
    const frameDurationMs = (chunkSamples / sampleRate) * 1000; // ~20ms per frame
    this.minSpeechFrames = Math.max(1, Math.ceil(this.config.speechDuration / frameDurationMs));
    this.minSilenceFrames = Math.max(1, Math.ceil(this.config.silenceDuration / frameDurationMs));
  }

  /** Feed ambient noise for calibration. */
  calibrate(audioChunk: Float32Array): void {
    const rms = this.calculateRMS(audioChunk);
    this.calibrationSamples.push(rms);

    // Update running average baseline
    const sum = this.calibrationSamples.reduce((a, b) => a + b, 0);
    this.baseline = sum / this.calibrationSamples.length;

    // Set threshold based on sensitivity
    const multiplier = SENSITIVITY_MULTIPLIERS[this.config.sensitivity] ?? 3;
    this.config.energyThreshold = this.baseline * multiplier;
    this.calibrated = true;
  }

  /** Process an audio chunk and return a VAD event if state changes. */
  process(audioChunk: Float32Array): VADEvent | null {
    const rms = this.calculateRMS(audioChunk);

    if (rms > this.config.energyThreshold) {
      // Voice detected
      this.speechFrames++;
      this.silenceFrames = 0;

      if (this.speechFrames >= this.minSpeechFrames && this.state === "silence") {
        this.state = "speech";
        log.debug("vad", `Speech start (RMS=${rms.toFixed(4)}, threshold=${this.config.energyThreshold.toFixed(4)})`);
        return { type: "speech-start", timestamp: Date.now(), energy: rms };
      }
    } else {
      // Silence
      this.silenceFrames++;

      if (this.silenceFrames >= this.minSilenceFrames && this.state === "speech") {
        this.state = "silence";
        this.speechFrames = 0;
        log.debug("vad", `Speech end (silence frames=${this.silenceFrames})`);
        return { type: "speech-end", timestamp: Date.now(), energy: rms };
      }
    }

    return null;
  }

  /** Reset state without clearing calibration. */
  reset(): void {
    this.state = "silence";
    this.speechFrames = 0;
    this.silenceFrames = 0;
  }

  /** Full reset including calibration. */
  fullReset(): void {
    this.reset();
    this.calibrated = false;
    this.calibrationSamples = [];
    this.baseline = 0;
    this.config.energyThreshold = DEFAULT_VAD_CONFIG.energyThreshold;
  }

  isCalibrated(): boolean {
    return this.calibrated;
  }

  getThreshold(): number {
    return this.config.energyThreshold;
  }

  getBaseline(): number {
    return this.baseline;
  }

  getCurrentState(): "silence" | "speech" {
    return this.state;
  }

  /** Calculate Root Mean Square of audio samples. */
  calculateRMS(data: Float32Array): number {
    if (data.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i]! * data[i]!;
    }
    return Math.sqrt(sum / data.length);
  }
}
