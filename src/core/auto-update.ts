// KCode - Auto-Update System
// Checks GitHub Releases API for newer versions, downloads with SHA256 verification,
// and replaces the running binary. Respects user settings (autoUpdate: false).

import { chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { log } from "./logger";
import { kcodePath } from "./paths";

// ─── Constants ──────────────────────────────────────────────────

const GITHUB_REPO = "astrolexis/kcode";
const DEFAULT_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const UPDATE_CHECK_FILE = kcodePath("update-check.json");

// ─── Types ──────────────────────────────────────────────────────

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  releaseNotes: string;
  publishedAt: string;
  checksumUrl: string | null;
}

interface UpdateCheckState {
  lastCheck: number;
  lastVersion: string | null;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseData {
  tag_name?: string;
  version?: string;
  body?: string;
  assets?: ReleaseAsset[];
  published_at?: string;
}

// ─── Version Comparison ─────────────────────────────────────────

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b
 *   0 if a == b
 *   1 if a > b
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

// ─── Platform Detection ─────────────────────────────────────────

export function getPlatformSuffix(): string {
  const os = platform();
  const cpu = arch();

  if (os === "linux" && cpu === "x64") return "linux-x64";
  if (os === "linux" && cpu === "arm64") return "linux-arm64";
  if (os === "darwin" && cpu === "x64") return "macos-x64";
  if (os === "darwin" && cpu === "arm64") return "macos-arm64";
  if (os === "win32" && cpu === "x64") return "windows-x64.exe";

  throw new Error(`Unsupported platform: ${os}-${cpu}`);
}

// ─── Settings ───────────────────────────────────────────────────

/**
 * Read the autoUpdate setting from user settings.
 * Returns true by default (opt-out, not opt-in).
 */
export function isAutoUpdateEnabled(): boolean {
  try {
    const settingsPath = kcodePath("settings.json");
    if (!existsSync(settingsPath)) return true;
    const settings = JSON.parse(require("node:fs").readFileSync(settingsPath, "utf-8"));
    if (settings.autoUpdate === false) return false;
  } catch {
    /* ignore parse errors */
  }
  return true;
}

/**
 * Get the update check interval in milliseconds.
 * Defaults to 7 days; configurable via settings.updateCheckIntervalDays.
 */
export function getUpdateCheckInterval(): number {
  try {
    const settingsPath = kcodePath("settings.json");
    if (!existsSync(settingsPath)) return DEFAULT_CHECK_INTERVAL_MS;
    const settings = JSON.parse(require("node:fs").readFileSync(settingsPath, "utf-8"));
    if (typeof settings.updateCheckIntervalDays === "number" && settings.updateCheckIntervalDays > 0) {
      return settings.updateCheckIntervalDays * 24 * 60 * 60 * 1000;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_CHECK_INTERVAL_MS;
}

// ─── Check State Persistence ────────────────────────────────────

function readCheckState(): UpdateCheckState {
  try {
    if (existsSync(UPDATE_CHECK_FILE)) {
      const data = JSON.parse(require("node:fs").readFileSync(UPDATE_CHECK_FILE, "utf-8"));
      return {
        lastCheck: typeof data.lastCheck === "number" ? data.lastCheck : 0,
        lastVersion: typeof data.lastVersion === "string" ? data.lastVersion : null,
      };
    }
  } catch {
    /* ignore */
  }
  return { lastCheck: 0, lastVersion: null };
}

async function writeCheckState(state: UpdateCheckState): Promise<void> {
  try {
    const dir = kcodePath();
    if (!existsSync(dir)) {
      require("node:fs").mkdirSync(dir, { recursive: true });
    }
    await Bun.write(UPDATE_CHECK_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* ignore */
  }
}

// ─── Should Check ───────────────────────────────────────────────

/**
 * Determines if enough time has passed since the last check.
 * Also respects the autoUpdate setting.
 */
export function shouldCheckForUpdate(): boolean {
  if (!isAutoUpdateEnabled()) return false;

  const state = readCheckState();
  const interval = getUpdateCheckInterval();
  return Date.now() - state.lastCheck >= interval;
}

// ─── GitHub Release Check ───────────────────────────────────────

/**
 * Check GitHub Releases API for a newer version.
 * Returns UpdateInfo if a newer version is available, null otherwise.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "KCode-AutoUpdate" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      log.debug("auto-update", `GitHub API returned ${resp.status}`);
      return null;
    }

    const data = (await resp.json()) as ReleaseData;
    const tag = data.tag_name ?? data.version ?? "";
    const latestVersion = tag.replace(/^v/, "");

    // Save check state regardless of whether update is available
    await writeCheckState({ lastCheck: Date.now(), lastVersion: latestVersion });

    if (compareSemver(latestVersion, currentVersion) <= 0) {
      return null; // Already on latest or newer
    }

    const suffix = getPlatformSuffix();
    const asset = data.assets?.find((a) => a.name.includes(suffix));
    if (!asset) {
      log.warn("auto-update", `No binary found for ${suffix} in release ${tag}`);
      return null;
    }

    // Look for checksums file
    const checksumAsset = data.assets?.find(
      (a) => a.name === "checksums.txt" || a.name === "SHA256SUMS",
    );

    return {
      currentVersion,
      latestVersion,
      downloadUrl: asset.browser_download_url,
      releaseNotes: data.body ?? "",
      publishedAt: data.published_at ?? "",
      checksumUrl: checksumAsset?.browser_download_url ?? null,
    };
  } catch (err) {
    log.debug("auto-update", `Failed to check for updates: ${err}`);
    return null;
  }
}

// ─── SHA256 Verification ────────────────────────────────────────

async function fetchExpectedChecksum(
  checksumUrl: string,
  assetName: string,
): Promise<string | null> {
  try {
    const resp = await fetch(checksumUrl, {
      headers: { "User-Agent": "KCode-AutoUpdate" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;

    const text = await resp.text();
    for (const line of text.split("\n")) {
      if (line.includes(assetName)) {
        const hash = line.trim().split(/\s+/)[0];
        if (hash && hash.length === 64) return hash;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function computeSha256(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  hasher.update(new Uint8Array(buffer));
  return hasher.digest("hex");
}

// ─── Download & Install ────────────────────────────────────────

/**
 * Download the update binary, verify SHA256, and replace the current binary.
 * @param info - UpdateInfo from checkForUpdate
 * @param onProgress - Optional progress callback (0-100)
 */
export async function downloadAndInstall(
  info: UpdateInfo,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const resp = await fetch(info.downloadUrl, {
    signal: AbortSignal.timeout(300_000), // 5 minutes
    headers: { "User-Agent": "KCode-AutoUpdate" },
    redirect: "follow",
  });

  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }

  const totalSize = parseInt(resp.headers.get("content-length") ?? "0", 10);
  const tmpDir = require("node:os").tmpdir();
  const tmpPath = join(tmpDir, `kcode-update-${process.pid}`);

  // Stream to temp file
  const writer = Bun.file(tmpPath).writer();
  let downloaded = 0;

  try {
    for await (const chunk of resp.body as AsyncIterable<Uint8Array>) {
      writer.write(chunk);
      downloaded += chunk.length;

      if (onProgress && totalSize > 0) {
        onProgress(Math.round((downloaded / totalSize) * 100));
      }
    }
    await writer.end();
  } catch (err) {
    // Clean up on error
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  // Verify SHA256 checksum if available
  if (info.checksumUrl) {
    const suffix = getPlatformSuffix();
    const assetName = `kcode-${suffix}`;
    const expected = await fetchExpectedChecksum(info.checksumUrl, assetName);

    if (expected) {
      const actual = await computeSha256(tmpPath);
      if (actual !== expected) {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        throw new Error(
          `Checksum verification failed.\n  Expected: ${expected}\n  Got:      ${actual}`,
        );
      }
      log.info("auto-update", "SHA256 checksum verified.");
    }
  }

  // Make executable
  chmodSync(tmpPath, 0o755);

  // Find and replace binary
  const binaryPaths = findBinaryPaths();
  if (binaryPaths.length === 0) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw new Error("Could not find KCode binary path to replace.");
  }

  // Atomic replace: rename tmp → dest with backup
  const destPath = binaryPaths[0]!;
  const backupPath = destPath + ".old";

  try {
    if (existsSync(destPath)) {
      renameSync(destPath, backupPath);
    }
    renameSync(tmpPath, destPath);
    // Clean up backup
    try { unlinkSync(backupPath); } catch { /* may be in use */ }
  } catch (err) {
    // Restore backup if rename failed
    try {
      if (existsSync(backupPath)) {
        renameSync(backupPath, destPath);
      }
    } catch { /* best effort */ }
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  // Copy to additional locations
  for (let i = 1; i < binaryPaths.length; i++) {
    try {
      require("node:fs").copyFileSync(destPath, binaryPaths[i]!);
      chmodSync(binaryPaths[i]!, 0o755);
    } catch (err) {
      log.warn("auto-update", `Failed to copy to ${binaryPaths[i]}: ${err}`);
    }
  }
}

// ─── Binary Path Discovery ─────────────────────────────────────

function findBinaryPaths(): string[] {
  const paths: string[] = [];
  const candidates = [
    join(homedir(), ".local", "bin", "kcode"),
    join(homedir(), ".bun", "bin", "kcode"),
    "/usr/local/bin/kcode",
  ];

  try {
    const which = execSync("which kcode 2>/dev/null", { stdio: "pipe" }).toString().trim();
    if (which && !candidates.includes(which)) {
      candidates.unshift(which);
    }
  } catch { /* not in PATH */ }

  for (const p of candidates) {
    if (existsSync(p)) {
      paths.push(p);
    }
  }

  // Default to ~/.local/bin/kcode if nothing found
  if (paths.length === 0) {
    paths.push(join(homedir(), ".local", "bin", "kcode"));
  }

  return paths;
}
