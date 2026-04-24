// KCode - Bitcoin RPC Verification Probe
//
// When the project's source code indicates it will talk to bitcoind
// over JSON-RPC (imports bitcoin-core, or hand-rolls a fetch against
// :8332 with rpcuser/rpcpassword), this probe opens that same
// connection and calls getblockcount. A numeric response proves the
// whole credential → network → node → RPC chain works. This is the
// real evidence that separates "process ran" from "app functions".

import { readFileSync } from "node:fs";
import { log } from "../logger";
import type { TaskScope } from "../task-scope";
import type { ProbeResult, VerificationProbe } from "./types";

interface BitcoinRpcConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

/** Read a file safely — returns "" if the path is missing or unreadable. */
function safeReadFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Look for Bitcoin-RPC shapes in any file the scope has touched. */
function detectBitcoinRpcUsage(scope: TaskScope): boolean {
  const touchedFiles = [
    ...scope.verification.filesWritten,
    ...scope.verification.filesEdited,
  ];
  for (const path of touchedFiles) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|py)$/.test(path)) continue;
    const content = safeReadFile(path);
    if (!content) continue;
    if (
      /\bbitcoin-core\b|\bAuthServiceProxy\b|\bbitcoinrpc\b|\bBitcoinCore\b/.test(
        content,
      ) ||
      /getblockcount|getblockchaininfo|getrawmempool|getmempoolinfo|getblockhash/.test(
        content,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extract RPC config from the scope's files. Handles the common
 * shapes we see in practice:
 *   new Client({ host, port, username, password })
 *   new Client({ host, port, user, pass })
 *   rpc_url = f"http://{user}:{pass}@{host}:{port}"
 *   process.env.BITCOIN_RPC_USER / BITCOIN_RPC_PASSWORD
 *
 * Falls back to ~/.bitcoin/bitcoin.conf (which we already read
 * separately in some repros) if the source uses env vars.
 */
function extractBitcoinRpcConfig(scope: TaskScope): BitcoinRpcConfig | null {
  let host = "127.0.0.1";
  let port = 8332;
  let username = "";
  let password = "";

  const touchedFiles = [
    ...scope.verification.filesWritten,
    ...scope.verification.filesEdited,
  ];
  for (const path of touchedFiles) {
    const content = safeReadFile(path);
    if (!content) continue;

    // host + port
    const hostMatch = content.match(
      /\bhost\s*[:=]\s*['"]([^'"]+)['"]/,
    );
    if (hostMatch?.[1]) host = hostMatch[1];
    const portMatch = content.match(/\bport\s*[:=]\s*['"]?(\d{2,5})['"]?/);
    if (portMatch?.[1]) port = parseInt(portMatch[1], 10);

    // username
    const userMatch =
      content.match(/\busername\s*[:=]\s*['"]([^'"]+)['"]/) ??
      content.match(/\buser\s*[:=]\s*['"]([^'"]+)['"]/) ??
      content.match(/\brpcuser\s*[:=]\s*['"]([^'"]+)['"]/);
    if (userMatch?.[1] && userMatch[1] !== "" && !userMatch[1].includes("${")) {
      username = userMatch[1];
    }

    // password
    const passMatch =
      content.match(/\bpassword\s*[:=]\s*['"]([^'"]+)['"]/) ??
      content.match(/\bpass\s*[:=]\s*['"]([^'"]+)['"]/) ??
      content.match(/\brpcpassword\s*[:=]\s*['"]([^'"]+)['"]/);
    if (passMatch?.[1] && passMatch[1] !== "" && !passMatch[1].includes("${")) {
      password = passMatch[1];
    }
  }

  // Fallback: read ~/.bitcoin/bitcoin.conf for credentials if the
  // source uses env vars / placeholders. The user's machine is the
  // trust boundary; this conf file is local-only.
  if (!username || !password) {
    try {
      const home = process.env.HOME ?? "";
      if (home) {
        const conf = safeReadFile(`${home}/.bitcoin/bitcoin.conf`);
        if (!username) {
          const m = conf.match(/^\s*rpcuser\s*=\s*(\S+)/m);
          if (m?.[1]) username = m[1];
        }
        if (!password) {
          const m = conf.match(/^\s*rpcpassword\s*=\s*(\S+)/m);
          if (m?.[1]) password = m[1];
        }
      }
    } catch {
      /* noop */
    }
  }

  if (!username || !password) return null;
  return { host, port, username, password };
}

export const bitcoinRpcProbe: VerificationProbe = {
  id: "bitcoin-rpc-getblockcount",
  description:
    "JSON-RPC probe: calls getblockcount against the configured Bitcoin node to prove the credential → network → node chain works.",
  applies(scope: TaskScope): boolean {
    return detectBitcoinRpcUsage(scope);
  },
  async run(scope: TaskScope): Promise<ProbeResult> {
    const cfg = extractBitcoinRpcConfig(scope);
    if (!cfg) {
      return {
        status: "not_applicable",
        probeId: this.id,
      };
    }

    const url = `http://${cfg.host}:${cfg.port}/`;
    const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString(
      "base64",
    );
    const body = JSON.stringify({
      jsonrpc: "1.0",
      id: "kcode-probe",
      method: "getblockcount",
      params: [],
    });

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${auth}`,
        },
        body,
        signal: AbortSignal.timeout(5000),
      });

      if (resp.status === 401) {
        return {
          status: "fail_auth",
          error: "401 Unauthorized — RPC credentials rejected",
          probeId: this.id,
        };
      }
      if (resp.status === 403) {
        return {
          status: "fail_auth",
          error: "403 Forbidden — RPC allowlist blocked this client",
          probeId: this.id,
        };
      }
      if (!resp.ok) {
        return {
          status: "fail_connection",
          error: `HTTP ${resp.status} ${resp.statusText}`,
          probeId: this.id,
        };
      }

      const json = (await resp.json()) as {
        result?: number | string;
        error?: { message?: string } | null;
      };
      if (json.error) {
        return {
          status: "fail_runtime",
          error: json.error.message ?? JSON.stringify(json.error),
          probeId: this.id,
        };
      }
      const blockCount = json.result;
      return {
        status: "pass",
        evidence: `getblockcount returned ${blockCount}`,
        tier: 3,
        probeId: this.id,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug("probe", `${this.id} failed: ${msg}`);
      if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(msg)) {
        return {
          status: "fail_connection",
          error: `node unreachable at ${url} (${msg})`,
          probeId: this.id,
        };
      }
      if (/abort|timeout/i.test(msg)) {
        return {
          status: "fail_connection",
          error: `RPC probe timed out after 5s at ${url}`,
          probeId: this.id,
        };
      }
      return {
        status: "fail_runtime",
        error: msg,
        probeId: this.id,
      };
    }
  },
};
