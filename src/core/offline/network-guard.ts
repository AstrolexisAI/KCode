// KCode - Network Guard
// Intercepts outgoing HTTP requests when offline mode is active.
// Allows: localhost, 127.0.0.1, ::1, LAN addresses (for local models)
// Blocks: everything else

import { getOfflineMode } from "./mode";

// ─── Host Classification ───────────────────────────────────────

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * Returns true if the URL points to a local/LAN host that should always be
 * reachable even in offline mode (e.g. local inference servers).
 */
export function isLocalHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (LOCAL_HOSTS.has(host)) return true;
    // Common LAN ranges
    if (host.startsWith("192.168.")) return true;
    if (host.startsWith("10.")) return true;
    // 172.16-31.x.x
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

// ─── OfflineError ──────────────────────────────────────────────

export class OfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineError";
  }
}

// ─── Offline-aware fetch wrapper ───────────────────────────────

/**
 * Drop-in replacement for `fetch()` that blocks non-local requests
 * when offline mode is active. Import this instead of using global fetch
 * in modules that make outgoing HTTP calls.
 */
export async function offlineAwareFetch(
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

  const offline = getOfflineMode();
  if (offline.isActive() && !isLocalHost(urlStr)) {
    throw new OfflineError(
      `Blocked: ${urlStr} (offline mode active). Use a local resource or disable offline mode.`,
    );
  }

  return fetch(url, init);
}
