// KCode - PermissionDialog component
// Prompts the user for tool execution permission

import React from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../ThemeContext.js";

export interface PermissionRequest {
  toolName: string;
  description: string;
}

export type PermissionChoice = "allow" | "allow_always" | "deny";

interface PermissionDialogProps {
  request: PermissionRequest;
  onChoice: (choice: PermissionChoice) => void;
  isActive: boolean;
}

export default function PermissionDialog({
  request,
  onChoice,
  isActive,
}: PermissionDialogProps) {
  const { theme } = useTheme();

  useInput(
    (input, _key) => {
      if (!isActive) return;

      switch (input.toLowerCase()) {
        case "y":
          onChoice("allow");
          break;
        case "a":
          onChoice("allow_always");
          break;
        case "n":
          onChoice("deny");
          break;
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
        {"⚠  Permission Required"}
      </Text>
      <Box marginTop={1}>
        <Text>
          Tool: <Text bold color={theme.primary}>{request.toolName}</Text>
        </Text>
      </Box>
      <Box>
        <Text>
          Action: <Text bold>{request.description}</Text>
        </Text>
      </Box>
      <Box marginTop={1} gap={2}>
        <Text>
          <Text bold color={theme.success}>[y]</Text>
          <Text> Allow</Text>
        </Text>
        <Text>
          <Text bold color={theme.primary}>[a]</Text>
          <Text> Always</Text>
        </Text>
        <Text>
          <Text bold color={theme.error}>[n]</Text>
          <Text> Deny</Text>
        </Text>
      </Box>
    </Box>
  );
}
