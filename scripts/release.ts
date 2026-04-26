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

main();
