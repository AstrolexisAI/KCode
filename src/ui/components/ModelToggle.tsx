// KCode - ModelToggle component
// Interactive model switcher: pick any registered model (local or cloud)

import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
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
  // Canonical runtime labels, keyed by model.name. Populated async after
  // the initial list renders — we query each local model's llama.cpp
  // /props endpoint to read the GGUF currently loaded, since the alias
  // in models.json can lag behind the actual weights.
  const [runtimeLabels, setRuntimeLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      // If auto-discovery is still running in the background (fired
      // at TUI mount), wait up to 2s for it to finish so freshly-
      // added models appear on this same /model open. Beyond 2s we
      // show the current list anyway — the user shouldn't be stuck
      // waiting on network to see their existing models.
      try {
        const { getInFlightDiscovery } = await import("../../core/model-discovery.js");
        const inFlight = getInFlightDiscovery();
        if (inFlight) {
          await Promise.race([
            inFlight,
            new Promise((resolve) => setTimeout(resolve, 2000)),
          ]);
        }
      } catch {
        /* discovery module absent — safe to skip */
      }

      // Invalidate the in-process cache so we re-read from disk.
      // Auto-discovery writes new models to ~/.kcode/models.json
      // via saveModelsConfig which also updates the cache — but
      // invalidating here is belt-and-suspenders for any path that
      // might have updated the file without going through that
      // function.
      const { invalidateModelsCache, listModels } = await import("../../core/models.js");
      invalidateModelsCache();
      const all = await listModels();
      setModels(
        all.map((m) => ({
          name: m.name,
          baseUrl: m.baseUrl,
          description: m.description,
          gpu: m.gpu,
          provider: m.provider ?? (m.name.startsWith("claude") ? "anthropic" : "openai"),
        })),
      );
      // Pre-select the current model
      const idx = all.findIndex((m) => m.name === currentModel);
      if (idx >= 0) setSelectedIndex(idx);
      setLoading(false);

      // Async: fetch canonical runtime labels for local models so the
      // list reflects whatever GGUF is actually loaded, not a stale
      // alias that the launcher baked into models.json.
      const { getLocalModelLabel } = await import("../../core/model-local-discovery.js");
      const localOnes = all.filter(
        (m) => m.baseUrl.includes("localhost") || m.baseUrl.includes("127.0.0.1"),
      );
      const pairs = await Promise.all(
        localOnes.map(async (m) => [m.name, await getLocalModelLabel(m.baseUrl)] as const),
      );
      const resolved: Record<string, string> = {};
      for (const [name, label] of pairs) {
        if (label) resolved[name] = label;
      }
      if (Object.keys(resolved).length > 0) setRuntimeLabels(resolved);
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
  type ListItem =
    | { type: "header"; label: string }
    | { type: "model"; model: ModelInfo; globalIndex: number };
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
                <Text bold dimColor>
                  {"─── "}
                  {item.label}
                  {" ───"}
                </Text>
              </Box>
            );
          }

          const m = item.model;
          const isSelected = item.globalIndex === selectedIndex;
          const isCurrent = m.name === currentModel;

          const runtimeLabel = runtimeLabels[m.name];
          // Single-line format: Ink's <Box> with `gap` wraps long text
          // onto a second line and then inserts the next sibling between
          // the wrapped halves, which destroyed the layout with long
          // GGUF basenames. Keep everything in one <Text> so the head
          // line is a single contiguous string that Ink can wrap cleanly.
          const headLine =
            (isSelected ? "▸ " : "  ") +
            (runtimeLabel ?? m.name) +
            (runtimeLabel ? ` (${m.name})` : "");
          return (
            <Box key={m.name} flexDirection="column">
              <Box flexDirection="row">
                <Text color={isSelected ? theme.primary : undefined} bold={isSelected}>
                  {headLine}
                </Text>
                {isCurrent && <Text color={theme.success}>{" ●"}</Text>}
              </Box>
              {isSelected && m.description && (
                <Text dimColor>    {m.description}</Text>
              )}
              {isSelected && m.gpu && <Text dimColor>    [{m.gpu}]</Text>}
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
