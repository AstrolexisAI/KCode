// KCode - SudoPasswordPrompt component
// Prompts the user for their sudo password with masked input

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { useTheme } from "../ThemeContext.js";

interface SudoPasswordPromptProps {
  onSubmit: (password: string | null) => void;
  isActive: boolean;
}

export default function SudoPasswordPrompt({ onSubmit, isActive }: SudoPasswordPromptProps) {
  const { theme } = useTheme();
  const [password, setPassword] = useState("");

  useInput(
    (input, key) => {
      if (!isActive) return;

      if (key.escape) {
        setPassword(""); // Clear password on cancel
        onSubmit(null);
        return;
      }

      if (key.return) {
        if (password.length > 0) {
          const pw = password;
          setPassword(""); // Clear password from component state immediately
          onSubmit(pw);
        }
        return;
      }

      if (key.backspace || key.delete) {
        setPassword((prev) => prev.slice(0, -1));
        return;
      }

      // Only accept printable characters
      if (input && !key.ctrl && !key.meta) {
        setPassword((prev) => prev + input);
      }
    },
    { isActive },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={theme.warning}>
        {"🔒  Sudo Password Required"}
      </Text>
      <Box marginTop={1}>
        <Text dimColor>
          A command requires elevated privileges. Enter your password to continue.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          Password:{" "}
          <Text bold color={theme.primary}>
            {"•".repeat(password.length)}
          </Text>
          <Text color={theme.accent}>{"█"}</Text>
        </Text>
      </Box>
      <Box marginTop={1} gap={2}>
        <Text>
          <Text bold color={theme.success}>
            [Enter]
          </Text>
          <Text> Submit</Text>
        </Text>
        <Text>
          <Text bold color={theme.error}>
            [Esc]
          </Text>
          <Text> Cancel</Text>
        </Text>
      </Box>
    </Box>
  );
}
