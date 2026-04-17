// KCode - Voice Input (STT)
//
// STATUS: Auxiliary (see docs/architecture/modules.md).
// Skeletal — speech-to-text workflow for accessibility / hands-
// free use. Not required by the audit engine. Safe to disable.
//
// Provides speech-to-text input for KCode using:
// 1. Kulvex voice pipeline (localhost:9100) if available
// 2. Local faster-whisper / whisper.cpp if installed
// 3. Falls back to error with installation instructions

import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./logger";

// ─── Constants ───────────────────────────────────────────────────

const KULVEX_API_BASE = process.env.KULVEX_API_BASE ?? "http://localhost:9100";
const RECORDING_DURATION_SEC = 10; // Max recording time
const SAMPLE_RATE = 16000;

// ─── Detection ──────────────────────────────────────────────────

interface VoiceBackend {
  name: string;
  available: boolean;
}

function detectBackends(): VoiceBackend[] {
  const backends: VoiceBackend[] = [];

  // Check Kulvex voice API
  // (async check deferred to runtime)
  backends.push({ name: "kulvex", available: false });

  // Check faster-whisper
  try {
    execSync("which faster-whisper 2>/dev/null || python3 -c 'import faster_whisper' 2>/dev/null", {
      stdio: "pipe",
      timeout: 3000,
    });
    backends.push({ name: "faster-whisper", available: true });
  } catch (err) {
    log.debug("voice", `faster-whisper not available: ${err}`);
    backends.push({ name: "faster-whisper", available: false });
  }

  // Check whisper.cpp
  try {
    execSync("which whisper-cpp 2>/dev/null || which main 2>/dev/null", {
      stdio: "pipe",
      timeout: 3000,
    });
    backends.push({ name: "whisper-cpp", available: true });
  } catch (err) {
    log.debug("voice", `whisper-cpp not available: ${err}`);
    backends.push({ name: "whisper-cpp", available: false });
  }

  // Check arecord (ALSA) for microphone access
  try {
    execSync("which arecord 2>/dev/null || which sox 2>/dev/null", {
      stdio: "pipe",
      timeout: 3000,
    });
  } catch (err) {
    log.debug("voice", `No audio recording tool (arecord/sox) found: ${err}`);
  }

  return backends;
}

// ─── Recording ──────────────────────────────────────────────────

function recordAudio(durationSec: number): string {
  const outPath = join(tmpdir(), `kcode-voice-${Date.now()}.wav`);

  // Try arecord first (ALSA), then sox
  try {
    execSync(
      `arecord -f S16_LE -r ${SAMPLE_RATE} -c 1 -d ${durationSec} "${outPath}" 2>/dev/null`,
      { stdio: "pipe", timeout: (durationSec + 2) * 1000 },
    );
    return outPath;
  } catch (err) {
    log.debug("voice", `arecord not available: ${err}`);
  }

  try {
    execSync(`sox -d -r ${SAMPLE_RATE} -c 1 -b 16 "${outPath}" trim 0 ${durationSec} 2>/dev/null`, {
      stdio: "pipe",
      timeout: (durationSec + 2) * 1000,
    });
    return outPath;
  } catch (err) {
    log.debug("voice", `sox not available: ${err}`);
  }

  throw new Error("No audio recording tool found. Install alsa-utils (arecord) or sox.");
}

// ─── Transcription Backends ─────────────────────────────────────

async function transcribeViaKulvex(audioPath: string): Promise<string> {
  const audioData = await Bun.file(audioPath).arrayBuffer();
  const formData = new FormData();
  formData.append("file", new Blob([audioData], { type: "audio/wav" }), "audio.wav");

  const resp = await fetch(`${KULVEX_API_BASE}/api/voice/transcribe`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Kulvex STT failed: ${resp.status}`);
  }

  const data = (await resp.json()) as { text?: string; transcript?: string };
  return data.text ?? data.transcript ?? "";
}

function transcribeViaFasterWhisper(audioPath: string): string {
  const result = execSync(
    `python3 -c "
from faster_whisper import WhisperModel
model = WhisperModel('base', device='cuda', compute_type='float16')
segments, _ = model.transcribe('${audioPath}')
print(' '.join(s.text for s in segments))
" 2>/dev/null`,
    { stdio: "pipe", timeout: 30_000 },
  )
    .toString()
    .trim();

  return result;
}

function transcribeViaWhisperCpp(audioPath: string): string {
  // Find whisper.cpp binary
  const whisperBin = ["whisper-cpp", "main"].find((bin) => {
    try {
      execSync(`which ${bin}`, { stdio: "pipe" });
      return true;
    } catch (err) {
      log.debug("voice", `whisper binary '${bin}' not found: ${err}`);
      return false;
    }
  });

  if (!whisperBin) throw new Error("whisper.cpp binary not found");

  // Find model file
  const modelPaths = [
    join(process.env.HOME ?? "/root", ".cache", "whisper.cpp", "ggml-base.bin"),
    "/usr/local/share/whisper.cpp/ggml-base.bin",
  ];
  const modelPath = modelPaths.find(existsSync);

  if (!modelPath) {
    throw new Error("Whisper model not found. Download ggml-base.bin to ~/.cache/whisper.cpp/");
  }

  const result = execSync(
    `${whisperBin} -m "${modelPath}" -f "${audioPath}" --no-timestamps -nt 2>/dev/null`,
    { stdio: "pipe", timeout: 30_000 },
  )
    .toString()
    .trim();

  return result;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Record audio from the microphone and transcribe it to text.
 * Returns the transcribed text.
 */
export async function voiceToText(durationSec?: number): Promise<string> {
  const duration = durationSec ?? RECORDING_DURATION_SEC;

  // Record audio
  process.stderr.write("\x1b[36m🎤 Listening...\x1b[0m ");
  let audioPath: string;
  try {
    audioPath = recordAudio(duration);
  } catch (err) {
    throw new Error(`Recording failed: ${err instanceof Error ? err.message : err}`);
  }
  process.stderr.write("\x1b[2mTranscribing...\x1b[0m\n");

  try {
    // Try backends in order of preference

    // 1. Kulvex voice API (skip if offline)
    let skipKulvex = false;
    try {
      const { getOfflineMode } = await import("./offline/mode");
      if (getOfflineMode().isActive()) {
        skipKulvex = true;
        log.debug("voice", "Offline mode: skipping Kulvex voice API, using local whisper");
      }
    } catch {
      /* offline module not loaded */
    }

    if (!skipKulvex) {
      try {
        const resp = await fetch(`${KULVEX_API_BASE}/api/monitoring/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (resp.ok) {
          const text = await transcribeViaKulvex(audioPath);
          log.info("voice", `Transcribed via Kulvex: ${text.slice(0, 50)}`);
          return text;
        }
      } catch (err) {
        log.debug("voice", `Kulvex voice API not available: ${err}`);
      }
    }

    // 2. faster-whisper (Python, CUDA-accelerated)
    try {
      const text = transcribeViaFasterWhisper(audioPath);
      if (text) {
        log.info("voice", `Transcribed via faster-whisper: ${text.slice(0, 50)}`);
        return text;
      }
    } catch (err) {
      log.debug("voice", `faster-whisper transcription failed: ${err}`);
    }

    // 3. whisper.cpp
    try {
      const text = transcribeViaWhisperCpp(audioPath);
      if (text) {
        log.info("voice", `Transcribed via whisper.cpp: ${text.slice(0, 50)}`);
        return text;
      }
    } catch (err) {
      log.debug("voice", `whisper.cpp transcription failed: ${err}`);
    }

    throw new Error(
      "No STT backend available. Install one of:\n" +
        "  pip install faster-whisper (recommended, uses GPU)\n" +
        "  Or ensure Kulvex API is running at localhost:9100",
    );
  } finally {
    // Cleanup audio file
    try {
      unlinkSync(audioPath);
    } catch (err) {
      log.debug("voice", `Failed to clean up audio file: ${err}`);
    }
  }
}

/**
 * Check if voice input is available on this system.
 */
export function isVoiceAvailable(): {
  available: boolean;
  backends: VoiceBackend[];
  recording: boolean;
} {
  const backends = detectBackends();
  let recording = false;
  try {
    execSync("which arecord 2>/dev/null || which sox 2>/dev/null", {
      stdio: "pipe",
      timeout: 2000,
    });
    recording = true;
  } catch (err) {
    log.debug("voice", `No recording tool available: ${err}`);
  }

  return {
    available: recording && backends.some((b) => b.available),
    backends,
    recording,
  };
}
