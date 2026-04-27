#!/usr/bin/env bun
// KCode - Cross-platform release builder
// Builds standalone binaries for Linux, macOS, and Windows
//
// Usage:
//   bun run scripts/release.ts              # Build all platforms
//   bun run scripts/release.ts --linux      # Linux only
//   bun run scripts/release.ts --macos      # macOS only
//   bun run scripts/release.ts --windows    # Windows only

import { join } from "node:path";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import pkg from "../package.json";

const ENTRY = "src/index.ts";
const RELEASE_DIR = "release";
const VERSION = pkg.version;

interface Target {
  name: string;
  target: string;
  outFile: string;
  flag: string;
  windowsOpts?: string[];
}

const TARGETS: Target[] = [
  {
    name: "Linux x64",
    target: "bun-linux-x64",
    outFile: `kcode-${VERSION}-linux-x64`,
    flag: "--linux",
  },
  {
    name: "Linux ARM64",
    target: "bun-linux-arm64",
    outFile: `kcode-${VERSION}-linux-arm64`,
    flag: "--linux",
  },
  {
    name: "macOS x64 (Intel)",
    target: "bun-darwin-x64",
    outFile: `kcode-${VERSION}-macos-x64`,
    flag: "--macos",
  },
  {
    name: "macOS ARM64 (Apple Silicon)",
    target: "bun-darwin-arm64",
    outFile: `kcode-${VERSION}-macos-arm64`,
    flag: "--macos",
  },
  {
    name: "Windows x64",
    target: "bun-windows-x64",
    outFile: `kcode-${VERSION}-windows-x64.exe`,
    flag: "--windows",
    // --windows-* flags only work when compiling ON Windows natively
    // When building on Windows, add: --windows-hide-console --windows-title=KCode etc.
  },
];

async function buildTarget(t: Target): Promise<{ ok: boolean; size: string; time: string }> {
  const outPath = join(RELEASE_DIR, t.outFile);
  const start = performance.now();

  try {
    const args = [
      "build", ENTRY,
      "--compile",
      "--minify",
      "--sourcemap=none",
      `--target=${t.target}`,
      `--outfile=${outPath}`,
      ...(t.windowsOpts ?? []),
    ];

    const bunBin = process.execPath; // use the same bun that's running this script
    const proc = Bun.spawnSync([bunBin, ...args], { stdout: "pipe", stderr: "pipe" });

    if (proc.exitCode !== 0) {
      const err = proc.stderr.toString().trim();
      console.error(`    FAILED: ${err.slice(0, 200)}`);
      return { ok: false, size: "-", time: "-" };
    }

    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    const file = Bun.file(outPath);
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);

    return { ok: true, size: `${sizeMB} MB`, time: `${elapsed}s` };
  } catch (err) {
    console.error(`    ERROR: ${err}`);
    return { ok: false, size: "-", time: "-" };
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const buildAll = args.size === 0;

  // Filter targets based on flags
  const targets = TARGETS.filter((t) => {
    if (buildAll) return true;
    return args.has(t.flag);
  });

  if (targets.length === 0) {
    console.log("Usage: bun run scripts/release.ts [--linux] [--macos] [--windows]");
    process.exit(1);
  }

  // Ensure release directory exists
  if (!existsSync(RELEASE_DIR)) mkdirSync(RELEASE_DIR, { recursive: true });

  console.log(`\nKCode v${VERSION} — Release Build`);
  console.log(`Building ${targets.length} target(s)...\n`);

  const results: { name: string; ok: boolean; size: string; time: string }[] = [];

  for (const t of targets) {
    process.stdout.write(`  ${t.name.padEnd(28)} `);
    const result = await buildTarget(t);
    results.push({ name: t.name, ...result });
    if (result.ok) {
      console.log(`${result.size.padStart(8)}  ${result.time.padStart(6)}`);
    }
  }

  // Summary
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  console.log(`\nDone: ${passed} built${failed > 0 ? `, ${failed} failed` : ""}`);
  console.log(`Output: ${RELEASE_DIR}/\n`);

  // List files
  const proc = Bun.spawnSync(["ls", "-lh", RELEASE_DIR], { stdout: "pipe" });
  console.log(proc.stdout.toString());

  if (failed > 0) process.exit(1);

  // v2.10.358 — generate latest.json manifest consumed by `kcode update`.
  // Computes SHA256 + size for each successfully-built binary, emits a
  // single JSON document, and copies it to the kulvex.ai serving dir.
  // This is what the running CLI talks to when checking for updates.
  if (passed > 0 && buildAll) {
    await generateManifest(targets, results);
    // v2.10.384 — auto-publish to GitHub Releases page.
    // Self-hosted CDN above is the primary distribution path (auto-updater
    // talks to kulvex.ai). GitHub Releases is the secondary, manual-download
    // channel. Prior to v2.10.384 this was a manual `gh release create` +
    // `gh release upload` step that was easy to forget; v2.10.383 shipped
    // to the CDN but missed the GitHub release until the user noticed.
    // The publish.yml workflow exists but Actions runners stay queued for
    // 1+ hr on free tier, so we publish from this machine via the gh CLI.
    await publishToGitHub(targets, results);
  } else if (!buildAll) {
    console.log("(manifest skipped — partial build)\n");
  }
}

/**
 * Map our internal target names to the platform keys the CLI sends
 * when querying the manifest. The CLI computes its key from
 * `${process.platform}-${process.arch}`, so we mirror that exactly.
 */
const TARGET_TO_PLATFORM_KEY: Record<string, string> = {
  "Linux x64": "linux-x64",
  "Linux ARM64": "linux-arm64",
  "macOS x64 (Intel)": "darwin-x64",
  "macOS ARM64 (Apple Silicon)": "darwin-arm64",
  "Windows x64": "win32-x64",
};

interface ManifestDelta {
  url: string;
  sha256: string;
  size: number;
  from_sha256: string;
}

interface ManifestPlatform {
  url: string;
  filename: string;
  sha256: string;
  size: number;
  deltas?: Record<string, ManifestDelta>;
}

interface Manifest {
  schema_version: 1;
  latest: string;
  released_at: string;
  channels: { stable: string; beta?: string };
  platforms: Record<string, ManifestPlatform>;
  release_notes: string;
}

// How many previous releases to generate per-platform deltas against.
// Three is enough for "I'm upgrading to a release published this month
// without a fresh install" while keeping the per-release CDN write
// budget bounded (3 platforms × 3 deltas = 9 patches per release in the
// common case).
const DELTA_HISTORY = 3;

async function sha256(filePath: string): Promise<string> {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Returns true if the `bsdiff` CLI is on PATH. Delta generation is
 * opportunistic — if the host doesn't have bsdiff installed we just
 * skip patches and the client falls back to full downloads.
 */
function isBsdiffAvailable(): boolean {
  try {
    execSync("command -v bsdiff >/dev/null 2>&1", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find prior release binaries for `platformSuffix` in the CDN dir,
 * sorted newest-first, excluding the current version. We use the
 * filename format `kcode-X.Y.Z-<suffix>` that release.ts has always
 * emitted. Returns up to `limit` entries.
 */
function findPriorBinaries(
  cdnDir: string,
  platformSuffix: string,
  limit: number,
): Array<{ version: string; path: string }> {
  if (!existsSync(cdnDir)) return [];
  const prefix = "kcode-";
  const results: Array<{ version: string; path: string }> = [];

  for (const name of readdirSync(cdnDir)) {
    if (!name.startsWith(prefix)) continue;
    if (!name.endsWith(`-${platformSuffix}`)) continue;
    if (name.includes(".bsdiff")) continue;
    if (name.endsWith(".sha256")) continue;
    if (name.endsWith(".tar.gz")) continue;
    // kcode-<version>-<suffix>
    const middle = name.slice(prefix.length, name.length - `-${platformSuffix}`.length);
    if (!/^\d+\.\d+\.\d+/.test(middle)) continue;
    if (middle === VERSION) continue;
    results.push({ version: middle, path: join(cdnDir, name) });
  }

  // Newest-first: simple lexicographic sort works because we always
  // pad to N.N.N (no missing parts in our release tags).
  results.sort((a, b) => semverCompareDesc(a.version, b.version));
  return results.slice(0, limit);
}

function semverCompareDesc(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return nb - na; // descending
  }
  return 0;
}

/**
 * Generate a bsdiff patch from `oldPath` → `newPath` written to
 * `outPath`. Returns the patch's size on success or null on failure.
 */
function generatePatch(oldPath: string, newPath: string, outPath: string): number | null {
  try {
    execSync(
      `bsdiff ${JSON.stringify(oldPath)} ${JSON.stringify(newPath)} ${JSON.stringify(outPath)}`,
      { stdio: "pipe", timeout: 600_000 }, // bsdiff is CPU-heavy; 10 min cap
    );
    if (!existsSync(outPath)) return null;
    return statSync(outPath).size;
  } catch (err) {
    console.log(`    bsdiff failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * For each freshly-built target, generate deltas against the last
 * DELTA_HISTORY prior releases that exist on the CDN. Returns a
 * platform-keyed map of deltas to merge into the manifest.
 */
async function generateDeltas(
  passedTargets: Target[],
  cdnDir: string,
): Promise<Record<string, Record<string, ManifestDelta>>> {
  if (!isBsdiffAvailable()) {
    console.log("\nbsdiff not on PATH — skipping delta generation.");
    console.log("  Install: dnf install bsdiff (Fedora) / brew install bsdiff (macOS)\n");
    return {};
  }
  if (!existsSync(cdnDir)) {
    console.log(`\nCDN dir ${cdnDir} not found — skipping delta generation.\n`);
    return {};
  }

  console.log("\nGenerating binary deltas...");

  const out: Record<string, Record<string, ManifestDelta>> = {};
  for (const t of passedTargets) {
    const platformKey = TARGET_TO_PLATFORM_KEY[t.name];
    if (!platformKey) continue;

    const newBinaryPath = join(RELEASE_DIR, t.outFile);
    if (!existsSync(newBinaryPath)) continue;

    // The platformSuffix in the filename is the legacy form
    // (linux-x64, macos-arm64, windows-x64.exe) — derive it from the
    // outFile pattern which already encodes it.
    const filenameSuffix = t.outFile.slice(`kcode-${VERSION}-`.length);
    const priors = findPriorBinaries(cdnDir, filenameSuffix, DELTA_HISTORY);
    if (priors.length === 0) {
      console.log(`  ${t.name.padEnd(28)} no prior releases on CDN`);
      continue;
    }

    const deltasForPlatform: Record<string, ManifestDelta> = {};
    for (const prior of priors) {
      const patchName = `kcode-${prior.version}-to-${VERSION}-${filenameSuffix}.bsdiff`;
      const patchPath = join(RELEASE_DIR, patchName);
      process.stdout.write(`  ${t.name.padEnd(28)} ${prior.version} → ${VERSION}  `);
      const start = performance.now();
      const patchSize = generatePatch(prior.path, newBinaryPath, patchPath);
      if (patchSize === null) continue;

      const elapsed = ((performance.now() - start) / 1000).toFixed(1);
      const fromSha = await sha256(prior.path);
      const patchSha = await sha256(patchPath);
      const newSize = statSync(newBinaryPath).size;
      const ratio = ((patchSize / newSize) * 100).toFixed(1);

      deltasForPlatform[prior.version] = {
        url: `https://kulvex.ai/downloads/kcode/${patchName}`,
        sha256: patchSha,
        size: patchSize,
        from_sha256: fromSha,
      };
      console.log(`${(patchSize / 1024 / 1024).toFixed(1).padStart(6)} MB  (${ratio}%)  ${elapsed}s`);

      // Mirror the patch to the CDN dir alongside the binaries.
      try {
        copyFileSync(patchPath, join(cdnDir, patchName));
      } catch (err) {
        console.log(`    (copy to CDN dir failed: ${(err as Error).message})`);
      }
    }

    if (Object.keys(deltasForPlatform).length > 0) {
      out[platformKey] = deltasForPlatform;
    }
  }
  console.log();
  return out;
}

async function generateManifest(
  targets: Target[],
  results: Array<{ name: string; ok: boolean }>,
): Promise<void> {
  const passedTargets = targets.filter((t) =>
    results.some((r) => r.name === t.name && r.ok),
  );

  const cdnDir = join(homedir(), "kulvex-models", "kcode");
  // Generate deltas before building the platforms map so we can attach
  // them in the same shot. Failures here just yield an empty map and
  // the manifest still ships full-download links.
  const deltasByPlatform = await generateDeltas(passedTargets, cdnDir);

  const platforms: Record<string, ManifestPlatform> = {};
  const mirrorFailures: string[] = [];
  for (const t of passedTargets) {
    const key = TARGET_TO_PLATFORM_KEY[t.name];
    if (!key) {
      console.log(`  (skipping ${t.name} — no platform key mapping)`);
      continue;
    }
    const filePath = join(RELEASE_DIR, t.outFile);
    if (!existsSync(filePath)) continue;
    const stat = statSync(filePath);
    const hash = await sha256(filePath);
    platforms[key] = {
      url: `https://kulvex.ai/downloads/kcode/${t.outFile}`,
      filename: t.outFile,
      sha256: hash,
      size: stat.size,
      ...(deltasByPlatform[key] && Object.keys(deltasByPlatform[key]).length > 0
        ? { deltas: deltasByPlatform[key] }
        : {}),
    };

    // v2.10.371 — copy the full binary to the CDN dir alongside the
    // manifest. Latent bug fix: prior versions of this script wrote
    // the manifest with kulvex.ai URLs but never published the actual
    // binary to that path, so a fresh user who couldn't apply a delta
    // got a 404 on the full download. The deltas worked because
    // generateDeltas() already mirrored its own files. Now the full
    // binary goes through the same mirror so `kcode update` from any
    // starting state works without manual intervention.
    //
    // v2.10.372 — fail-closed. If any binary copy fails we abort
    // the manifest write entirely; publishing a manifest that
    // points at 404s is exactly the bug v2.10.371 was fixing.
    if (existsSync(cdnDir)) {
      try {
        copyFileSync(filePath, join(cdnDir, t.outFile));
      } catch (err) {
        const msg = `${t.outFile}: ${(err as Error).message}`;
        console.log(`  (mirror to CDN failed for ${msg})`);
        mirrorFailures.push(msg);
      }
    }
  }

  if (mirrorFailures.length > 0) {
    console.error(`\nABORTING manifest write — ${mirrorFailures.length} binary copy failure(s):`);
    for (const f of mirrorFailures) console.error(`  ${f}`);
    console.error("Resolve the failures and re-run. The manifest was NOT updated; existing");
    console.error("clients on prior versions are unaffected.");
    process.exit(2);
  }

  const manifest: Manifest = {
    schema_version: 1,
    latest: VERSION,
    released_at: new Date().toISOString(),
    channels: { stable: VERSION },
    platforms,
    release_notes: `https://github.com/AstrolexisAI/KCode/releases/tag/v${VERSION}`,
  };

  // Write to release/ for the local diff record + push to kulvex serving.
  const localPath = join(RELEASE_DIR, "latest.json");
  writeFileSync(localPath, JSON.stringify(manifest, null, 2));

  // Mirror to /home/curly/kulvex-models/kcode/ which Cloudflare serves
  // at https://kulvex.ai/kcode/latest.json (and where the binaries
  // already live). cdnDir was computed earlier for delta generation.
  if (existsSync(cdnDir)) {
    const cdnPath = join(cdnDir, "latest.json");
    copyFileSync(localPath, cdnPath);
    console.log(`Manifest written:`);
    console.log(`  ${localPath}`);
    console.log(`  ${cdnPath}  (live)`);
  } else {
    console.log(`Manifest written: ${localPath}`);
    console.log(`  (CDN dir ${cdnDir} not found — copy manually)`);
  }
  console.log(`  ${Object.keys(platforms).length} platform(s), v${VERSION}\n`);
}

// ─── GitHub Release Publishing ──────────────────────────────────
//
// Publishes a GitHub Release with .tar.gz tarballs for the 4 unix-shaped
// platforms (linux-x64, linux-arm64, darwin-x64, darwin-arm64). Windows
// is excluded to match the prior publish.yml workflow's matrix and keep
// the surface small — Windows users are served by the auto-updater.
//
// Skip conditions (each prints a clear note and returns):
//   - KCODE_SKIP_GH_RELEASE=1 in env
//   - gh CLI not on PATH
//   - gh auth status non-zero (not logged in)
//   - git working tree dirty (would tag against unstable state)
//   - release notes generation fails (no commits since prior tag)
//
// The manifest write above already happened, so the auto-updater is
// already live regardless of what this function does. A failure here
// is recoverable by re-running release.ts (idempotent: existing tag /
// release are reused via --clobber).

const GH_RELEASE_TARGETS: Array<{ stagingSuffix: string; releaseName: string }> = [
  { stagingSuffix: "linux-x64", releaseName: "linux-x64" },
  { stagingSuffix: "linux-arm64", releaseName: "linux-arm64" },
  { stagingSuffix: "macos-x64", releaseName: "darwin-x64" },
  { stagingSuffix: "macos-arm64", releaseName: "darwin-arm64" },
];

function shellOk(cmd: string, args: string[]): boolean {
  try {
    const r = Bun.spawnSync([cmd, ...args], { stdout: "ignore", stderr: "ignore" });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

function shellCapture(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = Bun.spawnSync([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    return {
      ok: r.exitCode === 0,
      stdout: r.stdout.toString().trim(),
      stderr: r.stderr.toString().trim(),
    };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err) };
  }
}

/** True if the working tree has uncommitted changes (excluding untracked). */
function isWorkingTreeDirty(): boolean {
  const r = shellCapture("git", ["status", "--porcelain", "--untracked-files=no"]);
  return r.ok && r.stdout.length > 0;
}

/** True if the git tag already exists locally OR on origin. */
function tagExists(tag: string): { local: boolean; remote: boolean } {
  const local = shellOk("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
  // ls-remote returns 0 even if no match — check stdout for the tag ref
  const remote = shellCapture("git", ["ls-remote", "--tags", "origin", tag]);
  return { local, remote: remote.ok && remote.stdout.includes(tag) };
}

/** True if a GitHub release with this tag already exists. */
function releaseExists(tag: string): boolean {
  return shellOk("gh", ["release", "view", tag, "-R", "AstrolexisAI/KCode"]);
}

/** Find the most recent prior release tag in vX.Y.Z form. */
function findPriorTag(currentTag: string): string | null {
  const r = shellCapture("git", ["tag", "-l", "v*", "--sort=-v:refname"]);
  if (!r.ok) return null;
  for (const tag of r.stdout.split("\n").map((t) => t.trim()).filter(Boolean)) {
    if (tag === currentTag) continue;
    if (/^v\d+\.\d+\.\d+$/.test(tag)) return tag;
  }
  return null;
}

/** Build the release notes body. Uses release/notes-vX.Y.Z.md if present, otherwise falls back to commit log + delta size summary. */
function buildReleaseNotes(version: string): string {
  const overridePath = join(RELEASE_DIR, `notes-v${version}.md`);
  if (existsSync(overridePath)) {
    console.log(`  using release notes from ${overridePath}`);
    return readFileSync(overridePath, "utf-8");
  }

  const tag = `v${version}`;
  const priorTag = findPriorTag(tag);
  const commitsRange = priorTag ? `${priorTag}..HEAD` : "HEAD";

  const log = shellCapture("git", ["log", commitsRange, "--oneline", "--no-decorate"]);
  const lines = log.ok ? log.stdout.split("\n").filter(Boolean) : [];

  const out: string[] = [];
  out.push(`## What changed`);
  out.push("");
  if (lines.length === 0) {
    out.push("(no commits range available)");
  } else {
    for (const line of lines) out.push(`- ${line}`);
  }
  out.push("");
  out.push(`## Update`);
  out.push("");
  out.push("```");
  out.push("kcode update");
  out.push("```");
  out.push("");
  out.push("For 99% smaller downloads: `apt install bsdiff` / `brew install bsdiff` / `dnf install bsdiff`.");
  out.push("");
  out.push("---");
  out.push("");
  out.push("Co-Authored-By: Kulvex Code <contact@astrolexis.space>");
  return out.join("\n");
}

interface PackedAsset {
  tarballPath: string;
  shaPath: string;
  releaseName: string;
}

/** Pack each unix binary as kcode-VERSION-RELEASENAME.tar.gz with sha256 sidecar. Returns a list of packed asset paths. */
function packTarballs(targets: Target[], results: Array<{ name: string; ok: boolean }>): PackedAsset[] {
  const stagingDir = join(RELEASE_DIR, ".github-release-staging");
  if (!existsSync(stagingDir)) mkdirSync(stagingDir, { recursive: true });

  const out: PackedAsset[] = [];
  for (const map of GH_RELEASE_TARGETS) {
    const stagingFile = `kcode-${VERSION}-${map.stagingSuffix}`;
    const stagingPath = join(RELEASE_DIR, stagingFile);
    if (!existsSync(stagingPath)) {
      console.log(`  skip ${map.releaseName}: ${stagingFile} not built`);
      continue;
    }
    // Confirm that the corresponding target actually built successfully —
    // prevents packing a stale binary from a prior run.
    const targetMatch = targets.find((t) => t.outFile === stagingFile);
    const ok = targetMatch && results.find((r) => r.name === targetMatch.name)?.ok;
    if (!ok) {
      console.log(`  skip ${map.releaseName}: build failed or stale`);
      continue;
    }

    const tarballName = `kcode-${VERSION}-${map.releaseName}.tar.gz`;
    const shaName = `${tarballName}.sha256`;
    const tarballPath = join(stagingDir, tarballName);
    const shaPath = join(stagingDir, shaName);

    // Stage the binary as `kcode` so the tarball's contained name is
    // platform-agnostic and matches what install.sh extracts.
    const stagedKcode = join(stagingDir, "kcode");
    copyFileSync(stagingPath, stagedKcode);
    try {
      execSync(`chmod +x ${JSON.stringify(stagedKcode)}`);
    } catch {
      // chmod is best-effort; on systems where the tar already preserves perms it's redundant
    }

    const tarRes = shellCapture("tar", ["czf", tarballPath, "-C", stagingDir, "kcode"]);
    if (!tarRes.ok) {
      console.log(`  ✗ ${map.releaseName}: tar failed: ${tarRes.stderr.slice(0, 120)}`);
      continue;
    }

    // Cleanup the staged kcode so the next iteration packs cleanly
    try {
      execSync(`rm -f ${JSON.stringify(stagedKcode)}`);
    } catch {
      // non-fatal
    }

    // Compute SHA256 in the format `gh release download --pattern *.sha256` consumers expect:
    // "<hex>  <filename>"
    const hash = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
    writeFileSync(shaPath, `${hash}  ${tarballName}\n`);

    const sizeMB = (statSync(tarballPath).size / (1024 * 1024)).toFixed(1);
    console.log(`  ✓ ${map.releaseName.padEnd(14)} ${sizeMB.padStart(6)} MB`);
    out.push({ tarballPath, shaPath, releaseName: map.releaseName });
  }
  return out;
}

async function publishToGitHub(
  targets: Target[],
  results: Array<{ name: string; ok: boolean }>,
): Promise<void> {
  console.log("\nGitHub Release Publishing");

  // ─── Skip checks ───
  if (process.env.KCODE_SKIP_GH_RELEASE === "1") {
    console.log("  KCODE_SKIP_GH_RELEASE=1 — skipping.\n");
    return;
  }
  if (!shellOk("which", ["gh"])) {
    console.log("  gh CLI not on PATH — skipping. (Install from https://cli.github.com)\n");
    return;
  }
  if (!shellOk("gh", ["auth", "status"])) {
    console.log("  gh auth status non-zero — skipping. (Run `gh auth login` then re-run.)\n");
    return;
  }
  if (isWorkingTreeDirty()) {
    console.log("  working tree dirty — skipping tag/release. Commit changes and re-run.\n");
    return;
  }

  const tag = `v${VERSION}`;
  const tagState = tagExists(tag);

  // ─── Tag ───
  if (!tagState.local) {
    const r = shellCapture("git", ["tag", "-a", tag, "-m", `KCode ${tag}`]);
    if (!r.ok) {
      console.log(`  ✗ git tag failed: ${r.stderr.slice(0, 200)}`);
      console.log("  Manifest already live on CDN. Re-run release.ts to retry.\n");
      return;
    }
    console.log(`  ✓ created local tag ${tag}`);
  } else {
    console.log(`  · local tag ${tag} already exists`);
  }
  if (!tagState.remote) {
    const r = shellCapture("git", ["push", "origin", tag]);
    if (!r.ok) {
      console.log(`  ✗ git push tag failed: ${r.stderr.slice(0, 200)}`);
      console.log("  Manifest already live on CDN. Re-run release.ts to retry.\n");
      return;
    }
    console.log(`  ✓ pushed tag ${tag}`);
  } else {
    console.log(`  · remote tag ${tag} already present`);
  }

  // ─── Pack tarballs ───
  console.log("  Packing tarballs:");
  const assets = packTarballs(targets, results);
  if (assets.length === 0) {
    console.log("  ✗ no tarballs packed — nothing to upload\n");
    return;
  }

  // include install.sh as a one-line installer for new users
  const installShPath = "install.sh";
  const installShExists = existsSync(installShPath);

  // ─── Create or reuse release ───
  let createdNew = false;
  if (!releaseExists(tag)) {
    const notesBody = buildReleaseNotes(VERSION);
    const notesPath = join(RELEASE_DIR, `.github-release-staging/notes-${tag}.md`);
    writeFileSync(notesPath, notesBody);

    const title = `KCode ${tag}`;
    const create = shellCapture("gh", [
      "release",
      "create",
      tag,
      "-R",
      "AstrolexisAI/KCode",
      "--title",
      title,
      "--notes-file",
      notesPath,
    ]);
    if (!create.ok) {
      console.log(`  ✗ gh release create failed: ${create.stderr.slice(0, 200)}`);
      console.log("  Tag pushed; release page not created. Re-run release.ts to retry.\n");
      return;
    }
    console.log(`  ✓ created release ${tag}`);
    createdNew = true;
  } else {
    console.log(`  · release ${tag} already exists — uploading assets with --clobber`);
  }

  // ─── Upload assets (per-file with retry) ───
  //
  // Per-file instead of batch: v2.10.385 ran a batch `gh release upload
  // file1 file2 ... --clobber` and one of the 9 files came back HTTP 404
  // mid-batch. Worse, `gh` exited non-zero overall but most files
  // actually got uploaded — and a subset of `.sha256` sidecars ended up
  // with WRONG CONTENT (the right tarball bytes, the wrong hash file
  // bytes). Per-file isolates the failure: each upload has its own
  // exit code, its own retry, and a known list of files that didn't
  // make it on the first pass.
  const filesToUpload: string[] = [
    ...assets.flatMap((a) => [a.tarballPath, a.shaPath]),
    ...(installShExists ? [installShPath] : []),
  ];

  let uploadedOk = 0;
  const uploadFailures: Array<{ file: string; error: string }> = [];
  for (const filePath of filesToUpload) {
    const fileLabel = filePath.split("/").pop() ?? filePath;
    const result = await uploadOneAsset(tag, filePath);
    if (result.ok) {
      uploadedOk++;
    } else {
      console.log(`    ✗ ${fileLabel} after ${result.attempts} attempts: ${(result.lastError ?? "").slice(0, 120)}`);
      uploadFailures.push({ file: fileLabel, error: result.lastError ?? "" });
    }
  }

  if (uploadFailures.length > 0) {
    console.log(`  ✗ ${uploadFailures.length}/${filesToUpload.length} asset(s) failed all retries.`);
    if (createdNew) {
      console.log("  Release page exists; re-run release.ts to retry the missing assets.\n");
    }
    return;
  }
  console.log(`  ✓ uploaded ${uploadedOk} assets to ${tag}`);

  // ─── Verify .sha256 sidecars actually contain the right hashes ───
  //
  // v2.10.385 saw 3/4 .sha256 files arrive on GitHub with hashes that
  // didn't match the local tarball. Cause was either (a) gh CLI
  // batch-upload race or (b) GitHub edge-cache lag. Either way a user
  // running `sha256sum -c kcode-*.sha256` would have seen a corruption
  // alarm. We now fetch each sidecar back from GitHub via a
  // cache-busted URL and re-upload + retry if the content disagrees
  // with the local file.
  const verify = await verifyAndFixShaSidecars(tag, assets);
  if (!verify.ok) {
    console.log(`  ⚠ ${verify.mismatches.length} sha256 sidecar(s) STILL mismatched after retries:`);
    for (const m of verify.mismatches) console.log(`      ${m}`);
    console.log("  These point at corrupted tarballs from the user's perspective. Investigate manually.");
  } else {
    console.log(`  ✓ verified ${assets.length} sha256 sidecar(s) match local tarballs`);
  }

  console.log(`  https://github.com/AstrolexisAI/KCode/releases/tag/${tag}\n`);
}

// ─── Upload helpers ─────────────────────────────────────────────

/**
 * Upload a single asset with --clobber, retrying up to maxAttempts on
 * non-zero exit. Backoff doubles each attempt (1s, 2s, 4s) — the
 * intermittent 404 we saw on v2.10.385 cleared on second attempt in
 * post-mortem testing.
 */
async function uploadOneAsset(
  tag: string,
  filePath: string,
  maxAttempts = 3,
): Promise<{ ok: boolean; attempts: number; lastError?: string }> {
  let lastError = "";
  let backoffMs = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = shellCapture("gh", [
      "release",
      "upload",
      tag,
      "-R",
      "AstrolexisAI/KCode",
      filePath,
      "--clobber",
    ]);
    if (r.ok) {
      const fileLabel = filePath.split("/").pop() ?? filePath;
      const sizeMB = (statSync(filePath).size / (1024 * 1024)).toFixed(1);
      console.log(`    ✓ ${fileLabel} (${sizeMB} MB)${attempt > 1 ? ` after ${attempt} attempts` : ""}`);
      return { ok: true, attempts: attempt };
    }
    lastError = r.stderr || r.stdout;
    if (attempt < maxAttempts) {
      await sleepMs(backoffMs);
      backoffMs *= 2;
    }
  }
  return { ok: false, attempts: maxAttempts, lastError };
}

/**
 * After upload, fetch each .tar.gz.sha256 from GitHub via a
 * cache-busted URL. If the remote content disagrees with the local
 * file, re-upload and try again. Returns the list of files that are
 * STILL mismatched after exhausting the retry budget.
 */
async function verifyAndFixShaSidecars(
  tag: string,
  assets: PackedAsset[],
  maxAttempts = 3,
): Promise<{ ok: boolean; mismatches: string[] }> {
  const mismatches: string[] = [];
  for (const asset of assets) {
    const localContent = readFileSync(asset.shaPath, "utf-8").trim();
    const shaName = asset.shaPath.split("/").pop() ?? asset.shaPath;
    let verified = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const url = `https://github.com/AstrolexisAI/KCode/releases/download/${tag}/${shaName}?t=${Date.now()}`;
      let remoteContent = "";
      try {
        const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
        if (res.ok) remoteContent = (await res.text()).trim();
      } catch (err) {
        remoteContent = `<<fetch error: ${(err as Error).message}>>`;
      }
      if (remoteContent === localContent) {
        verified = true;
        break;
      }
      if (attempt < maxAttempts) {
        // Re-upload the sidecar (one shot, no inner retry — outer loop
        // handles it) and wait for the GitHub edge cache to flip.
        await uploadOneAsset(tag, asset.shaPath, 1);
        await sleepMs(5000);
      }
    }
    if (!verified) mismatches.push(shaName);
  }
  return { ok: mismatches.length === 0, mismatches };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
