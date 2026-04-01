// KCode - Local Text-to-Speech
// Supports Piper, espeak-ng, and macOS say.

import { log } from "../logger";
import type { TTSConfig } from "./types";
import { DEFAULT_TTS_CONFIG } from "./types";

export class LocalTTS {
  private config: TTSConfig;
  private currentProcess: ReturnType<typeof Bun.spawn> | null = null;

  constructor(config?: Partial<TTSConfig>) {
    this.config = { ...DEFAULT_TTS_CONFIG, ...config };
  }

  /** Speak a complete text string. */
  async speak(text: string): Promise<void> {
    if (!text.trim()) return;

    switch (this.config.backend) {
      case "piper": {
        const piper = Bun.spawn(["piper", "--model", this.config.voice, "--output-raw"], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        const playCmd = this.getPlayCommand();
        const player = Bun.spawn(playCmd, { stdin: piper.stdout, stderr: "pipe" });
        this.currentProcess = player;

        const writer = (piper.stdin as unknown as WritableStream).getWriter();
        await writer.write(new TextEncoder().encode(text));
        await writer.close();

        await player.exited;
        this.currentProcess = null;
        break;
      }

      case "espeak": {
        const proc = Bun.spawn(["espeak-ng", "-v", this.config.language, text], { stderr: "pipe" });
        this.currentProcess = proc;
        await proc.exited;
        this.currentProcess = null;
        break;
      }

      case "say": {
        const proc = Bun.spawn(["say", "-v", this.config.voice, text], { stderr: "pipe" });
        this.currentProcess = proc;
        await proc.exited;
        this.currentProcess = null;
        break;
      }
    }
  }

  /** Speak text as it streams in, sentence by sentence. */
  async speakStream(textStream: AsyncIterable<string>): Promise<void> {
    let buffer = "";

    for await (const chunk of textStream) {
      buffer += chunk;
      const result = this.splitSentences(buffer);

      for (const sentence of result.complete) {
        await this.speak(sentence);
      }
      buffer = result.remaining;
    }

    // Speak remaining text
    if (buffer.trim()) {
      await this.speak(buffer.trim());
    }
  }

  /** Stop any currently playing audio. */
  stop(): void {
    if (this.currentProcess) {
      try {
        this.currentProcess.kill();
      } catch { /* cleanup — ignore failures */ }
      this.currentProcess = null;
    }
  }

  /** Check if the TTS backend binary is available. */
  async isAvailable(): Promise<boolean> {
    const binary = this.getBinaryName();
    try {
      const proc = Bun.spawn(["which", binary], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  isSpeaking(): boolean {
    return this.currentProcess !== null;
  }

  /**
   * Split text into complete sentences and remaining buffer.
   * Sentences end with . ! or ? followed by whitespace or end of string.
   */
  splitSentences(text: string): { complete: string[]; remaining: string } {
    const sentences: string[] = [];
    const regex = /[^.!?]*[.!?]+\s*/g;
    let match;
    let lastIndex = 0;

    while ((match = regex.exec(text)) !== null) {
      const sentence = match[0].trim();
      if (sentence) sentences.push(sentence);
      lastIndex = regex.lastIndex;
    }

    return {
      complete: sentences,
      remaining: text.slice(lastIndex),
    };
  }

  // ─── Private helpers ─────────────────────────────────────────

  private getBinaryName(): string {
    switch (this.config.backend) {
      case "piper":
        return "piper";
      case "espeak":
        return "espeak-ng";
      case "say":
        return "say";
    }
  }

  private getPlayCommand(): string[] {
    if (process.platform === "darwin") {
      return ["afplay", "-"];
    }
    // Linux: aplay for raw PCM from piper
    return ["aplay", "-r", "22050", "-f", "S16_LE", "-t", "raw", "-q"];
  }
}
