// KCode - Advanced Voice Mode Types

export interface VADConfig {
  energyThreshold: number;
  silenceDuration: number;      // ms
  speechDuration: number;       // ms
  calibrationDuration: number;  // ms
  sensitivity: "low" | "medium" | "high";
}

export interface VADEvent {
  type: "speech-start" | "speech-end" | "calibrated";
  timestamp: number;
  energy?: number;
}

export type ASRBackend = "faster-whisper-stream" | "whisper-cpp-stream" | "chunked";
export type TTSBackend = "piper" | "espeak" | "say";

export interface ASRConfig {
  backend: ASRBackend;
  model: string;
  language: string;
  chunkDuration: number; // ms
}

export interface TTSConfig {
  backend: TTSBackend;
  voice: string;
  language: string;
  speed: number;
}

export interface VoiceSessionConfig {
  vad: VADConfig;
  asr: ASRConfig;
  tts: TTSConfig;
  noTts: boolean;
  sampleRate: number;
  channels: number;
}

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  timestamp: number;
  confidence?: number;
}

export type VoiceState = "idle" | "calibrating" | "listening" | "processing" | "speaking";

export const DEFAULT_VAD_CONFIG: VADConfig = {
  energyThreshold: 0.02,
  silenceDuration: 1500,
  speechDuration: 300,
  calibrationDuration: 2000,
  sensitivity: "medium",
};

export const DEFAULT_ASR_CONFIG: ASRConfig = {
  backend: "chunked",
  model: "small",
  language: "en",
  chunkDuration: 3000,
};

export const DEFAULT_TTS_CONFIG: TTSConfig = {
  backend: "piper",
  voice: "en_US-lessac-medium",
  language: "en",
  speed: 1.0,
};

export const DEFAULT_VOICE_SESSION_CONFIG: VoiceSessionConfig = {
  vad: DEFAULT_VAD_CONFIG,
  asr: DEFAULT_ASR_CONFIG,
  tts: DEFAULT_TTS_CONFIG,
  noTts: false,
  sampleRate: 16000,
  channels: 1,
};
