// KCode - Streaming Automatic Speech Recognition
// Supports multiple backends: faster-whisper, whisper.cpp, and chunked mode.

import { log } from "../logger";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import type { ASRConfig, TranscriptEvent } from "./types";
import { DEFAULT_ASR_CONFIG } from "./types";

export class StreamingASR {
  private config: ASRConfig;
  private process: ReturnType<typeof Bun.spawn> | null = null;
  private running = false;
  private chunkBuffer: Int16Array[] = [];
  private chunkTimer: ReturnType<typeof setInterval> | null = null;
  private onTranscript: ((event: TranscriptEvent) => void) | null = null;

  constructor(config?: Partial<ASRConfig>) {
    this.config = { ...DEFAULT_ASR_CONFIG, ...config };
  }

  /** Start the ASR engine. */
  async start(onTranscript: (event: TranscriptEvent) => void): Promise<void> {
    this.onTranscript = onTranscript;
    this.running = true;

    switch (this.config.backend) {
      case "faster-whisper-stream":
        await this.startFasterWhisper();
        break;
      case "whisper-cpp-stream":
        await this.startWhisperCpp();
        break;
      case "chunked":
        this.startChunked();
        break;
    }
  }

  /** Feed raw PCM audio data (Float32 from microphone). */
  feedAudio(pcmData: Float32Array): void {
    const int16 = this.float32ToInt16(pcmData);

    if (this.config.backend === "chunked") {
      this.chunkBuffer.push(int16);
    } else if (this.process?.stdin) {
      try {
        const writer = this.process.stdin as unknown as WritableStream;
        const writable = writer.getWriter?.();
        if (writable) {
          writable.write(new Uint8Array(int16.buffer)).catch(() => {});
          writable.releaseLock();
        }
      } catch (err) {
        log.debug("asr", `feedAudio write error: ${err}`);
      }
    }
  }

  /** Stop the ASR engine. */
  stop(): void {
    this.running = false;
    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
    }
    this.chunkBuffer = [];
    this.onTranscript = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── Backends ────────────────────────────────────────────────

  private async startFasterWhisper(): Promise<void> {
    this.process = Bun.spawn(
      ["faster-whisper", "--model", this.config.model, "--live", "--vad_filter", "--language", this.config.language],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );

    this.readStdout();
  }

  private async startWhisperCpp(): Promise<void> {
    this.process = Bun.spawn(
      ["whisper-cpp", "--stream", "--model", this.config.model, "--language", this.config.language],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );

    this.readStdout();
  }

  private startChunked(): void {
    // Periodically transcribe accumulated audio chunks
    this.chunkTimer = setInterval(async () => {
      if (this.chunkBuffer.length === 0) return;

      const allChunks = this.chunkBuffer;
      this.chunkBuffer = [];

      const totalLength = allChunks.reduce((s, c) => s + c.length, 0);
      const combined = new Int16Array(totalLength);
      let offset = 0;
      for (const chunk of allChunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      const text = await this.transcribeChunk(combined);
      if (text.trim() && this.onTranscript) {
        this.onTranscript({
          text: text.trim(),
          isFinal: true,
          timestamp: Date.now(),
        });
      }
    }, this.config.chunkDuration);
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private async readStdout(): Promise<void> {
    if (!this.process?.stdout) return;

    try {
      const reader = (this.process.stdout as ReadableStream).getReader();
      const decoder = new TextDecoder();

      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        const isFinal = text.includes("\n");

        if (this.onTranscript && text.trim()) {
          this.onTranscript({
            text: text.trim(),
            isFinal,
            timestamp: Date.now(),
          });
        }
      }
    } catch (err) {
      if (this.running) {
        log.debug("asr", `stdout read error: ${err}`);
      }
    }
  }

  /** Transcribe a chunk by writing to a temp WAV file and running whisper. */
  private async transcribeChunk(pcm: Int16Array): Promise<string> {
    const tempPath = join(tmpdir(), `kcode-asr-${Date.now()}.wav`);
    try {
      // Write minimal WAV header + PCM data
      const wavData = this.createWav(pcm, 16000, 1);
      writeFileSync(tempPath, Buffer.from(wavData));

      const proc = Bun.spawn(
        ["whisper", "--model", this.config.model, "--language", this.config.language, "--output-txt", tempPath],
        { stdout: "pipe", stderr: "pipe" },
      );
      await proc.exited;
      const output = await new Response(proc.stdout).text();
      return output.trim();
    } catch (err) {
      log.debug("asr", `transcribeChunk error: ${err}`);
      return "";
    } finally {
      try { unlinkSync(tempPath); } catch {}
      try { unlinkSync(tempPath.replace(".wav", ".txt")); } catch {}
    }
  }

  /** Convert Float32 audio to Int16 PCM. */
  float32ToInt16(data: Float32Array): Int16Array {
    const out = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
      out[i] = Math.max(-32768, Math.min(32767, Math.round(data[i]! * 32768)));
    }
    return out;
  }

  /** Create a minimal WAV file buffer. */
  private createWav(pcm: Int16Array, sampleRate: number, channels: number): ArrayBuffer {
    const dataSize = pcm.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF header
    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    this.writeString(view, 8, "WAVE");

    // fmt chunk
    this.writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);             // chunk size
    view.setUint16(20, 1, true);              // PCM format
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true); // byte rate
    view.setUint16(32, channels * 2, true);   // block align
    view.setUint16(34, 16, true);             // bits per sample

    // data chunk
    this.writeString(view, 36, "data");
    view.setUint32(40, dataSize, true);

    // PCM data
    const dataView = new Int16Array(buffer, 44);
    dataView.set(pcm);

    return buffer;
  }

  private writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }
}
