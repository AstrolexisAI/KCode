// KCode - Kulvex platform discovery
//
// On startup, probes well-known local Kulvex endpoints to find a
// running inference server with a loaded model. When found, KCode uses
// that shared endpoint instead of starting its own — saves the cost of
// loading the same 25+ GB model into memory twice.
//
// Kulvex's inference service exposes an OpenAI-compatible API at /v1/*
// (mlx_lm.server or llama-server, both speak the same protocol), so we
// only need the baseUrl + the loaded model id from /v1/models. Default
// port :8090.

import { log } from "./logger";

export interface KulvexEndpoint {
  /** Base URL kcode should send /v1/chat/completions to (e.g. http://localhost:8090). */
  baseUrl: string;
  /** Model id reported by /v1/models — used as the OpenAI `model` field. */
  modelId: string;
  /** Backend kind, useful for diagnostics. */
  backend: "llama.cpp" | "mlx" | "unknown";
}

/** Default places to probe. Override with KCODE_KULVEX_ENDPOINTS or ~/.kcode/settings.json. */
const DEFAULT_ENDPOINTS = ["http://localhost:8090"];

function getConfiguredEndpoints(): string[] {
  const env = process.env.KCODE_KULVEX_ENDPOINTS;
  if (env) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // settings.json read is intentionally lazy and best-effort: this module
  // runs at startup before the rest of the config layer is initialized.
  try {
    const path = require("node:path") as typeof import("node:path");
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const file = path.join(os.homedir(), ".kcode", "settings.json");
    if (fs.existsSync(file)) {
      const cfg = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        kulvex?: { discover?: boolean; endpoints?: string[] };
      };
      if (cfg.kulvex?.discover === false) return [];
      if (Array.isArray(cfg.kulvex?.endpoints) && cfg.kulvex.endpoints.length > 0) {
        return cfg.kulvex.endpoints;
      }
    }
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_ENDPOINTS;
}

/**
 * Probe one endpoint. Returns the loaded model + backend hint, or null
 * if the endpoint is unreachable or has no model loaded.
 *
 * Bounded by a 1 s timeout per endpoint so kcode startup never stalls
 * waiting for a Kulvex that isn't running.
 */
async function probeOne(baseUrl: string): Promise<KulvexEndpoint | null> {
  const controller = AbortSignal.timeout(1000);
  try {
    const resp = await fetch(`${baseUrl}/v1/models`, { signal: controller });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { data?: Array<{ id?: string; object?: string }> };
    const first = body.data?.[0];
    if (!first?.id) return null;

    // llama-server identifies itself in /health responses; not strictly
    // required for routing but useful for the diagnostic command.
    let backend: KulvexEndpoint["backend"] = "unknown";
    try {
      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
      if (health.ok) {
        const text = await health.text();
        if (/llama|metal/i.test(text)) backend = "llama.cpp";
        else if (/mlx/i.test(text)) backend = "mlx";
      }
    } catch {
      /* health check is optional */
    }

    return { baseUrl, modelId: first.id, backend };
  } catch {
    return null;
  }
}

/**
 * Probe configured endpoints in order; return the first one that is
 * up and has a model loaded. Returns null if none found.
 *
 * Skipped entirely when KCODE_KULVEX_DISCOVER=off or settings disable it.
 */
export async function discoverKulvex(): Promise<KulvexEndpoint | null> {
  if (process.env.KCODE_KULVEX_DISCOVER === "off") {
    return null;
  }
  const endpoints = getConfiguredEndpoints();
  if (endpoints.length === 0) return null;

  for (const ep of endpoints) {
    const result = await probeOne(ep);
    if (result) {
      log.info("kulvex", `Discovered shared inference at ${ep} (model: ${result.modelId})`);
      return result;
    }
  }
  return null;
}
