// KCode - Phase 22 auto-launch dev server
//
// When the user's original prompt had runtime intent ("levantalo",
// "quiero verlo", "server", "dashboard", etc.) AND the current turn
// produced a runnable project via Write, proactively start the dev
// server at end-of-turn so the user doesn't have to type "lanzalo"
// afterward. Also report the PID and how to stop it.
//
// Evidence: the v2.10.59 Orbital session ended with orbital.html on
// disk and no running server. The user said "no levanto el servicio
// web" — meaning the model created the file but never executed the
// runtime step the user had asked for in the original prompt.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";
import {
  detectDevServer,
  startDevServer,
} from "./task-orchestrator/level1-handlers.js";
import type { Message } from "./types.js";

// ─── Session state ───────────────────────────────────────────────

interface SessionState {
  launched: boolean;
  launchedAt: number;
  launchedCwd: string;
}

const _sessionState: SessionState = {
  launched: false,
  launchedAt: 0,
  launchedCwd: "",
};

export function resetAutoLaunchState(): void {
  _sessionState.launched = false;
  _sessionState.launchedAt = 0;
  _sessionState.launchedCwd = "";
}

export function wasAutoLaunched(): boolean {
  return _sessionState.launched;
}

// ─── Runtime intent detection ───────────────────────────────────

/**
 * Keywords in user prose that indicate they want the deliverable to
 * actually RUN at the end, not just have source files on disk.
 * Narrow list — false positives here would auto-launch things the
 * user didn't ask to run.
 */
const RUNTIME_INTENT_KEYWORDS = [
  // Spanish action verbs
  /\blevant(?:a|e|ar|al[oa])\b/i,
  /\bejecut(?:a|e|ar|al[oa])\b/i,
  /\barranc(?:a|e|ar|al[oa])\b/i,
  /\blanza(?:r|l[oa])?\b/i,
  /\bcorre(?:r|l[oa])?\b/i,
  /\binicia(?:r|l[oa])?\b/i,
  /\babre(?:l[oa])?\b/i,
  /\bmontar(?:l[oa])?\b/i,
  // English action verbs
  /\brun\s+(?:it|the\s+(?:server|app|project))\b/i,
  /\blaunch\b/i,
  /\bstart\s+(?:the\s+)?(?:server|app|project)\b/i,
  /\bspin\s+up\b/i,
  // Runtime nouns that strongly imply a live service
  /\bservidor\s+web\b/i,
  /\bweb\s+server\b/i,
  /\bdev\s+server\b/i,
  /\bdashboard\b/i,
  /\bhttp:\/\/localhost\b/i,
  /\bport\s*\d+/i,
  /\bpuerto\s*\d+/i,
  /\bautom[aá]ticamente\b/i,
  /\bautomatically\s+(?:start|run|launch)/i,
  /\bque\s+se\s+levante\b/i,
  /\bpara\s+verlo\b/i,
  /\bto\s+see\s+it\b/i,
];

export function hasRuntimeIntent(userTexts: readonly string[]): boolean {
  for (const text of userTexts) {
    if (!text) continue;
    for (const re of RUNTIME_INTENT_KEYWORDS) {
      if (re.test(text)) return true;
    }
  }
  return false;
}

// ─── Write-in-turn detection ─────────────────────────────────────

/**
 * Walk the messages for the current turn and look for a successful
 * Write tool result. The turn is everything after the most recent
 * user-authored text message.
 */
export function hasRunnableWriteInTurn(messages: Message[]): boolean {
  let i = messages.length - 1;
  while (i >= 0) {
    const msg = messages[i];
    if (!msg) {
      i--;
      continue;
    }
    if (msg.role !== "user") {
      i--;
      continue;
    }
    if (typeof msg.content === "string") {
      // Bug #10 fix: skip system-injected user messages when walking
      // back to the turn boundary. `[SYSTEM]` messages come from
      // truncation retries, stop-hook blocks, reality-check reminders,
      // etc., and they should NOT count as the start of a new turn —
      // the real user's request is still further back. Without this
      // skip, hasRunnableWriteInTurn rejects phase 22 whenever
      // handlePostTurn has done any iteration housekeeping, even
      // though the user's actual Writes are visible.
      if (msg.content.startsWith("[SYSTEM]")) {
        i--;
        continue;
      }
      break;
    }
    if (Array.isArray(msg.content)) {
      const onlyToolResults = msg.content.every(
        (b) => (b as { type?: string }).type === "tool_result",
      );
      if (!onlyToolResults) break;
    }
    i--;
  }
  const turnMessages = messages.slice(i + 1);

  // Map tool_use id -> name so we can correlate tool_result to Write
  const toolNameById = new Map<string, string>();
  for (const msg of turnMessages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as { type?: string; id?: string; name?: string };
        if (b.type === "tool_use" && b.id && b.name) {
          toolNameById.set(b.id, b.name);
        }
      }
    }
  }

  for (const msg of turnMessages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as {
          type?: string;
          tool_use_id?: string;
          is_error?: boolean;
          content?: unknown;
        };
        if (b.type !== "tool_result") continue;
        if (b.is_error) continue;
        const toolName = b.tool_use_id ? toolNameById.get(b.tool_use_id) : undefined;
        if (toolName !== "Write") continue;
        const contentStr =
          typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? b.content
                  .map((sub) => {
                    const s = sub as { type?: string; text?: string };
                    return s.type === "text" && s.text ? s.text : "";
                  })
                  .join("\n")
              : "";
        if (/\bcreated\b/i.test(contentStr)) return true;
      }
    }
  }
  return false;
}

// ─── Already-running server detection ────────────────────────────

/**
 * Check if a process already has the target port open. Uses ss with a
 * 1s timeout — if it fails we return false (fail open) rather than
 * blocking the auto-launch.
 */
function portInUse(port: number): boolean {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(`ss -tlnp state listening "( sport = :${port} )"`, {
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return out.trim().split("\n").length > 1;
  } catch {
    return false;
  }
}

/** Guard against looping re-launches if we recently started a server. */
function launchedRecently(cwd: string): boolean {
  if (!_sessionState.launched) return false;
  if (_sessionState.launchedCwd !== cwd) return false;
  return Date.now() - _sessionState.launchedAt < 60_000;
}

// ─── Main entry ──────────────────────────────────────────────────

export interface AutoLaunchResult {
  notice: string;
  pid?: number;
  url?: string;
}

/**
 * Extract an explicit port number from the user's text. Matches shapes
 * like "en el puerto 24564", "on port 3000", "puerto: 8080". Returns
 * the first valid port found, or undefined.
 */
export function extractRequestedPort(userTexts: readonly string[]): number | undefined {
  const re = /\b(?:puerto|port)\s*[:=]?\s*(\d{2,5})\b/i;
  for (const text of userTexts) {
    if (!text) continue;
    const m = text.match(re);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (n >= 1024 && n <= 65535) return n;
    }
  }
  return undefined;
}

export async function maybeAutoLaunchDevServer(
  cwd: string,
  messages: Message[],
  userTexts: readonly string[],
): Promise<AutoLaunchResult | null> {
  try {
    // House-keeping: reap dead PIDs and kill stale orphans in this
    // cwd from prior kcode sessions before we consider launching
    // anything new. Fix for the v2.10.81 forensic audit P0 finding.
    // Best-effort: errors are swallowed so cleanup can never block
    // a legitimate launch.
    try {
      const { cleanupStaleDevServers } = await import("./dev-server-registry.js");
      const result = cleanupStaleDevServers(cwd);
      if (result.removedDead > 0 || result.killedStale > 0) {
        log.info(
          "auto-launch",
          `dev-server registry cleanup: removed ${result.removedDead} dead, killed ${result.killedStale} stale, ${result.remaining} remaining`,
        );
      }
    } catch (err) {
      log.debug("auto-launch", `registry cleanup failed (non-fatal): ${err}`);
    }

    // Guard 1: user's prompts must have runtime intent
    if (!hasRuntimeIntent(userTexts)) {
      log.debug("auto-launch", "skipped: no runtime intent in user text");
      return null;
    }

    // Guard 2: a Write must have completed this turn
    if (!hasRunnableWriteInTurn(messages)) {
      log.debug("auto-launch", "skipped: no successful Write in this turn");
      return null;
    }

    // Guard 3: a runnable project must exist in cwd. If the user's
    // prompt mentioned an explicit port (e.g. "en el puerto 24564"),
    // honor it by passing to detectDevServer.
    const requestedPort = extractRequestedPort(userTexts);
    const srv = detectDevServer(cwd, requestedPort);
    if (!srv) {
      log.debug("auto-launch", "skipped: detectDevServer returned null");
      return null;
    }

    // Guard 4: don't re-launch if recently started for same cwd
    if (launchedRecently(cwd)) {
      log.debug("auto-launch", "skipped: already launched recently");
      return null;
    }

    // Guard 5: skip if the target port is already bound (maybe by a
    // previous kcode session or external process)
    if (srv.port > 0 && portInUse(srv.port)) {
      log.debug("auto-launch", `skipped: port ${srv.port} already in use`);
      return null;
    }

    // Launch
    const result = startDevServer(srv, cwd);
    if (!result.handled) return null;

    // Extract PID and URL from the level1 result output so we can
    // build our own notice framing
    const output = result.output ?? "";
    const pidMatch = output.match(/PID:\s*(\d+)/);
    const urlMatch = output.match(/http:\/\/[^\s]+/);
    const pid = pidMatch?.[1] ? Number(pidMatch[1]) : undefined;
    const url = urlMatch?.[0];

    _sessionState.launched = true;
    _sessionState.launchedAt = Date.now();
    _sessionState.launchedCwd = cwd;

    const lines: string[] = [];
    lines.push("");
    lines.push("  ── Auto-launched dev server ──");
    if (url) lines.push(`  🌐 ${url}`);
    if (pid !== undefined) lines.push(`  PID: ${pid}`);
    lines.push("  To stop:");
    if (pid !== undefined) lines.push(`    kill ${pid}`);
    lines.push(`    or: pkill -f '${srv.command.split(" ")[0]}'`);
    lines.push('    or in kcode: "para el server" / /stop');
    lines.push("");

    const notice = lines.join("\n");
    log.info(
      "auto-launch",
      `started ${srv.name} on :${srv.port}${pid ? ` (PID ${pid})` : ""}`,
    );
    return { notice, pid, url };
  } catch (err) {
    log.debug("auto-launch", `check failed (non-fatal): ${err}`);
    return null;
  }
}

// Exported for tests so they can inspect without running level1
export { _sessionState as __autoLaunchSessionState };
