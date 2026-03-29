// KCode - Incomplete Response Banner
// Shows when a response was truncated and couldn't be fully recovered

import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../ThemeContext.js";

interface IncompleteResponseBannerProps {
  continuations: number;
  stopReason: string;
}

export default function IncompleteResponseBanner({ continuations, stopReason }: IncompleteResponseBannerProps) {
  const { theme } = useTheme();

  return (
    <Box paddingLeft={2} marginTop={0}>
      <Text color={theme.warning} dimColor>
        {"--- "}
        {stopReason === "max_tokens"
          ? `Response incomplete — model reached output limit (${continuations} continuation${continuations !== 1 ? "s" : ""} attempted)`
          : `Response may be incomplete (${stopReason})`
        }
        {" ---"}
      </Text>
    </Box>
  );
}
