// KCode - ModelToggle component
// Interactive model switcher: pick any registered model (local or cloud)

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../ThemeContext.js";

export interface ModelInfo {
  name: string;
  baseUrl: string;
  description?: string;
  gpu?: string;
  provider?: string;
}

export interface ModelToggleResult {
  model: ModelInfo;
}

interface ModelToggleProps {
  isActive: boolean;
  currentModel: string;
  onDone: (result: ModelToggleResult | null) => void;
}

export default function ModelToggle({ isActive, currentModel, onDone }: ModelToggleProps) {
  const { theme } = useTheme();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { listModels } = await import("../../core/models.js");
      const all = await listModels();
      setModels(all.map((m) => ({
        name: m.name,
        baseUrl: m.baseUrl,
        description: m.description,
        gpu: m.gpu,
        provider: m.provider ?? (m.name.startsWith("claude") ? "anthropic" : "openai"),
      })));
      // Pre-select the current model
      const idx = all.findIndex((m) => m.name === currentModel);
      if (idx >= 0) setSelectedIndex(idx);
      setLoading(false);
    })();
  }, []);

  useInput(
    (input, key) => {
      if (!isActive || loading || models.length === 0) return;

      if (key.upArrow || input === "k") {
        setSelectedIndex((i) => (i > 0 ? i - 1 : models.length - 1));
      } else if (key.downArrow || input === "j") {
        setSelectedIndex((i) => (i < models.length - 1 ? i + 1 : 0));
      } else if (key.return) {
        const chosen = models[selectedIndex]!;
        if (chosen.name === currentModel) {
          onDone(null); // already active, just close
        } else {
          onDone({ model: chosen });
        }
      } else if (key.escape || input === "q") {
        onDone(null);
      }
    },
    { isActive },
  );

  const isLocal = (m: ModelInfo): boolean => {
    return m.baseUrl.includes("localhost") || m.baseUrl.includes("127.0.0.1");
  };

  if (loading) {
    return (
      <Box borderStyle="round" borderColor={theme.primary} paddingX={1}>
        <Text dimColor>Loading models...</Text>
      </Box>
    );
  }

  // Group: local first, then cloud
  const localModels = models.filter(isLocal);
  const cloudModels = models.filter((m) => !isLocal(m));

  // Build ordered list with section markers
  type ListItem = { type: "header"; label: string } | { type: "model"; model: ModelInfo; globalIndex: number };
  const items: ListItem[] = [];

  if (localModels.length > 0) {
    items.push({ type: "header", label: "LOCAL" });
    for (const m of localModels) {
      items.push({ type: "model", model: m, globalIndex: models.indexOf(m) });
    }
  }
  if (cloudModels.length > 0) {
    items.push({ type: "header", label: "CLOUD" });
    for (const m of cloudModels) {
      items.push({ type: "model", model: m, globalIndex: models.indexOf(m) });
    }
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      marginY={0}
    >
      <Text bold color={theme.primary}>
        {"⚡ Model Switcher"}
      </Text>
      <Box marginTop={1}>
        <Text dimColor>Arrow keys to navigate, Enter to switch, Esc to cancel</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {items.map((item, i) => {
          if (item.type === "header") {
            return (
              <Box key={`hdr-${item.label}`} marginTop={i > 0 ? 1 : 0}>
                <Text bold dimColor>{"─── "}{item.label}{" ───"}</Text>
              </Box>
            );
          }

          const m = item.model;
          const isSelected = item.globalIndex === selectedIndex;
          const isCurrent = m.name === currentModel;

          return (
            <Box key={m.name} gap={1}>
              <Text color={isSelected ? theme.primary : undefined} bold={isSelected}>
                {isSelected ? "▸ " : "  "}
                {m.name}
              </Text>
              {isCurrent && <Text color={theme.success}>●</Text>}
              {isSelected && m.description && (
                <Text dimColor>{m.description}</Text>
              )}
              {isSelected && m.gpu && (
                <Text dimColor>[{m.gpu}]</Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Current: <Text color={theme.primary}>{currentModel}</Text>
        </Text>
      </Box>
    </Box>
  );
}
