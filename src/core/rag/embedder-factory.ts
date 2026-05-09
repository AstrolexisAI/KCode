// KCode - Embedder factory
//
// Picks the best available embedder for the current install:
//   1. ANE (Pro, macOS-arm64, helper bundled)        ← preferred
//   2. LocalEmbedder (Ollama / llama.cpp running)    ← cross-platform
//   3. TfIdfEmbedder (built-in, zero deps)           ← always works
//
// Why this lives apart from embedder.ts:
//   - embedder.ts owns the LocalEmbedder + TF-IDF + cloud classes.
//     Adding the ANE selector logic there pulls Core ML / native
//     deps into every test that imports the embedder module.
//   - This factory is a thin shim. Callers (RAG engine) ask for
//     getEmbedder() and don't care which backend they got.

import { log } from "../logger";
import { ANEEmbedder, isANEAvailable } from "./ane-embedder";
import { type EmbedderInterface, LocalEmbedder } from "./embedder";

export interface EmbedderSelection {
  embedder: EmbedderInterface;
  /** Backend label for telemetry / UI. */
  backend: "ane" | "local" | "tfidf";
  /** One-line note for /doctor or status pages. */
  note: string;
}

/**
 * Pick the best embedder available right now. Synchronous probe;
 * actual model load is lazy in each backend.
 *
 * `requireAddonForANE` — when true (default), the ANE branch only
 * fires when the user's license has the "ane-embedder" addon
 * explicitly enabled. ANE-accelerated RAG is a **paid plugin** —
 * NOT auto-included in any tier (not even enterprise). Override
 * only in tests.
 */
export async function selectEmbedder(opts?: {
  requireAddonForANE?: boolean;
}): Promise<EmbedderSelection> {
  const requireAddonForANE = opts?.requireAddonForANE ?? true;

  if (isANEAvailable()) {
    let addonOK = true;
    if (requireAddonForANE) {
      try {
        const { hasLicenseAddon } = await import("../license");
        addonOK = hasLicenseAddon("ane-embedder");
      } catch {
        addonOK = false;
      }
    }
    if (addonOK) {
      log.info(
        "rag/embedder",
        "selected ANE backend (macOS arm64 + ane-embedder addon + helper bundled)",
      );
      return {
        embedder: new ANEEmbedder(),
        backend: "ane",
        note: "Apple Neural Engine (Core ML, BGE-M3 multilingual)",
      };
    }
    log.info(
      "rag/embedder",
      "ANE helper present but ane-embedder addon not licensed — falling back to local/tfidf",
    );
  }

  // Fallback to LocalEmbedder via Ollama / llama.cpp endpoint.
  // The constructor is cheap (no network); first embed() call will
  // surface errors with a clear message if Ollama isn't running.
  // (TF-IDF is available in embedder.ts but uses a different API
  // shape — fit/transform — that doesn't implement EmbedderInterface.
  // The existing RAG engine handles that path elsewhere.)
  log.info("rag/embedder", "selected LocalEmbedder (Ollama/llama.cpp endpoint)");
  return {
    embedder: new LocalEmbedder(),
    backend: "local",
    note: "Local Ollama / llama.cpp embedding server",
  };
}
