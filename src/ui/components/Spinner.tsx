// KCode - Spinner component
// Animated loading indicator with phase detection, token speed, and elapsed time

import { Text } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { useTheme } from "../ThemeContext.js";

// Different spinner styles for different phases
const SPINNERS = {
  thinking: ["🧠⣀", "🧠⣤", "🧠⣶", "🧠⣿", "🧠⣶", "🧠⣤"], // brain pulse — model is reasoning
  streaming: ["▁", "▃", "▅", "▇", "▅", "▃"], // wave — tokens flowing
  tool: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"], // matrix — executing tool
};

const INTERVAL = 100;

type SpinnerPhase = "thinking" | "streaming" | "tool";

interface SpinnerProps {
  message?: string;
  tokens?: number;
  startTime?: number;
  phase?: SpinnerPhase;
}

export function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${rem.toString().padStart(2, "0")}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n} tok`;
  if (n < 10_000) return (n / 1000).toFixed(1) + "K tok";
  return Math.round(n / 1000) + "K tok";
}

export function formatSpeed(tokPerSec: number): string {
  if (tokPerSec < 1) return "<1 t/s";
  if (tokPerSec < 10) return tokPerSec.toFixed(1) + " t/s";
  return Math.round(tokPerSec) + " t/s";
}

export default function Spinner({ message, tokens, startTime, phase = "thinking" }: SpinnerProps) {
  const { theme } = useTheme();
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const prevTokensRef = useRef(0);
  const prevTimeRef = useRef(Date.now());
  const speedRef = useRef(0);

  const frames = SPINNERS[phase] ?? SPINNERS.thinking;

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % frames.length);
      if (startTime) setElapsed(Date.now() - startTime);

      // Calculate tokens/s using a rolling window
      const now = Date.now();
      const currentTokens = tokens ?? 0;
      const dt = (now - prevTimeRef.current) / 1000;
      if (dt >= 0.5 && currentTokens > prevTokensRef.current) {
        const newSpeed = (currentTokens - prevTokensRef.current) / dt;
        // Smooth: weighted average with previous speed
        speedRef.current =
          speedRef.current > 0 ? speedRef.current * 0.3 + newSpeed * 0.7 : newSpeed;
        prevTokensRef.current = currentTokens;
        prevTimeRef.current = now;
      }
    }, INTERVAL);
    return () => clearInterval(timer);
  }, [startTime, frames.length, tokens]);

  // Reset speed tracking when tokens reset (new turn)
  useEffect(() => {
    if (!tokens || tokens === 0) {
      prevTokensRef.current = 0;
      prevTimeRef.current = Date.now();
      speedRef.current = 0;
    }
  }, [tokens === 0]);

  // Build display parts
  const meta: string[] = [];
  if (tokens && tokens > 0) meta.push(formatTokens(tokens));
  if (speedRef.current > 0 && phase === "streaming") meta.push(formatSpeed(speedRef.current));
  if (startTime && elapsed > 0) meta.push(formatElapsed(elapsed));

  // Spinner color based on phase
  const spinnerColor =
    phase === "thinking"
      ? theme.accent
      : phase === "streaming"
        ? theme.success
        : phase === "tool"
          ? theme.warning
          : theme.primary;

  return (
    <Text color={theme.dimmed}>
      <Text color={spinnerColor}>{frames[frame % frames.length]}</Text>
      {message ? ` ${message}` : ""}
      {meta.length > 0 && <Text color={theme.dimmed}>{` ${meta.join(" · ")}`}</Text>}
    </Text>
  );
}
