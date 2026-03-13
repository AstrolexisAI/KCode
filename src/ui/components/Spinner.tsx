// KCode - Spinner component
// Animated loading indicator with token count and elapsed time

import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { useTheme } from "../ThemeContext.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL = 80;

interface SpinnerProps {
  message?: string;
  tokens?: number;
  startTime?: number;
}

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${rem.toString().padStart(2, "0")}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + "K";
  return Math.round(n / 1000) + "K";
}

export default function Spinner({ message, tokens, startTime }: SpinnerProps) {
  const { theme } = useTheme();
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
      if (startTime) setElapsed(Date.now() - startTime);
    }, INTERVAL);
    return () => clearInterval(timer);
  }, [startTime]);

  const parts: string[] = [];
  if (message) parts.push(message);

  const meta: string[] = [];
  if (tokens && tokens > 0) meta.push(formatTokens(tokens));
  if (startTime && elapsed > 0) meta.push(formatElapsed(elapsed));

  return (
    <Text color={theme.dimmed}>
      <Text color={theme.primary}>{SPINNER_FRAMES[frame]}</Text>
      {parts.length > 0 ? ` ${parts.join(" ")}` : ""}
      {meta.length > 0 && (
        <Text color={theme.dimmed}>{` ${meta.join(" · ")}`}</Text>
      )}
    </Text>
  );
}
