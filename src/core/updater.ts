// KCode - Self-Updater
// Checks for new versions and self-updates the binary.
// Downloads from GitHub releases or a configured update URL.

import { execSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./logger";
import { kcodePath } from "./paths";

// ─── Constants ───────────────────────────────────────────────────

const GITHUB_REPO = "AstrolexisAI/KCode";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const UPDATE_CHECK_FILE = kcodePath("last-update-check");

// ─── Types ──────────────────────────────────────────────────────

interface ReleaseInfo {
  tag: string;
  version: string;
  downloadUrl: string;
  publishedAt: string;
}

// ─── Version Comparison ─────────────────────────────────────────

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b
 *   0 if a == b
 *   1 if a > b
 */
function compareSemver(a: string, b: string): number {
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

function getPlatformSuffix(): string {
  const os = platform();
  const cpu = arch();

  if (os === "linux" && cpu === "x64") return "linux-x64";
  if (os === "linux" && cpu === "arm64") return "linux-arm64";
  if (os === "darwin" && cpu === "x64") return "macos-x64";
  if (os === "darwin" && cpu === "arm64") return "macos-arm64";
  if (os === "win32" && cpu === "x64") return "windows-x64.exe";

  throw new Error(`Unsupported platform: ${os}-${cpu}`);
}

// ─── GitHub Release Check ───────────────────────────────────────

async function getLatestRelease(updateUrl?: string): Promise<ReleaseInfo | null> {
  try {
    const url = updateUrl ?? `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "KCode-Updater" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) return null;

    interface ReleaseAsset {
      name: string;
      browser_download_url: string;
    }
    interface ReleaseData {
      tag_name?: string;
      version?: string;
      assets?: ReleaseAsset[];
      published_at?: string;
    }
    const data = (await resp.json()) as ReleaseData;
    const tag = data.tag_name ?? data.version ?? "";
    const version = tag.replace(/^v/, "");

    const suffix = getPlatformSuffix();
    const asset = data.assets?.find((a) => a.name.includes(suffix));

    if (!asset) {
      log.warn("updater", `No binary found for ${suffix} in release ${tag}`);
      return null;
    }

    return {
      tag,
      version,
      downloadUrl: asset.browser_download_url,
      publishedAt: data.published_at ?? "",
    };
  } catch (err) {
    log.debug("updater", `Failed to check for updates: ${err}`);
    return null;
  }
}

// ─── Download & Replace ─────────────────────────────────────────

async function downloadBinary(url: string, destPath: string): Promise<void> {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(300_000), // 5 minutes
    headers: { "User-Agent": "KCode-Updater" },
    redirect: "follow",
  });

  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }

  const totalSize = parseInt(resp.headers.get("content-length") ?? "0", 10);
  const tmpPath = destPath + ".tmp";

  // Stream to temp file
  const writer = Bun.file(tmpPath).writer();
  let downloaded = 0;

  for await (const chunk of resp.body as AsyncIterable<Uint8Array>) {
    writer.write(chunk);
    downloaded += chunk.length;

    if (totalSize > 0) {
      const pct = Math.round((downloaded / totalSize) * 100);
      process.stderr.write(
        `\r  Downloading... ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`,
      );
    }
  }

  await writer.end();
  process.stderr.write("\r" + " ".repeat(60) + "\r");

  // Make executable
  chmodSync(tmpPath, 0o755);

  // Atomic replace: rename tmp → dest
  // On Linux, we can rename even while the binary is running
  const backupPath = destPath + ".old";
  try {
    if (existsSync(destPath)) {
      renameSync(destPath, backupPath);
    }
    renameSync(tmpPath, destPath);
    // Clean up backup
    try {
      unlinkSync(backupPath);
    } catch {
      /* may be in use */
    }
  } catch (err) {
    // Restore backup if rename failed
    try {
      if (existsSync(backupPath)) {
        renameSync(backupPath, destPath);
      }
    } catch {
      /* best effort */
    }
    throw err;
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Check for updates and show a notice if one is available.
 * Non-blocking, safe to call at startup.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  // Throttle: only check once per 24 hours
  try {
    if (existsSync(UPDATE_CHECK_FILE)) {
      const lastCheck = parseInt(readFileSync(UPDATE_CHECK_FILE, "utf-8"), 10);
      if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) {
        return null;
      }
    }
  } catch {
    /* ignore */
  }

  const release = await getLatestRelease();

  // Save check timestamp
  try {
    await Bun.write(UPDATE_CHECK_FILE, Date.now().toString());
  } catch {
    /* ignore */
  }

  if (!release) return null;

  if (compareSemver(release.version, currentVersion) > 0) {
    return release.version;
  }

  return null;
}

/**
 * Perform a full self-update.
 * Downloads the latest release and replaces the current binary.
 */
export async function performUpdate(
  currentVersion: string,
  updateUrl?: string,
): Promise<{ updated: boolean; version?: string; error?: string }> {
  console.log("Checking for updates...\n");

  const release = await getLatestRelease(updateUrl);

  if (!release) {
    return { updated: false, error: "Could not reach update server." };
  }

  if (compareSemver(release.version, currentVersion) <= 0) {
    console.log(`Already on latest version (v${currentVersion}).`);
    return { updated: false };
  }

  console.log(`  Current: v${currentVersion}`);
  console.log(
    `  Latest:  v${release.version} (${release.publishedAt?.split("T")[0] ?? "unknown"})`,
  );
  console.log();

  // Find all binary locations to update
  const binaryPaths = findBinaryPaths();
  if (binaryPaths.length === 0) {
    return { updated: false, error: "Could not find KCode binary path." };
  }

  console.log(`  Downloading v${release.version}...`);

  try {
    // Download to first path
    await downloadBinary(release.downloadUrl, binaryPaths[0]!);

    // Copy to other paths
    for (let i = 1; i < binaryPaths.length; i++) {
      try {
        copyFileSync(binaryPaths[0]!, binaryPaths[i]!);
        chmodSync(binaryPaths[i]!, 0o755);
      } catch (err) {
        log.warn("updater", `Failed to copy to ${binaryPaths[i]}: ${err}`);
      }
    }

    console.log(`\n\x1b[32m✓\x1b[0m Updated to v${release.version}`);
    console.log(`  Updated: ${binaryPaths.join(", ")}`);
    console.log(`\n  Restart KCode to use the new version.`);

    // Save check timestamp
    try {
      await Bun.write(UPDATE_CHECK_FILE, Date.now().toString());
    } catch {
      /* ignore */
    }

    return { updated: true, version: release.version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { updated: false, error: `Download failed: ${msg}` };
  }
}

/**
 * Find all paths where the kcode binary is installed.
 */
function findBinaryPaths(): string[] {
  const paths: string[] = [];
  const candidates = [
    join(homedir(), ".local", "bin", "kcode"),
    join(homedir(), ".bun", "bin", "kcode"),
    "/usr/local/bin/kcode",
  ];

  // Also check the currently running binary
  try {
    const which = execSync("which kcode 2>/dev/null", { stdio: "pipe" }).toString().trim();
    if (which && !candidates.includes(which)) {
      candidates.unshift(which);
    }
  } catch {
    /* not in PATH */
  }

  for (const p of candidates) {
    if (existsSync(p)) {
      paths.push(p);
    }
  }

  // If no existing binary found, default to ~/.local/bin/kcode
  if (paths.length === 0) {
    paths.push(join(homedir(), ".local", "bin", "kcode"));
  }

  return paths;
}
