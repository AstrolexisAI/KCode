// KCode - ModelToggle component
// Interactive model switcher: pick any registered model (local or cloud)

import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import { useTheme } from "../ThemeContext.js";

export interface ModelInfo {
  name: string;
  baseUrl: string;
  description?: string;
  gpu?: string;
  provider?: string;
  tags?: string[];
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
  // Per-model benchmark state: "passed" / "failed" / "new" (untested, cloud only)
  const [benchmarkState, setBenchmarkState] = useState<Record<string, "passed" | "failed" | "new">>(
    {},
  );

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
          await Promise.race([inFlight, new Promise((resolve) => setTimeout(resolve, 2000))]);
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
          tags: m.tags ?? m.capabilities,
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

      // Load benchmark results so we can render ✓ / [NEW] badges. Local
      // models are excluded from the "new" state since we don't benchmark them.
      try {
        const { loadBenchmarkStore } = await import("../../core/benchmark-store.js");
        const store = loadBenchmarkStore();
        const state: Record<string, "passed" | "failed" | "new"> = {};
        for (const m of all) {
          if (m.baseUrl.includes("localhost") || m.baseUrl.includes("127.0.0.1")) continue;
          const result = store.results[m.name];
          if (!result) {
            state[m.name] = "new";
          } else {
            state[m.name] = result.score >= 2 ? "passed" : "failed";
          }
        }
        if (Object.keys(state).length > 0) setBenchmarkState(state);
      } catch {
        /* benchmark store absent — safe */
      }
    })();
  }, []);

  // Keep selectedIndex in sync if the active model changes while the
  // toggle is open (e.g. a saved-preference restore fires mid-session).
  useEffect(() => {
    if (models.length === 0) return;
    const idx = models.findIndex((m) => m.name === currentModel);
    if (idx >= 0) setSelectedIndex(idx);
  }, [currentModel, models]);

  // ── Pure helpers (no hooks, no closures over hook state) ────────
  const isLocal = (m: ModelInfo): boolean =>
    m.baseUrl.includes("localhost") || m.baseUrl.includes("127.0.0.1");

  const providerLabel = (baseUrl: string): string => {
    if (baseUrl.includes("anthropic.com")) return "ANTHROPIC";
    if (baseUrl.includes("x.ai")) return "XAI";
    if (baseUrl.includes("openai.com")) return "OPENAI";
    if (baseUrl.includes("moonshot")) return "KIMI";
    if (baseUrl.includes("groq.com")) return "GROQ";
    if (baseUrl.includes("deepseek.com")) return "DEEPSEEK";
    if (baseUrl.includes("together.xyz")) return "TOGETHER";
    if (baseUrl.includes("googleapis.com") || baseUrl.includes("generativelanguage"))
      return "GEMINI";
    return "CLOUD";
  };

  // ── Derived state (hooks must come after all const-function declarations) ──

  // Build ordered list: LOCAL header → per-provider headers → sorted cloud models
  type ListItem =
    | { type: "header"; label: string }
    | { type: "model"; model: ModelInfo; globalIndex: number };

  const items: ListItem[] = useMemo(() => {
    const result: ListItem[] = [];
    const localModels = models.filter(isLocal);
    const cloudModels = models.filter((m) => !isLocal(m));

    if (localModels.length > 0) {
      result.push({ type: "header", label: "LOCAL" });
      for (const m of localModels) {
        result.push({ type: "model", model: m, globalIndex: models.indexOf(m) });
      }
    }

    // Group cloud models by provider, sort within each group
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of cloudModels) {
      const prov = providerLabel(m.baseUrl);
      if (!byProvider.has(prov)) byProvider.set(prov, []);
      byProvider.get(prov)!.push(m);
    }
    // Sort providers alphabetically, sort models within each provider
    const providerOrder = [...byProvider.keys()].sort();
    for (const prov of providerOrder) {
      const provModels = byProvider.get(prov)!.sort((a, b) => a.name.localeCompare(b.name));
      result.push({ type: "header", label: prov });
      for (const m of provModels) {
        result.push({ type: "model", model: m, globalIndex: models.indexOf(m) });
      }
    }
    return result;
  }, [models]);

  // Navigate in visual order — arrow keys follow sorted display, not raw array order
  const navigableItems = useMemo(
    () =>
      items.filter(
        (it): it is { type: "model"; model: ModelInfo; globalIndex: number } => it.type === "model",
      ),
    [items],
  );
  const currentVisualIdx = navigableItems.findIndex((it) => it.globalIndex === selectedIndex);

  useInput(
    (input, key) => {
      if (!isActive || loading || navigableItems.length === 0) return;
      if (key.upArrow || input === "k") {
        const prev = currentVisualIdx > 0 ? currentVisualIdx - 1 : navigableItems.length - 1;
        setSelectedIndex(navigableItems[prev]!.globalIndex);
      } else if (key.downArrow || input === "j") {
        const next = currentVisualIdx < navigableItems.length - 1 ? currentVisualIdx + 1 : 0;
        setSelectedIndex(navigableItems[next]!.globalIndex);
      } else if (key.return) {
        const chosen = models[selectedIndex]!;
        if (chosen.name === currentModel) {
          onDone(null);
        } else {
          onDone({ model: chosen });
        }
      } else if (key.escape || input === "q") {
        onDone(null);
      }
    },
    { isActive },
  );

  // Viewport: render only what fits on screen, centered on selected item.
  // terminal rows - 6 (border + header + footer + margin)
  const VIEWPORT = Math.max(8, (process.stdout.rows ?? 30) - 6);

  // Find position of selected item in the items[] list
  const selectedItemPos = items.findIndex(
    (it) => it.type === "model" && it.globalIndex === selectedIndex,
  );

  // Compute viewport start so selected item stays centered
  const viewStart = useMemo(() => {
    if (selectedItemPos < 0) return 0;
    const ideal = selectedItemPos - Math.floor(VIEWPORT / 2);
    return Math.max(0, Math.min(ideal, Math.max(0, items.length - VIEWPORT)));
  }, [selectedItemPos, items.length, VIEWPORT]);

  const visibleItems = items.slice(viewStart, viewStart + VIEWPORT);
  const aboveCount = viewStart;
  const belowCount = Math.max(0, items.length - viewStart - VIEWPORT);

  if (loading) {
    return (
      <Box borderStyle="round" borderColor={theme.primary} paddingX={1}>
        <Text dimColor>Loading models...</Text>
      </Box>
    );
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
        {"⚡ Model Switcher  "}
        <Text
          dimColor
        >{`${models.length} models · ↑↓ navegar · Enter seleccionar · Esc salir`}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {aboveCount > 0 && <Text dimColor>{`  ↑ ${aboveCount} more above`}</Text>}
        {visibleItems.map((item, i) => {
          if (item.type === "header") {
            return (
              <Box key={`hdr-${item.label}-${i}`} marginTop={i > 0 ? 1 : 0}>
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
          const tagLine =
            m.tags && m.tags.length > 0 ? "  " + m.tags.map((t) => `[${t}]`).join(" ") : "";

          const benchState = benchmarkState[m.name];

          return (
            <Box key={m.name} flexDirection="column">
              <Box flexDirection="row">
                <Text color={isSelected ? theme.primary : undefined} bold={isSelected}>
                  {(isSelected ? "▸ " : "  ") + (runtimeLabel ?? m.name)}
                </Text>
                {benchState === "passed" && <Text color={theme.success}>{" ✓"}</Text>}
                {benchState === "failed" && <Text color={theme.error}>{" ✗"}</Text>}
                {benchState === "new" && <Text color={theme.warning}>{" [NEW]"}</Text>}
                {isCurrent && <Text color={theme.success}>{" ●"}</Text>}
                {tagLine && <Text dimColor>{tagLine}</Text>}
              </Box>
              {isSelected && m.description && (
                <Text dimColor>
                  {"    "}
                  {m.description}
                </Text>
              )}
              {isSelected && m.gpu && (
                <Text dimColor>
                  {"    "}[{m.gpu}]
                </Text>
              )}
            </Box>
          );
        })}
        {belowCount > 0 && <Text dimColor>{`  ↓ ${belowCount} more below`}</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {"Current: "}
          <Text color={theme.primary}>{runtimeLabels[currentModel] ?? currentModel}</Text>
        </Text>
      </Box>
    </Box>
  );
}
