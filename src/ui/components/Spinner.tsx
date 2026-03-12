// KCode - Spinner component
// Animated loading indicator for API calls and tool execution

import React, { useState, useEffect } from "react";
import { Text } from "ink";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL = 80;

interface SpinnerProps {
  message?: string;
}

export default function Spinner({ message }: SpinnerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, INTERVAL);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text dimColor>
      <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>
      {message ? ` ${message}` : ""}
    </Text>
  );
}
