// KCode — Inquisitor Bridge Client
//
// KCode handles discovery, verification, and agentic fix generation
// of confirmed findings — all free, all open source.
//
// CVE-grade evidence (compilable standalone reproducers, binary
// validation, signed disclosure bundles, intake submission) is
// produced by Inquisitor, a paid sister daemon. KCode talks to
// Inquisitor over HTTP through this thin bridge module.
//
// Why a bridge: KCode is Apache 2.0 and shipped to anyone; the
// proprietary work (Mender shim synthesis, VulnHunter binary scan,
// Pathfinder coordination + bundle signing) stays behind the
// service boundary. This module owns the contract.
//
// Default endpoint:  https://api.astrolexis.space/inquisitor/v1
// Override:          INQUISITOR_URL env var (for self-hosted, dev,
//                    or staging)
// Token storage:     ~/.inquisitor/token (single-line bearer token)
// Token issuance:    https://astrolexis.space/inquisitor

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

const DEFAULT_BRIDGE_URL = "https://api.astrolexis.space/inquisitor/v1";
const DEFAULT_TOKEN_PATH = pathJoin(homedir(), ".inquisitor", "token");

export type InquisitorAction = "reproduce" | "validate" | "bundle" | "disclose";

export interface PreflightResult {
  session_id: string;
  balance: number;
  tier: "free" | "starter" | "pro" | "team" | "enterprise";
}

export class InquisitorError extends Error {
  readonly hint?: string;
  readonly httpStatus?: number;
  constructor(message: string, opts?: { hint?: string; httpStatus?: number }) {
    super(message);
    this.name = "InquisitorError";
    this.hint = opts?.hint;
    this.httpStatus = opts?.httpStatus;
  }
}

function bridgeUrl(): string {
  return process.env.INQUISITOR_URL ?? DEFAULT_BRIDGE_URL;
}

function tokenPath(): string {
  return process.env.INQUISITOR_TOKEN_FILE ?? DEFAULT_TOKEN_PATH;
}

/**
 * Read the bearer token. Throws InquisitorError with a clear hint
 * if the token file is missing.
 */
export function readToken(): string {
  const envToken = process.env.INQUISITOR_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }
  const p = tokenPath();
  if (!existsSync(p)) {
    throw new InquisitorError("Inquisitor token not found.", {
      hint:
        "These commands require an Inquisitor account (KCode's paid sister service " +
        "for CVE-grade evidence: standalone reproducers, binary validation, " +
        "signed disclosure bundles).\n\n" +
        "  • Sign up: https://astrolexis.space/inquisitor\n" +
        "  • Already have a token? Save it with:\n" +
        "      mkdir -p ~/.inquisitor && echo '<your-token>' > ~/.inquisitor/token\n" +
        "    or export INQUISITOR_TOKEN=<your-token> in your shell.",
    });
  }
  const raw = readFileSync(p, "utf8").trim();
  if (raw.length === 0) {
    throw new InquisitorError("Inquisitor token file is empty.", {
      hint: `Edit ${p} and put your token on a single line, or unset and use INQUISITOR_TOKEN env var.`,
    });
  }
  return raw;
}

/**
 * Verify Inquisitor reachability + token validity + session balance
 * before running a gated command. Returns the preflight metadata
 * (session id, balance, tier).
 *
 * Throws InquisitorError with a hint pointing at the resolution
 * path (signup, login, top-up, etc.).
 */
export async function requireInquisitor(action: InquisitorAction): Promise<PreflightResult> {
  const token = readToken();
  let res: Response;
  try {
    res = await fetch(`${bridgeUrl()}/preflight`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "kcode/inquisitor-bridge",
      },
      body: JSON.stringify({ action }),
    });
  } catch (err) {
    throw new InquisitorError("Could not reach the Inquisitor bridge.", {
      hint:
        `Tried: ${bridgeUrl()}/preflight\n\n` +
        "Possible causes:\n" +
        "  • Network / DNS issue from this machine\n" +
        "  • Astrolexis is currently down (status: https://astrolexis.space/status)\n" +
        "  • You are pointing INQUISITOR_URL at a host that isn't running\n\n" +
        `Underlying error: ${(err as Error).message}`,
    });
  }

  if (res.status === 401) {
    throw new InquisitorError("Inquisitor token rejected (401).", {
      httpStatus: 401,
      hint:
        "Your token is invalid or expired.\n" +
        "  • Reissue: https://astrolexis.space/inquisitor/account/token",
    });
  }
  if (res.status === 402) {
    throw new InquisitorError("No Inquisitor sessions remaining.", {
      httpStatus: 402,
      hint:
        "Your tier's monthly session quota is exhausted.\n" +
        "  • Top up or upgrade: https://astrolexis.space/inquisitor/billing",
    });
  }
  if (res.status === 403) {
    throw new InquisitorError(`Inquisitor refused the '${action}' action for this tier.`, {
      httpStatus: 403,
      hint:
        "The Free tier disables some actions (e.g. `disclose` to external intakes).\n" +
        "  • Upgrade: https://astrolexis.space/inquisitor",
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new InquisitorError(`Inquisitor preflight failed (HTTP ${res.status}).`, {
      httpStatus: res.status,
      hint: text ? `Server said: ${text.slice(0, 400)}` : undefined,
    });
  }

  return (await res.json()) as PreflightResult;
}

/**
 * Submit a payload to a gated Inquisitor endpoint. The action
 * argument is one of the canonical command names; the payload
 * shape is action-specific (the caller knows it). Returns the
 * parsed JSON body on success.
 *
 * Callers should run requireInquisitor() first; this function
 * does NOT re-do the preflight, it just posts the work.
 */
export async function submitToInquisitor<T = unknown>(
  action: InquisitorAction,
  payload: object,
): Promise<T> {
  const token = readToken();
  const url = `${bridgeUrl()}/${action}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "kcode/inquisitor-bridge",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new InquisitorError(`Could not reach Inquisitor for action '${action}'.`, {
      hint: `Tried: ${url}\nUnderlying: ${(err as Error).message}`,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new InquisitorError(`Inquisitor '${action}' failed (HTTP ${res.status}).`, {
      httpStatus: res.status,
      hint: text ? `Server said: ${text.slice(0, 800)}` : undefined,
    });
  }
  return (await res.json()) as T;
}

/**
 * Format an InquisitorError for terminal output. Returns a string
 * with the headline message + hint, suitable for `console.error`.
 */
export function formatInquisitorError(err: InquisitorError): string {
  const lines = [`\x1b[31m✗\x1b[0m ${err.message}`];
  if (err.hint) {
    lines.push("");
    for (const ln of err.hint.split("\n")) lines.push(`  ${ln}`);
  }
  return lines.join("\n");
}
