// KCode - Voice Session Orchestrator
// Coordinates VAD, ASR, TTS, and audio recording into a bidirectional voice conversation.

import { log } from "../logger";
import { StreamingASR } from "./streaming-asr";
import { LocalTTS } from "./tts";
import type { TranscriptEvent, VoiceSessionConfig, VoiceState } from "./types";
import { DEFAULT_VOICE_SESSION_CONFIG } from "./types";
import { VoiceActivityDetector } from "./vad";

// ─── Audio Recorder ────────────────────────────────────────────

export class AudioRecorder {
  private process: ReturnType<typeof Bun.spawn> | null = null;
  private running = false;

  /** Start recording from microphone. */
  start(onChunk: (data: Float32Array) => void, sampleRate = 16000): void {
    this.running = true;

    // Platform-specific recording command
    const cmd = this.getRecordCommand(sampleRate);
    this.process = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });

    this.readLoop(onChunk);
  }

  stop(): void {
    this.running = false;
    if (this.process) {
      try {
        this.process.kill();
      } catch {}
      this.process = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private async readLoop(onChunk: (data: Float32Array) => void): Promise<void> {
    if (!this.process?.stdout) return;

    const CHUNK_BYTES = 640; // 320 samples * 2 bytes = 20ms at 16kHz
    const reader = (this.process.stdout as ReadableStream).getReader();
    let buffer = new Uint8Array(0);

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        // Accumulate bytes
        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(new Uint8Array(value), buffer.length);
        buffer = newBuffer;

        // Process complete chunks
        while (buffer.length >= CHUNK_BYTES) {
          const chunk = buffer.slice(0, CHUNK_BYTES);
          buffer = buffer.slice(CHUNK_BYTES);

          // Convert Int16 to Float32
          const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
          const float32 = new Float32Array(int16.length);
          for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i]! / 32768;
          }

          onChunk(float32);
        }
      }
    } catch (err) {
      if (this.running) {
        log.debug("voice/recorder", `Read loop error: ${err}`);
      }
    }
  }

  private getRecordCommand(sampleRate: number): string[] {
    if (process.platform === "darwin") {
      // macOS: use sox/rec
      return [
        "rec",
        "-q",
        "-r",
        String(sampleRate),
        "-c",
        "1",
        "-b",
        "16",
        "-e",
        "signed-integer",
        "-t",
        "raw",
        "-",
      ];
    }
    // Linux: arecord
    return ["arecord", "-f", "S16_LE", "-r", String(sampleRate), "-c", "1", "-t", "raw", "-q"];
  }
}

// ─── Voice Session ─────────────────────────────────────────────

export class VoiceSession {
  private config: VoiceSessionConfig;
  private vad: VoiceActivityDetector;
  private asr: StreamingASR;
  private tts: LocalTTS;
  private recorder: AudioRecorder;
  private active = false;
  private state: VoiceState = "idle";
  private isListening = false;

  /** Callback: final transcript ready for the AI. */
  onTranscript: ((text: string, isFinal: boolean) => void) | null = null;
  /** Callback: voice state changed. */
  onStateChange: ((state: VoiceState) => void) | null = null;

  constructor(config?: Partial<VoiceSessionConfig>) {
    this.config = { ...DEFAULT_VOICE_SESSION_CONFIG, ...config };
    this.vad = new VoiceActivityDetector(this.config.vad, this.config.sampleRate);
    this.asr = new StreamingASR(this.config.asr);
    this.tts = new LocalTTS(this.config.tts);
    this.recorder = new AudioRecorder();
  }

  /** Start the full voice session pipeline. */
  async start(): Promise<void> {
    this.active = true;

    // 1. Calibrate VAD
    this.setState("calibrating");
    log.debug("voice/session", "Calibrating VAD...");

    await this.calibrateVAD();

    // 2. Start ASR
    await this.asr.start((event: TranscriptEvent) => {
      if (event.isFinal) {
        this.setState("processing");
      }
      this.onTranscript?.(event.text, event.isFinal);
    });

    // 3. Start recording and wire up pipeline
    this.setState("listening");
    this.recorder.start((audioChunk: Float32Array) => {
      const vadEvent = this.vad.process(audioChunk);

      if (vadEvent?.type === "speech-start") {
        this.isListening = true;
        this.setState("listening");
        // Interrupt TTS if speaking
        if (this.tts.isSpeaking()) {
          this.tts.stop();
        }
      }

      if (this.isListening) {
        this.asr.feedAudio(audioChunk);
      }

      if (vadEvent?.type === "speech-end") {
        this.isListening = false;
      }
    }, this.config.sampleRate);

    log.debug("voice/session", "Voice session started");
  }

  /** Stop the voice session. */
  stop(): void {
    this.active = false;
    this.recorder.stop();
    this.asr.stop();
    this.tts.stop();
    this.vad.reset();
    this.setState("idle");
    log.debug("voice/session", "Voice session stopped");
  }

  /** Speak a response via TTS. */
  async speak(text: string): Promise<void> {
    if (this.config.noTts) return;
    this.setState("speaking");
    await this.tts.speak(text);
    if (this.active) this.setState("listening");
  }

  /** Speak a streaming response via TTS. */
  async speakStream(textStream: AsyncIterable<string>): Promise<void> {
    if (this.config.noTts) return;
    this.setState("speaking");
    await this.tts.speakStream(textStream);
    if (this.active) this.setState("listening");
  }

  isActive(): boolean {
    return this.active;
  }

  getState(): VoiceState {
    return this.state;
  }

  // ─── Private ─────────────────────────────────────────────────

  private async calibrateVAD(): Promise<void> {
    return new Promise<void>((resolve) => {
      const calibrationMs = this.config.vad.calibrationDuration;
      let elapsed = 0;
      const frameDuration = 20; // 20ms per chunk at 16kHz/320 samples

      // Record briefly for calibration
      const calibRecorder = new AudioRecorder();
      calibRecorder.start((chunk) => {
        this.vad.calibrate(chunk);
        elapsed += frameDuration;
        if (elapsed >= calibrationMs) {
          calibRecorder.stop();
          log.debug(
            "voice/session",
            `VAD calibrated: baseline=${this.vad.getBaseline().toFixed(4)}, threshold=${this.vad.getThreshold().toFixed(4)}`,
          );
          resolve();
        }
      }, this.config.sampleRate);
    });
  }

  private setState(newState: VoiceState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.onStateChange?.(newState);
    }
  }
}
