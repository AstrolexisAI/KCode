#!/usr/bin/env bun
// KCode - Build Script
// Compiles KCode into a standalone binary using Bun's --compile flag
//
// Usage:
//   bun run build.ts              # Production build (minified)
//   bun run build.ts --dev        # Dev build (no minification)
//   bun run build.ts --strip      # Production + strip debug symbols (~2.5 MB savings)
//   bun run build.ts --compress   # Production + strip + UPX compression (~60% smaller)
//
// NOTE ON BINARY SIZE:
//   The compiled binary is ~100 MB. This is overwhelmingly the embedded Bun runtime
//   (~99 MB), NOT the application code (~2 MB bundled JS). This is a known limitation
//   of `bun build --compile`. For a lightweight alternative, use:
//     bun run src/index.ts
//   which reuses the system-installed Bun runtime (0 MB overhead).

import { join } from "node:path";
import pkg from "./package.json";

const ENTRY = "src/index.ts";
const OUT_DIR = "dist";
const OUT_FILE = join(OUT_DIR, "kcode");

const args = process.argv.slice(2);
const isDev = args.includes("--dev");
const shouldStrip = args.includes("--strip") || args.includes("--compress");
const shouldCompress = args.includes("--compress");
const minify = !isDev;

async function build() {
  const startTime = performance.now();

  // Ensure output directory exists
  await Bun.$`mkdir -p ${OUT_DIR}`;

  console.log(`\nBuilding KCode v${pkg.version} standalone binary...`);
  console.log(`  Entry:        ${ENTRY}`);
  console.log(`  Output:       ${OUT_FILE}`);
  console.log(`  Minification: ${minify ? "enabled" : "disabled (dev)"}`);
  console.log(`  Strip:        ${shouldStrip ? "enabled" : "disabled"}`);
  console.log(`  Compress:     ${shouldCompress ? "enabled (UPX)" : "disabled"}`);
  console.log();

  try {
    // Build the standalone binary
    // --sourcemap=none: Ensure no source maps are embedded
    // --minify: Minify the bundled JS (saves ~1.4 MB)
    let proc;
    if (minify) {
      proc = await Bun.$`bun build ${ENTRY} --compile --minify --sourcemap=none --outfile ${OUT_FILE}`.quiet();
    } else {
      proc = await Bun.$`bun build ${ENTRY} --compile --sourcemap=none --outfile ${OUT_FILE}`.quiet();
    }

    if (proc.exitCode !== 0) {
      console.error(`Build failed with exit code ${proc.exitCode}`);
      console.error(proc.stderr.toString());
      process.exit(proc.exitCode);
    }

    // Print compile output
    const stdout = proc.stdout.toString().trim();
    if (stdout) console.log(stdout);

    // Get pre-strip/compress size for comparison
    const preSize = Bun.file(OUT_FILE).size;

    // Optionally strip debug symbols from the binary
    // Saves ~2.5 MB by removing Bun runtime debug info
    if (shouldStrip) {
      console.log("Stripping debug symbols...");
      try {
        await Bun.$`strip --strip-all ${OUT_FILE}`.quiet();
      } catch {
        console.warn("Warning: strip failed (install binutils for symbol stripping)");
      }
    }

    // Optionally compress with UPX for significant size reduction
    // UPX can reduce ELF binaries by 50-70% (adds ~100ms startup decompression)
    if (shouldCompress) {
      console.log("Compressing with UPX (this may take a moment)...");
      try {
        const upxProc = await Bun.$`upx --best --lzma ${OUT_FILE}`.quiet();
        const upxOut = upxProc.stdout.toString().trim();
        if (upxOut) console.log(upxOut);
      } catch {
        console.warn("Warning: UPX compression failed. Install UPX:");
        console.warn("  Fedora: sudo dnf install upx");
        console.warn("  Ubuntu: sudo apt install upx-ucl");
        console.warn("  Skipping compression, binary will be larger.");
      }
    }

    // Report build info
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    const finalSize = Bun.file(OUT_FILE).size;
    const sizeMB = (finalSize / (1024 * 1024)).toFixed(1);
    const timestamp = new Date().toISOString();

    console.log();
    console.log(`Build complete!`);
    console.log(`  Version:   ${pkg.version}`);
    console.log(`  Binary:    ${OUT_FILE}`);
    console.log(`  Size:      ${sizeMB} MB`);
    if (shouldStrip || shouldCompress) {
      const saved = preSize - finalSize;
      const pct = ((saved / preSize) * 100).toFixed(1);
      console.log(`  Saved:     ${(saved / (1024 * 1024)).toFixed(1)} MB (${pct}% reduction)`);
    }
    console.log(`  Time:      ${elapsed}s`);
    console.log(`  Timestamp: ${timestamp}`);
    console.log();
    console.log(`  Note: ~99 MB of the binary is the embedded Bun runtime.`);
    console.log(`  For zero overhead, use: bun run src/index.ts`);
    console.log();
  } catch (err) {
    console.error("Build error:", err);
    process.exit(1);
  }
}

build();
