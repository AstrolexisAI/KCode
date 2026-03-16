// KCode - License Client
// Machine ID generation, license key storage, activation, and periodic validation.
// License keys are stored locally in ~/.kcode/license.json
// Phone-home validation occurs every 30 days against kulvex.ai

import { join } from "node:path";
import { homedir, hostname, cpus, totalmem, networkInterfaces } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { log } from "./logger";

const KCODE_HOME = join(homedir(), ".kcode");
const LICENSE_FILE = join(KCODE_HOME, "license.json");
const LICENSE_SERVER = "https://kulvex.ai";

// Grace period: allow offline usage for 30 days after last successful validation
const GRACE_PERIOD_DAYS = 30;
const CHECK_INTERVAL_DAYS = 30;

interface StoredLicense {
  licenseKey: string;
  tier: string;
  machineId: string;
  activatedAt: string;
  lastValidated: string;
  nextCheckDays: number;
}

/** Generate a deterministic machine ID from hardware fingerprint */
export function generateMachineId(): string {
  const parts: string[] = [];

  // Hostname
  parts.push(hostname());

  // CPU model and count
  const cpuInfo = cpus();
  if (cpuInfo.length > 0) {
    parts.push(cpuInfo[0].model);
    parts.push(cpuInfo.length.toString());
  }

  // Total RAM (rounded to nearest GB for stability)
  const ramGB = Math.round(totalmem() / (1024 * 1024 * 1024));
  parts.push(`${ramGB}GB`);

  // First non-internal MAC address
  const nets = networkInterfaces();
  for (const name of Object.keys(nets).sort()) {
    const ifaces = nets[name];
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
        parts.push(iface.mac);
        break;
      }
    }
    if (parts.length > 4) break; // Got a MAC
  }

  // Platform
  parts.push(process.platform);
  parts.push(process.arch);

  const fingerprint = parts.join("|");
  return createHash("sha256").update(fingerprint).digest("hex");
}

/** Load stored license from disk */
function loadStoredLicense(): StoredLicense | null {
  try {
    if (!existsSync(LICENSE_FILE)) return null;
    const data = JSON.parse(readFileSync(LICENSE_FILE, "utf-8"));
    if (!data.licenseKey || !data.machineId) return null;
    return data as StoredLicense;
  } catch {
    return null;
  }
}

/** Save license to disk */
function saveStoredLicense(license: StoredLicense): void {
  mkdirSync(KCODE_HOME, { recursive: true });
  writeFileSync(LICENSE_FILE, JSON.stringify(license, null, 2) + "\n", { mode: 0o600 });
}

/** Remove stored license */
export function clearLicense(): void {
  try {
    if (existsSync(LICENSE_FILE)) {
      const { unlinkSync } = require("node:fs");
      unlinkSync(LICENSE_FILE);
    }
  } catch { /* ignore */ }
}

/** Activate a license key — sends to server and binds to this machine */
export async function activateLicense(licenseKey: string): Promise<{ valid: boolean; tier?: string; message?: string }> {
  const machineId = generateMachineId();

  try {
    const resp = await fetch(`${LICENSE_SERVER}/api/licensing/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: licenseKey, machine_id: machineId }),
      signal: AbortSignal.timeout(15000),
    });

    const result = await resp.json() as any;

    if (result.valid) {
      const now = new Date().toISOString();
      saveStoredLicense({
        licenseKey,
        tier: result.tier,
        machineId,
        activatedAt: now,
        lastValidated: now,
        nextCheckDays: result.next_check_days ?? CHECK_INTERVAL_DAYS,
      });
      log.info("license", `License activated: tier=${result.tier}`);
      return { valid: true, tier: result.tier };
    }

    return { valid: false, message: result.message ?? result.error ?? "Activation failed" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("license", `Activation failed: ${msg}`);
    return { valid: false, message: `Could not reach license server: ${msg}` };
  }
}

/** Check if the license is valid (local check + periodic phone-home) */
export async function checkLicense(): Promise<{ valid: boolean; tier?: string; message?: string; grace?: boolean }> {
  const stored = loadStoredLicense();

  if (!stored) {
    return { valid: false, message: "No license found. Run 'kcode activate <license-key>' to activate." };
  }

  // Check machine ID matches
  const currentMachineId = generateMachineId();
  if (stored.machineId !== currentMachineId) {
    return { valid: false, message: "License is bound to a different machine. Contact support to transfer." };
  }

  // Check if phone-home is needed
  const lastValidated = new Date(stored.lastValidated);
  const daysSinceValidation = (Date.now() - lastValidated.getTime()) / (1000 * 60 * 60 * 24);
  const checkInterval = stored.nextCheckDays || CHECK_INTERVAL_DAYS;

  if (daysSinceValidation < checkInterval) {
    // Still within check interval — no need to phone home
    return { valid: true, tier: stored.tier };
  }

  // Try phone-home validation
  try {
    const resp = await fetch(`${LICENSE_SERVER}/api/licensing/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: stored.licenseKey,
        machine_id: currentMachineId,
        kulvex_version: getVersion(),
      }),
      signal: AbortSignal.timeout(10000),
    });

    const result = await resp.json() as any;

    if (result.valid) {
      // Update last validated timestamp
      stored.lastValidated = new Date().toISOString();
      stored.tier = result.tier;
      stored.nextCheckDays = result.next_check_days ?? CHECK_INTERVAL_DAYS;
      saveStoredLicense(stored);
      log.info("license", "License validated successfully");
      return { valid: true, tier: result.tier };
    }

    // Server says invalid — license revoked or problem
    log.warn("license", `License validation failed: ${result.message}`);
    return { valid: false, message: result.message ?? "License validation failed" };
  } catch {
    // Can't reach server — check grace period
    if (daysSinceValidation <= GRACE_PERIOD_DAYS) {
      log.debug("license", `Offline — grace period (${Math.round(GRACE_PERIOD_DAYS - daysSinceValidation)} days remaining)`);
      return { valid: true, tier: stored.tier, grace: true };
    }

    return {
      valid: false,
      message: `License check overdue (${Math.round(daysSinceValidation)} days). Connect to the internet to re-validate.`,
    };
  }
}

/** Check if a license is stored (doesn't validate) */
export function hasLicense(): boolean {
  return loadStoredLicense() !== null;
}

/** Get stored license info (for display) */
export function getLicenseInfo(): { tier: string; activatedAt: string; lastValidated: string } | null {
  const stored = loadStoredLicense();
  if (!stored) return null;
  return {
    tier: stored.tier,
    activatedAt: stored.activatedAt,
    lastValidated: stored.lastValidated,
  };
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
