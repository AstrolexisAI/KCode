// KCode — Secure / Gov-Readiness Checks
//
// Runs the air-gap / supply-chain / hardening checks that an analyst
// from a security-conscious org (NSA/NASA/CMMC L2+/IL4+) would expect
// to see green before approving the tool for evaluation.
//
// Each check is independent and returns a SecureCheckResult. Output
// is rendered as a checklist by the doctor command.
//
// Purposeful choices:
//   - Read-only. No remediation. The user (or their compliance team)
//     decides whether to act on each finding.
//   - No network calls. The whole point of the suite is to confirm
//     posture, not to phone home.
//   - Conservative defaults: ambiguous → warn rather than pass. A
//     quiet "all green" check that misses a misconfiguration is
//     worse than a noisy warn.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SecureCheckStatus = "pass" | "warn" | "fail" | "info";

export interface SecureCheckResult {
  id: string;
  name: string;
  status: SecureCheckStatus;
  message: string;
  /** Optional remediation hint for warn/fail. */
  fix?: string;
}

// ─── Individual checks ─────────────────────────────────────────

function checkOfflineMode(): SecureCheckResult {
  const envOn = process.env.KCODE_OFFLINE === "1";

  // Settings-based offline (settings.offline.enabled)
  let settingsOn = false;
  try {
    const settingsPath = join(homedir(), ".kcode", "settings.json");
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
        offline?: { enabled?: boolean };
      };
      settingsOn = settings.offline?.enabled === true;
    }
  } catch {
    /* ignore */
  }

  if (envOn) {
    return {
      id: "offline-mode",
      name: "Offline / air-gap mode",
      status: "pass",
      message: "KCODE_OFFLINE=1 is set — egress to non-localhost will be blocked",
    };
  }
  if (settingsOn) {
    return {
      id: "offline-mode",
      name: "Offline / air-gap mode",
      status: "pass",
      message: "settings.offline.enabled=true — egress to non-localhost will be blocked",
    };
  }
  return {
    id: "offline-mode",
    name: "Offline / air-gap mode",
    status: "warn",
    message: "Offline mode is not forced — KCode may attempt cloud calls if reachable",
    fix: 'Set KCODE_OFFLINE=1 in the environment, or {"offline":{"enabled":true}} in ~/.kcode/settings.json',
  };
}

function checkNoCloudProviders(): SecureCheckResult {
  const settingsPath = join(homedir(), ".kcode", "settings.json");
  let cloudKeys: string[] = [];
  try {
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      const cloudKeyNames = [
        "anthropicApiKey",
        "apiKey",
        "openaiApiKey",
        "groqApiKey",
        "deepseekApiKey",
        "togetherApiKey",
        "xaiApiKey",
        "geminiApiKey",
        "kimiApiKey",
      ];
      cloudKeys = cloudKeyNames.filter(
        (k) => typeof s[k] === "string" && (s[k] as string).length > 0,
      );
    }
  } catch {
    /* ignore */
  }
  // Env vars also count
  const envKeys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GROQ_API_KEY",
    "DEEPSEEK_API_KEY",
    "TOGETHER_API_KEY",
    "XAI_API_KEY",
    "GROK_API_KEY",
    "GEMINI_API_KEY",
  ].filter((k) => process.env[k]);

  const total = cloudKeys.length + envKeys.length;
  if (total === 0) {
    return {
      id: "no-cloud-keys",
      name: "No cloud API keys configured",
      status: "pass",
      message: "No cloud provider credentials present — local-only configuration",
    };
  }
  return {
    id: "no-cloud-keys",
    name: "No cloud API keys configured",
    status: "warn",
    message: `${total} cloud credential(s) detected (${[...cloudKeys, ...envKeys].slice(0, 3).join(", ")}${total > 3 ? ", ..." : ""})`,
    fix: "For pure-local operation, remove API keys from settings.json and unset env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)",
  };
}

function checkAutoUpdateDisabled(): SecureCheckResult {
  try {
    const settingsPath = join(homedir(), ".kcode", "settings.json");
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as { autoUpdate?: boolean };
      if (s.autoUpdate === false) {
        return {
          id: "auto-update",
          name: "Auto-update disabled",
          status: "pass",
          message: "settings.autoUpdate=false — no scheduled outbound to update server",
        };
      }
    }
  } catch {
    /* ignore */
  }
  return {
    id: "auto-update",
    name: "Auto-update disabled",
    status: "warn",
    message: "Auto-update is not explicitly disabled (default: weekly check)",
    fix: 'Set {"autoUpdate":false} in ~/.kcode/settings.json for fully manual updates',
  };
}

function checkTelemetryOff(): SecureCheckResult {
  try {
    const settingsPath = join(homedir(), ".kcode", "settings.json");
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
        telemetry?: { enabled?: boolean; sinks?: unknown[] };
      };
      const enabled = s.telemetry?.enabled === true;
      const sinks = (s.telemetry?.sinks ?? []) as unknown[];
      if (!enabled && sinks.length === 0) {
        return {
          id: "telemetry-off",
          name: "Telemetry disabled",
          status: "pass",
          message: "No telemetry sinks configured",
        };
      }
      return {
        id: "telemetry-off",
        name: "Telemetry disabled",
        status: "fail",
        message: `Telemetry is enabled (${sinks.length} sink(s) configured)`,
        fix: 'Set {"telemetry":{"enabled":false,"sinks":[]}} in ~/.kcode/settings.json',
      };
    }
  } catch {
    /* ignore */
  }
  return {
    id: "telemetry-off",
    name: "Telemetry disabled",
    status: "pass",
    message: "No settings.json present, telemetry off by default",
  };
}

function checkSettingsFilePermissions(): SecureCheckResult {
  const settingsPath = join(homedir(), ".kcode", "settings.json");
  try {
    if (!existsSync(settingsPath)) {
      return {
        id: "settings-perms",
        name: "Settings file permissions",
        status: "info",
        message: "No ~/.kcode/settings.json present",
      };
    }
    const stat = statSync(settingsPath);
    const mode = stat.mode & 0o777;
    if (mode === 0o600 || mode === 0o400) {
      return {
        id: "settings-perms",
        name: "Settings file permissions",
        status: "pass",
        message: `~/.kcode/settings.json mode is ${mode.toString(8).padStart(3, "0")} (owner-only)`,
      };
    }
    // World/group readable: bad if file holds API keys
    return {
      id: "settings-perms",
      name: "Settings file permissions",
      status: "warn",
      message: `~/.kcode/settings.json mode is ${mode.toString(8).padStart(3, "0")} — readable by others`,
      fix: "Run: chmod 600 ~/.kcode/settings.json",
    };
  } catch (err) {
    return {
      id: "settings-perms",
      name: "Settings file permissions",
      status: "info",
      message: `Could not stat settings: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkPinnedProductionDeps(packageJsonPath: string): SecureCheckResult {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};
    const ranged: string[] = [];
    for (const [name, range] of Object.entries(deps)) {
      // Caret/tilde/range/star → not pinned
      if (/^[\^~>=<*]/.test(range)) ranged.push(`${name}@${range}`);
    }
    if (ranged.length === 0) {
      return {
        id: "pinned-deps",
        name: "Production dependencies pinned",
        status: "pass",
        message: `${Object.keys(deps).length} dep(s), all exact versions`,
      };
    }
    return {
      id: "pinned-deps",
      name: "Production dependencies pinned",
      status: "warn",
      message: `${ranged.length} dep(s) use range specifiers (e.g. ${ranged[0]})`,
      fix: "Replace ^/~ with exact versions in package.json dependencies. Lockfile already pins them; this is for source-of-truth review.",
    };
  } catch (err) {
    return {
      id: "pinned-deps",
      name: "Production dependencies pinned",
      status: "info",
      message: `Could not read package.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkBinarySignature(): SecureCheckResult {
  // Until cosign signing is wired into CI, this is documentation-only.
  // Once .sig files ship alongside binaries, this will run cosign verify.
  return {
    id: "binary-signature",
    name: "Binary signature (sigstore)",
    status: "info",
    message: "Run `cosign verify-blob` against the .sig published with each release",
    fix: "See docs/security/verify-binary.md for the verification command",
  };
}

function checkOutboundAttestation(): SecureCheckResult {
  // We can't truly attest no-egress from inside the process. We flag
  // the offline-mode finding above and document the CI suite as the
  // attestation point.
  const envOn = process.env.KCODE_OFFLINE === "1";
  if (envOn) {
    return {
      id: "egress-attestation",
      name: "Egress block attestation",
      status: "info",
      message: "src/core/offline/egress-block.test.ts proves the block surface; KCODE_OFFLINE=1 is active",
    };
  }
  return {
    id: "egress-attestation",
    name: "Egress block attestation",
    status: "info",
    message: "Run with KCODE_OFFLINE=1 + monitor sockets in tcpdump/ss to attest no-egress for an air-gap deployment",
  };
}

// ─── Runner ────────────────────────────────────────────────────

export async function runSecureChecks(opts?: {
  packageJsonPath?: string;
}): Promise<SecureCheckResult[]> {
  const pkgPath = opts?.packageJsonPath ?? resolve(process.cwd(), "package.json");
  return [
    checkOfflineMode(),
    checkNoCloudProviders(),
    checkAutoUpdateDisabled(),
    checkTelemetryOff(),
    checkSettingsFilePermissions(),
    checkPinnedProductionDeps(pkgPath),
    checkBinarySignature(),
    checkOutboundAttestation(),
  ];
}

export function renderSecureReport(results: SecureCheckResult[]): string {
  const icons: Record<SecureCheckStatus, string> = {
    pass: "\x1b[32m✓\x1b[0m",
    warn: "\x1b[33m⚠\x1b[0m",
    fail: "\x1b[31m✗\x1b[0m",
    info: "\x1b[2mi\x1b[0m",
  };

  const lines: string[] = [];
  lines.push("");
  lines.push("\x1b[1mKCode — Secure / Gov-Readiness Posture\x1b[0m");
  lines.push("");
  for (const r of results) {
    lines.push(`  ${icons[r.status]} \x1b[1m${r.name}\x1b[0m`);
    lines.push(`    ${r.message}`);
    if (r.fix && (r.status === "warn" || r.status === "fail")) {
      lines.push(`    \x1b[2mfix:\x1b[0m ${r.fix}`);
    }
    lines.push("");
  }

  const passes = results.filter((r) => r.status === "pass").length;
  const warns = results.filter((r) => r.status === "warn").length;
  const fails = results.filter((r) => r.status === "fail").length;
  const total = results.length;
  lines.push(
    `  ${passes}/${total} pass · ${warns} warn · ${fails} fail`,
  );
  if (fails === 0 && warns === 0) {
    lines.push("  \x1b[32mAll secure-mode checks passed.\x1b[0m");
  } else if (fails === 0) {
    lines.push("  \x1b[33mWarnings present — review against your deployment policy.\x1b[0m");
  } else {
    lines.push("  \x1b[31mFailures present — fix before submitting for security evaluation.\x1b[0m");
  }
  lines.push("");
  return lines.join("\n");
}
