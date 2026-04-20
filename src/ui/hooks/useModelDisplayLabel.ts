// KCode - useModelDisplayLabel
// Hook that resolves a model name (the key from ~/.kcode/models.json)
// into the label that should be shown in the UI. For local models,
// that label is the basename of the GGUF currently loaded by
// llama.cpp (queried via its /props endpoint). For cloud models or
// when the endpoint is unreachable, the hook falls back to the name
// as-is so existing behavior is preserved.

import { useEffect, useState } from "react";

export function useModelDisplayLabel(modelName: string): string {
  const [label, setLabel] = useState<string>(modelName);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { listModels } = await import("../../core/models.js");
        const all = await listModels();
        const m = all.find((x) => x.name === modelName);
        if (!m) return;
        const isLocal =
          m.baseUrl.includes("localhost") || m.baseUrl.includes("127.0.0.1");
        if (!isLocal) return;
        const { getLocalModelLabel } = await import(
          "../../core/model-local-discovery.js"
        );
        const derived = await getLocalModelLabel(m.baseUrl);
        if (!cancelled && derived) setLabel(derived);
      } catch {
        /* non-fatal: keep fallback label */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelName]);

  return label;
}
