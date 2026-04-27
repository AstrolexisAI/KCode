// KCode - Auto-Update System
//
// Talks to a self-hosted manifest at kulvex.ai/downloads/kcode/latest.json
// (emitted by scripts/release.ts) and self-replaces the running binary
// with the version it advertises. Embedded SHA256 in the manifest is the
// integrity check; rollback keeps the previous binary at
// ~/.kcode/previous-kcode so a bad release can be reverted in one command.
//
// We left npm publishing in v2.10.357. The npm-publish CI lane stayed
// stuck on a 401/404 mismatch through ~7 token rotations and it was never
// the right shape for a 117 MB binary anyway. This module is the
// replacement distribution channel.

import { execSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger";
import { kcodePath } from "./paths";

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_MANIFEST_URL = "https://kulvex.ai/downloads/kcode/latest.json";
const DEFAULT_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NOTIFICATION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getManifestUrl(): string {
  return process.env.KCODE_UPDATE_MANIFEST_URL ?? DEFAULT_MANIFEST_URL;
}

function getUpdateCheckFile(): string {
  return kcodePath("update-check.json");
}

function getRollbackBinaryPath(): string {
  return kcodePath("previous-kcode");
}

// ─── Types ──────────────────────────────────────────────────────

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  channel: "stable" | "beta";
  downloadUrl?: string;
  filename?: string;
  sha256?: string;
  size?: number;
  releaseUrl?: string;
  releaseNotes?: string;
  publishedAt?: string;
  // Optional delta from the user's current version. When present and
  // bspatch is available locally, the updater downloads + applies the
  // delta instead of the full binary. Always falls back to full
  // download if anything in the delta path fails.
  delta?: {
    url: string;
    sha256: string;
    size: number;
    from_sha256: string;
  };
}

export interface UpdateResult {
  success: boolean;
  previousVersion: string;
  newVersion: string;
  error?: string;
}

interface UpdateCheckState {
  lastCheck: number;
  lastVersion: string | null;
  releaseUrl?: string;
  releaseNotes?: string;
  publishedAt?: string;
}

interface ManifestDelta {
  url: string;
  sha256: string;
  size: number;
  // SHA256 of the source binary the patch was generated against. Lets
  // the client refuse to apply a delta to a binary it didn't expect
  // (e.g. user's local install diverged or was hand-patched).
  from_sha256: string;
}

interface ManifestPlatform {
  url: string;
  filename: string;
  sha256: string;
  size: number;
  // Optional bsdiff-format binary deltas keyed by `from` version. Each
  // delta produces the same target binary (same `sha256` above) when
  // applied to the matching `from_sha256` source.
  deltas?: Record<string, ManifestDelta>;
}

interface Manifest {
  schema_version: number;
  latest: string;
  released_at?: string;
  channels?: { stable: string; beta?: string };
  platforms: Record<string, ManifestPlatform>;
  release_notes?: string;
}

// ─── Version Comparison ─────────────────────────────────────────

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

/**
 * Returns the manifest platform key for the current host. Matches the
 * keys release.ts emits (`${process.platform}-${process.arch}`):
 * linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.
 */
export function getPlatformKey(): string {
  const os = process.platform;
  const cpu = process.arch;
  if (os === "linux" && cpu === "x64") return "linux-x64";
  if (os === "linux" && cpu === "arm64") return "linux-arm64";
  if (os === "darwin" && cpu === "x64") return "darwin-x64";
  if (os === "darwin" && cpu === "arm64") return "darwin-arm64";
  if (os === "win32" && cpu === "x64") return "win32-x64";
  throw new Error(`Unsupported platform: ${os}-${cpu}`);
}

/**
 * Legacy human-readable platform suffix kept for install.sh / Homebrew
 * compatibility (existing tests still pin this format).
 */
export function getPlatformSuffix(): string {
  const os = process.platform;
  const cpu = process.arch;
  if (os === "linux" && cpu === "x64") return "linux-x64";
  if (os === "linux" && cpu === "arm64") return "linux-arm64";
  if (os === "darwin" && cpu === "x64") return "macos-x64";
  if (os === "darwin" && cpu === "arm64") return "macos-arm64";
  if (os === "win32" && cpu === "x64") return "windows-x64.exe";
  throw new Error(`Unsupported platform: ${os}-${cpu}`);
}

// ─── Settings ───────────────────────────────────────────────────

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

export function getUpdateCheckInterval(): number {
  try {
    const settingsPath = kcodePath("settings.json");
    if (!existsSync(settingsPath)) return DEFAULT_CHECK_INTERVAL_MS;
    const settings = JSON.parse(require("node:fs").readFileSync(settingsPath, "utf-8"));
    if (
      typeof settings.updateCheckIntervalDays === "number" &&
      settings.updateCheckIntervalDays > 0
    ) {
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
    if (existsSync(getUpdateCheckFile())) {
      const data = JSON.parse(require("node:fs").readFileSync(getUpdateCheckFile(), "utf-8"));
      return {
        lastCheck: typeof data.lastCheck === "number" ? data.lastCheck : 0,
        lastVersion: typeof data.lastVersion === "string" ? data.lastVersion : null,
        releaseUrl: typeof data.releaseUrl === "string" ? data.releaseUrl : undefined,
        releaseNotes: typeof data.releaseNotes === "string" ? data.releaseNotes : undefined,
        publishedAt: typeof data.publishedAt === "string" ? data.publishedAt : undefined,
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
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await Bun.write(getUpdateCheckFile(), JSON.stringify(state, null, 2));
  } catch {
    /* ignore */
  }
}

export function shouldCheckForUpdate(): boolean {
  if (!isAutoUpdateEnabled()) return false;
  const state = readCheckState();
  const interval = getUpdateCheckInterval();
  return Date.now() - state.lastCheck >= interval;
}

// ─── Manifest fetch + parse ─────────────────────────────────────

async function fetchManifest(): Promise<Manifest | null> {
  try {
    const resp = await fetch(getManifestUrl(), {
      headers: { "User-Agent": "KCode-AutoUpdate" },
      signal: AbortSignal.timeout(10_000),
      // Bypass intermediate caches so a fresh release is visible
      // immediately after publish.
      cache: "no-cache",
    });

    if (!resp.ok) {
      log.debug("auto-update", `Manifest returned ${resp.status}`);
      return null;
    }

    const data = (await resp.json()) as Manifest;
    if (!data || typeof data.latest !== "string" || !data.platforms) {
      log.debug("auto-update", "Manifest shape invalid");
      return null;
    }
    return data;
  } catch (err) {
    log.debug("auto-update", `Failed to fetch manifest: ${err}`);
    return null;
  }
}

/**
 * Resolve the version this client should consider "latest" given the
 * channel. `beta` falls back to `stable` if the manifest doesn't
 * advertise a beta channel.
 */
function resolveChannelVersion(m: Manifest, channel: "stable" | "beta"): string {
  if (channel === "beta" && m.channels?.beta) return m.channels.beta;
  if (m.channels?.stable) return m.channels.stable;
  return m.latest;
}

// ─── checkForUpdate ─────────────────────────────────────────────

export async function checkForUpdate(
  currentVersion: string,
  opts: { channel?: "stable" | "beta" } = {},
): Promise<UpdateInfo> {
  const channel: "stable" | "beta" = opts.channel ?? "stable";
  const base: UpdateInfo = {
    currentVersion,
    latestVersion: currentVersion,
    updateAvailable: false,
    channel,
  };

  const manifest = await fetchManifest();
  if (!manifest) return base;

  const latestVersion = resolveChannelVersion(manifest, channel);
  const releaseUrl = manifest.release_notes;

  await writeCheckState({
    lastCheck: Date.now(),
    lastVersion: latestVersion,
    releaseUrl,
    releaseNotes: undefined,
    publishedAt: manifest.released_at,
  });

  if (compareSemver(latestVersion, currentVersion) <= 0) {
    return { ...base, latestVersion, releaseUrl, publishedAt: manifest.released_at };
  }

  // Resolve platform-specific binary. If the manifest advertises a newer
  // version that isn't built for this host yet, treat it as "no update"
  // — better than telling the user there's an update they can't install.
  const key = getPlatformKey();
  const plat = manifest.platforms[key];
  if (!plat) {
    log.warn("auto-update", `No binary for ${key} in manifest v${latestVersion}`);
    return { ...base, latestVersion, releaseUrl, publishedAt: manifest.released_at };
  }

  // Pick the delta from the user's current version if the manifest
  // advertises one. The delta is opportunistic — `downloadAndInstall`
  // will fall back to a full download whenever it isn't usable
  // (bspatch missing, current binary mismatched, network blip, etc.).
  const deltaForCurrent = plat.deltas?.[currentVersion];

  return {
    currentVersion,
    latestVersion,
    updateAvailable: true,
    channel,
    downloadUrl: plat.url,
    filename: plat.filename,
    sha256: plat.sha256,
    size: plat.size,
    releaseUrl,
    releaseNotes: releaseUrl,
    publishedAt: manifest.released_at,
    delta: deltaForCurrent
      ? {
          url: deltaForCurrent.url,
          sha256: deltaForCurrent.sha256,
          size: deltaForCurrent.size,
          from_sha256: deltaForCurrent.from_sha256,
        }
      : undefined,
  };
}

// ─── SHA256 ─────────────────────────────────────────────────────

async function computeSha256(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  hasher.update(new Uint8Array(buffer));
  return hasher.digest("hex");
}

// ─── Download & Install ────────────────────────────────────────

/**
 * Stream a URL to a temp file, optionally reporting progress, and verify
 * the resulting file's SHA256 matches the expected hash.
 *
 * Returns the temp path on success; throws (caller catches) on download,
 * write, or checksum failure. Cleans up its temp file on error.
 */
async function downloadVerified(opts: {
  url: string;
  expectedSha256: string;
  expectedSize?: number;
  tmpName: string;
  onProgress?: (pct: number) => void;
}): Promise<string> {
  const { url, expectedSha256, expectedSize, tmpName, onProgress } = opts;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(300_000),
    headers: { "User-Agent": "KCode-AutoUpdate" },
    redirect: "follow",
  });
  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }

  const totalSize =
    expectedSize && expectedSize > 0
      ? expectedSize
      : parseInt(resp.headers.get("content-length") ?? "0", 10);
  const tmpDir = require("node:os").tmpdir();
  const tmpPath = join(tmpDir, tmpName);

  const writer = Bun.file(tmpPath).writer();
  let downloaded = 0;

  try {
    for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
      writer.write(chunk);
      downloaded += chunk.length;
      if (onProgress && totalSize > 0) {
        onProgress(Math.round((downloaded / totalSize) * 100));
      }
    }
    await writer.end();
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  const actual = await computeSha256(tmpPath);
  if (actual !== expectedSha256) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw new Error(`Checksum mismatch. Expected: ${expectedSha256}, Got: ${actual}`);
  }
  return tmpPath;
}

/**
 * Returns true if `bspatch` is available on PATH. We don't ship it
 * bundled — it's a tiny utility (`apt install bsdiff` /
 * `brew install bsdiff`) and the delta path is opportunistic anyway.
 */
function isBspatchAvailable(): boolean {
  try {
    execSync("command -v bspatch >/dev/null 2>&1", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a unique temp-file token for this update run. PID alone is
 * predictable on systems that recycle PIDs quickly, which opens a
 * window for an attacker who can write to /tmp to swap the file
 * between SHA256 verification and chmod/rename. The random suffix
 * adds 36-bit entropy; combined with the PID it's effectively
 * unguessable for the few seconds the file lives.
 * v2.10.367.
 */
function tmpToken(): string {
  return `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Try the delta-update path. Returns the temp path of a freshly-built
 * target binary on success, or null on any failure (caller falls back
 * to a full download).
 *
 * Failure modes that yield null (not an error):
 *   - bspatch is not installed
 *   - Current binary's SHA256 doesn't match the delta's `from_sha256`
 *   - Patch download fails or fails its own SHA256
 *   - bspatch exits non-zero
 *   - Result binary's SHA256 doesn't match the manifest's target hash
 */
async function tryApplyDelta(
  info: UpdateInfo,
  onProgress?: (pct: number) => void,
): Promise<string | null> {
  if (!info.delta || !info.sha256) return null;
  if (!isBspatchAvailable()) {
    log.debug("auto-update", "bspatch not on PATH, skipping delta path");
    return null;
  }

  // Locate the user's current binary so we can compute its SHA256 and
  // feed it to bspatch. If we can't find one, the user is running from
  // a non-standard location (e.g. straight off `bun run`) — full
  // download still makes sense.
  const binaryPaths = findBinaryPaths();
  const currentBinary = binaryPaths.find((p) => existsSync(p));
  if (!currentBinary) {
    log.debug("auto-update", "No current binary to patch against, skipping delta");
    return null;
  }

  const currentSha = await computeSha256(currentBinary);
  if (currentSha !== info.delta.from_sha256) {
    log.info(
      "auto-update",
      `Current binary SHA mismatch (have ${currentSha.slice(0, 12)}…, ` +
        `delta expects ${info.delta.from_sha256.slice(0, 12)}…). ` +
        `Falling back to full download.`,
    );
    return null;
  }

  const tmpDir = require("node:os").tmpdir();
  let patchPath: string;
  const token = tmpToken();
  try {
    patchPath = await downloadVerified({
      url: info.delta.url,
      expectedSha256: info.delta.sha256,
      expectedSize: info.delta.size,
      tmpName: `kcode-update-${token}.bsdiff`,
      onProgress,
    });
  } catch (err) {
    log.warn("auto-update", `Delta download failed: ${err}. Falling back to full.`);
    return null;
  }

  const outPath = join(tmpDir, `kcode-update-${token}`);
  try {
    // bspatch <oldfile> <newfile> <patchfile>
    execSync(
      `bspatch ${JSON.stringify(currentBinary)} ${JSON.stringify(outPath)} ${JSON.stringify(patchPath)}`,
      { stdio: "pipe", timeout: 120_000 },
    );
  } catch (err) {
    log.warn("auto-update", `bspatch failed: ${err}. Falling back to full.`);
    try { unlinkSync(patchPath); } catch { /* ignore */ }
    try { unlinkSync(outPath); } catch { /* ignore */ }
    return null;
  }

  // bspatch succeeded — verify the result is the binary the manifest
  // promised. If this fails the patch was tampered with or applied to
  // the wrong source despite the from_sha256 check passing.
  const resultSha = await computeSha256(outPath);
  if (resultSha !== info.sha256) {
    log.warn(
      "auto-update",
      `Patched binary SHA mismatch (${resultSha.slice(0, 12)}… vs ${info.sha256.slice(0, 12)}…). Falling back to full.`,
    );
    try { unlinkSync(patchPath); } catch { /* ignore */ }
    try { unlinkSync(outPath); } catch { /* ignore */ }
    return null;
  }

  try { unlinkSync(patchPath); } catch { /* ignore */ }
  log.info(
    "auto-update",
    `Delta applied: ${(info.delta.size / 1024 / 1024).toFixed(1)} MB patch ` +
      `vs ${((info.size ?? 0) / 1024 / 1024).toFixed(1)} MB full ` +
      `(saved ~${Math.round((1 - info.delta.size / Math.max(1, info.size ?? 1)) * 100)}%)`,
  );
  return outPath;
}

export async function downloadAndInstall(
  info: UpdateInfo,
  onProgress?: (pct: number) => void,
): Promise<UpdateResult> {
  const result: UpdateResult = {
    success: false,
    previousVersion: info.currentVersion,
    newVersion: info.latestVersion,
  };

  if (!info.updateAvailable || !info.downloadUrl || !info.sha256) {
    result.error = "No update available or manifest missing platform entry.";
    return result;
  }

  try {
    let tmpPath: string | null = await tryApplyDelta(info, onProgress);

    if (!tmpPath) {
      try {
        tmpPath = await downloadVerified({
          url: info.downloadUrl,
          expectedSha256: info.sha256,
          expectedSize: info.size,
          tmpName: `kcode-update-${tmpToken()}`,
          onProgress,
        });
      } catch (err) {
        result.error = err instanceof Error ? err.message : "Download failed";
        return result;
      }
    }
    log.info("auto-update", "SHA256 verified.");

    chmodSync(tmpPath, 0o755);

    const binaryPaths = findBinaryPaths();
    if (binaryPaths.length === 0) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      result.error = "Could not find KCode binary path to replace.";
      return result;
    }

    const destPath = binaryPaths[0]!;

    // Backup current binary so `kcode update --rollback` can restore it.
    // Stored at ~/.kcode/previous-kcode — same fs as $HOME so rename is
    // atomic on every common Linux layout.
    const rollbackPath = getRollbackBinaryPath();
    try {
      const dir = kcodePath();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      if (existsSync(destPath)) {
        // Prefer copy (preserves the running binary on disk) over rename
        // so an in-flight execution doesn't lose its image.
        copyFileSync(destPath, rollbackPath);
      }
    } catch (err) {
      log.warn("auto-update", `Could not back up to ${rollbackPath}: ${err}`);
    }

    const sidecarBackup = `${destPath}.old`;
    try {
      if (existsSync(destPath)) {
        renameSync(destPath, sidecarBackup);
      }
      // tmpfs /tmp → ~/.local/bin crosses filesystems on most distros
      // and yields EXDEV. Fall back to copy+unlink.
      try {
        renameSync(tmpPath, destPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          copyFileSync(tmpPath, destPath);
          try { unlinkSync(tmpPath); } catch { /* ignore */ }
        } else {
          throw err;
        }
      }
      try { unlinkSync(sidecarBackup); } catch { /* may be in use */ }
    } catch (err) {
      try {
        if (existsSync(sidecarBackup)) renameSync(sidecarBackup, destPath);
      } catch { /* best effort */ }
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      result.error = err instanceof Error ? err.message : "Binary replacement failed";
      return result;
    }

    // Mirror to other known install locations so a user with both
    // ~/.local/bin/kcode and ~/.bun/bin/kcode doesn't end up half-updated.
    for (let i = 1; i < binaryPaths.length; i++) {
      try {
        copyFileSync(destPath, binaryPaths[i]!);
        chmodSync(binaryPaths[i]!, 0o755);
      } catch (err) {
        log.warn("auto-update", `Failed to copy to ${binaryPaths[i]}: ${err}`);
      }
    }

    log.info("auto-update", `Updated from ${info.currentVersion} to ${info.latestVersion}`);
    result.success = true;
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : "Unknown error during update";
    log.error("auto-update", "Update failed", err);
    return result;
  }
}

// ─── Rollback ──────────────────────────────────────────────────

/**
 * Restore the previously-installed binary from ~/.kcode/previous-kcode.
 * Returns false if no rollback is available.
 */
export async function rollback(): Promise<{ success: boolean; error?: string }> {
  const rollbackPath = getRollbackBinaryPath();
  if (!existsSync(rollbackPath)) {
    return { success: false, error: "No previous binary to roll back to." };
  }

  const binaryPaths = findBinaryPaths();
  if (binaryPaths.length === 0) {
    return { success: false, error: "Could not locate KCode binary to replace." };
  }
  const destPath = binaryPaths[0]!;

  try {
    const sidecarBackup = `${destPath}.failed`;
    if (existsSync(destPath)) {
      renameSync(destPath, sidecarBackup);
    }
    try {
      copyFileSync(rollbackPath, destPath);
      chmodSync(destPath, 0o755);
    } catch (err) {
      try {
        if (existsSync(sidecarBackup)) renameSync(sidecarBackup, destPath);
      } catch { /* best effort */ }
      throw err;
    }
    try { unlinkSync(sidecarBackup); } catch { /* may be in use */ }

    for (let i = 1; i < binaryPaths.length; i++) {
      try {
        copyFileSync(destPath, binaryPaths[i]!);
        chmodSync(binaryPaths[i]!, 0o755);
      } catch (err) {
        log.warn("auto-update", `Failed to mirror rollback to ${binaryPaths[i]}: ${err}`);
      }
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Rollback failed",
    };
  }
}

export function hasRollbackAvailable(): boolean {
  return existsSync(getRollbackBinaryPath());
}

// ─── Update Notification ──────────────────────────────────────

export async function getUpdateNotification(currentVersion: string): Promise<string | null> {
  const state = readCheckState();

  if (state.lastCheck > 0 && Date.now() - state.lastCheck < NOTIFICATION_CHECK_INTERVAL_MS) {
    if (state.lastVersion && compareSemver(state.lastVersion, currentVersion) > 0) {
      return formatNotification(currentVersion, state.lastVersion, state.releaseUrl);
    }
    return null;
  }

  const info = await checkForUpdate(currentVersion);
  if (info.updateAvailable) {
    return formatNotification(info.currentVersion, info.latestVersion, info.releaseUrl);
  }
  return null;
}

function formatNotification(
  currentVersion: string,
  latestVersion: string,
  releaseUrl?: string,
): string {
  let msg = `Update available: ${currentVersion} -> ${latestVersion}`;
  msg += "\nRun 'kcode update' to install the latest version.";
  if (releaseUrl) {
    msg += `\nRelease notes: ${releaseUrl}`;
  }
  return msg;
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
  } catch {
    /* not in PATH */
  }

  for (const p of candidates) {
    if (existsSync(p)) paths.push(p);
  }

  if (paths.length === 0) {
    paths.push(join(homedir(), ".local", "bin", "kcode"));
  }
  return paths;
}
