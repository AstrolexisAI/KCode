// KCode - PermissionDialog component
// Prompts the user for tool execution permission

import React from "react";
import { Box, Text, useInput } from "ink";

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
      borderColor="yellow"
      paddingX={1}
      marginY={1}
    >
      <Text bold color="yellow">
        {"⚠  Permission Required"}
      </Text>
      <Box marginTop={1}>
        <Text>
          Tool: <Text bold color="cyan">{request.toolName}</Text>
        </Text>
      </Box>
      <Box>
        <Text>
          Action: <Text bold>{request.description}</Text>
        </Text>
      </Box>
      <Box marginTop={1} gap={2}>
        <Text>
          <Text bold color="green">[y]</Text>
          <Text> Allow</Text>
        </Text>
        <Text>
          <Text bold color="blue">[a]</Text>
          <Text> Always</Text>
        </Text>
        <Text>
          <Text bold color="red">[n]</Text>
          <Text> Deny</Text>
        </Text>
      </Box>
    </Box>
  );
}
