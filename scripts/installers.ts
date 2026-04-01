#!/usr/bin/env bun
// KCode - Native Installer Generator
// Generates platform-specific installer packages from pre-built binaries.
//
// Usage:
//   bun run scripts/installers.ts              # Generate all installers
//   bun run scripts/installers.ts --deb        # Debian .deb only
//   bun run scripts/installers.ts --rpm        # RPM .rpm only
//   bun run scripts/installers.ts --pkg        # macOS .pkg only
//   bun run scripts/installers.ts --aur        # Arch AUR PKGBUILD only
//   bun run scripts/installers.ts --inno       # Windows Inno Setup .iss only
//
// Prerequisites:
//   deb:  dpkg-deb
//   rpm:  rpmbuild
//   pkg:  pkgbuild + productbuild (macOS only)
//   aur:  makepkg (Arch Linux)
//   inno: Inno Setup (Windows only, generates .iss config)

import { join } from "node:path";
import { mkdirSync, writeFileSync, copyFileSync, existsSync, chmodSync } from "node:fs";
import pkg from "../package.json";

const VERSION = pkg.version;
const RELEASE_DIR = "release";
const INSTALLERS_DIR = "release/installers";
const DESCRIPTION = "AI-powered coding assistant for the terminal by Astrolexis";
const HOMEPAGE = "https://kulvex.ai";
const LICENSE = "AGPL-3.0-only";
const MAINTAINER = "Astrolexis <dev@astrolexis.com>";

const args = process.argv.slice(2);
const buildAll = args.length === 0;
const buildDeb = buildAll || args.includes("--deb");
const buildRpm = buildAll || args.includes("--rpm");
const buildPkg = buildAll || args.includes("--pkg");
const buildAur = buildAll || args.includes("--aur");
const buildInno = buildAll || args.includes("--inno");

mkdirSync(INSTALLERS_DIR, { recursive: true });

// ─── Debian .deb ───────────────────────────────────────────────

async function generateDeb(arch: "amd64" | "arm64") {
  const binaryName = `kcode-${VERSION}-linux-${arch === "amd64" ? "x64" : "arm64"}`;
  const binaryPath = join(RELEASE_DIR, binaryName);

  if (!existsSync(binaryPath)) {
    console.log(`  Skip .deb (${arch}): binary not found at ${binaryPath}`);
    return;
  }

  const debRoot = join(INSTALLERS_DIR, `kcode_${VERSION}_${arch}`);
  const debBin = join(debRoot, "usr/local/bin");
  const debDoc = join(debRoot, "usr/share/doc/kcode");
  const debControl = join(debRoot, "DEBIAN");

  mkdirSync(debBin, { recursive: true });
  mkdirSync(debDoc, { recursive: true });
  mkdirSync(debControl, { recursive: true });

  // Copy binary
  copyFileSync(binaryPath, join(debBin, "kcode"));
  chmodSync(join(debBin, "kcode"), 0o755);

  // Control file
  writeFileSync(join(debControl, "control"), [
    `Package: kcode`,
    `Version: ${VERSION}`,
    `Architecture: ${arch}`,
    `Maintainer: ${MAINTAINER}`,
    `Description: ${DESCRIPTION}`,
    `Homepage: ${HOMEPAGE}`,
    `License: ${LICENSE}`,
    `Section: devel`,
    `Priority: optional`,
    `Installed-Size: ${Math.round(Bun.file(binaryPath).size / 1024)}`,
    "",
  ].join("\n"));

  // Post-install: create config dir
  writeFileSync(join(debControl, "postinst"), [
    "#!/bin/sh",
    'mkdir -p "$HOME/.kcode" 2>/dev/null || true',
    "",
  ].join("\n"));
  chmodSync(join(debControl, "postinst"), 0o755);

  // Copyright
  writeFileSync(join(debDoc, "copyright"), [
    `Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/`,
    `Upstream-Name: kcode`,
    `Source: https://github.com/AstrolexisAI/KCode`,
    ``,
    `Files: *`,
    `Copyright: 2024-2026 Astrolexis`,
    `License: ${LICENSE}`,
    "",
  ].join("\n"));

  // Build .deb
  const outFile = join(INSTALLERS_DIR, `kcode_${VERSION}_${arch}.deb`);
  const result = await Bun.$`dpkg-deb --build ${debRoot} ${outFile}`.quiet().nothrow();
  if (result.exitCode === 0) {
    console.log(`  ✓ ${outFile}`);
  } else {
    console.log(`  ✗ .deb (${arch}): dpkg-deb failed — ${result.stderr.toString().trim()}`);
  }

  // Cleanup staging dir
  await Bun.$`rm -rf ${debRoot}`.quiet().nothrow();
}

// ─── RPM .spec ─────────────────────────────────────────────────

async function generateRpmSpec() {
  const specContent = [
    `Name: kcode`,
    `Version: ${VERSION}`,
    `Release: 1`,
    `Summary: ${DESCRIPTION}`,
    `License: ${LICENSE}`,
    `URL: ${HOMEPAGE}`,
    ``,
    `%description`,
    `KCode (Kulvex Code) is an AI-powered coding assistant for the terminal`,
    `supporting local LLMs (llama.cpp, Ollama, vLLM) and cloud APIs`,
    `(Anthropic, OpenAI, Gemini, Groq, DeepSeek, Together AI).`,
    ``,
    `%install`,
    `mkdir -p %{buildroot}/usr/local/bin`,
    `cp %{_sourcedir}/kcode %{buildroot}/usr/local/bin/kcode`,
    `chmod 755 %{buildroot}/usr/local/bin/kcode`,
    ``,
    `%files`,
    `/usr/local/bin/kcode`,
    ``,
    `%post`,
    `mkdir -p "$HOME/.kcode" 2>/dev/null || true`,
    ``,
    `%changelog`,
    `* ${new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "2-digit", year: "numeric" })} Astrolexis <dev@astrolexis.com> - ${VERSION}-1`,
    `- Release v${VERSION}`,
    "",
  ].join("\n");

  const specPath = join(INSTALLERS_DIR, "kcode.spec");
  writeFileSync(specPath, specContent);
  console.log(`  ✓ ${specPath}`);
}

// ─── macOS .pkg ────────────────────────────────────────────────

async function generatePkg() {
  const arm64Binary = join(RELEASE_DIR, `kcode-${VERSION}-macos-arm64`);
  const x64Binary = join(RELEASE_DIR, `kcode-${VERSION}-macos-x64`);
  const binary = existsSync(arm64Binary) ? arm64Binary : existsSync(x64Binary) ? x64Binary : null;

  if (!binary) {
    console.log(`  Skip .pkg: no macOS binary found in ${RELEASE_DIR}/`);
    return;
  }

  const pkgRoot = join(INSTALLERS_DIR, "pkg-root");
  const pkgBin = join(pkgRoot, "usr/local/bin");
  mkdirSync(pkgBin, { recursive: true });

  copyFileSync(binary, join(pkgBin, "kcode"));
  chmodSync(join(pkgBin, "kcode"), 0o755);

  // Build component package
  const componentPkg = join(INSTALLERS_DIR, "kcode-component.pkg");
  let result = await Bun.$`pkgbuild --root ${pkgRoot} --identifier ai.kulvex.kcode --version ${VERSION} --install-location / ${componentPkg}`.quiet().nothrow();

  if (result.exitCode !== 0) {
    console.log(`  ✗ .pkg: pkgbuild failed — ${result.stderr.toString().trim()}`);
    await Bun.$`rm -rf ${pkgRoot}`.quiet().nothrow();
    return;
  }

  // Build product package
  const outFile = join(INSTALLERS_DIR, `kcode-${VERSION}.pkg`);
  result = await Bun.$`productbuild --package ${componentPkg} ${outFile}`.quiet().nothrow();

  if (result.exitCode === 0) {
    console.log(`  ✓ ${outFile}`);
  } else {
    console.log(`  ✗ .pkg: productbuild failed — ${result.stderr.toString().trim()}`);
  }

  // Cleanup
  await Bun.$`rm -rf ${pkgRoot} ${componentPkg}`.quiet().nothrow();
}

// ─── Arch Linux AUR PKGBUILD ───────────────────────────────────

async function generatePkgbuild() {
  const content = [
    `# Maintainer: Astrolexis <dev@astrolexis.com>`,
    `pkgname=kcode`,
    `pkgver=${VERSION}`,
    `pkgrel=1`,
    `pkgdesc="${DESCRIPTION}"`,
    `arch=('x86_64' 'aarch64')`,
    `url="${HOMEPAGE}"`,
    `license=('AGPL-3.0-only')`,
    `depends=()`,
    `source_x86_64=("https://github.com/AstrolexisAI/KCode/releases/download/v\${pkgver}/kcode-\${pkgver}-linux-x64.tar.gz")`,
    `source_aarch64=("https://github.com/AstrolexisAI/KCode/releases/download/v\${pkgver}/kcode-\${pkgver}-linux-arm64.tar.gz")`,
    `sha256sums_x86_64=('SKIP')`,
    `sha256sums_aarch64=('SKIP')`,
    ``,
    `package() {`,
    `  install -Dm755 kcode "\${pkgdir}/usr/local/bin/kcode"`,
    `  `,
    `  # Shell completions`,
    `  install -d "\${pkgdir}/usr/share/bash-completion/completions"`,
    `  install -d "\${pkgdir}/usr/share/zsh/site-functions"`,
    `  install -d "\${pkgdir}/usr/share/fish/vendor_completions.d"`,
    `  "\${srcdir}/kcode" completions bash > "\${pkgdir}/usr/share/bash-completion/completions/kcode" 2>/dev/null || true`,
    `  "\${srcdir}/kcode" completions zsh > "\${pkgdir}/usr/share/zsh/site-functions/_kcode" 2>/dev/null || true`,
    `  "\${srcdir}/kcode" completions fish > "\${pkgdir}/usr/share/fish/vendor_completions.d/kcode.fish" 2>/dev/null || true`,
    `}`,
    "",
  ].join("\n");

  const pkgbuildPath = join(INSTALLERS_DIR, "PKGBUILD");
  writeFileSync(pkgbuildPath, content);
  console.log(`  ✓ ${pkgbuildPath}`);
}

// ─── Windows Inno Setup .iss ───────────────────────────────────

async function generateInnoSetup() {
  const content = [
    `; KCode Inno Setup Script`,
    `; Generated by scripts/installers.ts`,
    ``,
    `[Setup]`,
    `AppName=KCode`,
    `AppVersion=${VERSION}`,
    `AppPublisher=Astrolexis`,
    `AppPublisherURL=${HOMEPAGE}`,
    `DefaultDirName={autopf}\\KCode`,
    `DefaultGroupName=KCode`,
    `OutputBaseFilename=kcode-${VERSION}-setup`,
    `OutputDir=.`,
    `Compression=lzma2`,
    `SolidCompression=yes`,
    `ArchitecturesAllowed=x64compatible`,
    `ArchitecturesInstallIn64BitMode=x64compatible`,
    `ChangesEnvironment=yes`,
    `LicenseFile=..\\..\\LICENSE`,
    ``,
    `[Files]`,
    `Source: "..\\kcode-${VERSION}-windows-x64.exe"; DestDir: "{app}"; DestName: "kcode.exe"; Flags: ignoreversion`,
    ``,
    `[Icons]`,
    `Name: "{group}\\KCode"; Filename: "{app}\\kcode.exe"`,
    ``,
    `[Registry]`,
    `; Add to PATH`,
    `Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Check: NeedsAddPath('{app}')`,
    ``,
    `[Code]`,
    `function NeedsAddPath(Param: string): boolean;`,
    `var`,
    `  OrigPath: string;`,
    `begin`,
    `  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then`,
    `  begin`,
    `    Result := True;`,
    `    exit;`,
    `  end;`,
    `  Result := Pos(';' + Param + ';', ';' + OrigPath + ';') = 0;`,
    `end;`,
    "",
  ].join("\n");

  const issPath = join(INSTALLERS_DIR, `kcode-${VERSION}-setup.iss`);
  writeFileSync(issPath, content);
  console.log(`  ✓ ${issPath}`);
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  console.log(`\nGenerating KCode v${VERSION} native installers...\n`);

  if (buildDeb) {
    console.log("Debian (.deb):");
    await generateDeb("amd64");
    await generateDeb("arm64");
  }

  if (buildRpm) {
    console.log("RPM (.spec):");
    await generateRpmSpec();
  }

  if (buildPkg) {
    console.log("macOS (.pkg):");
    await generatePkg();
  }

  if (buildAur) {
    console.log("Arch Linux (PKGBUILD):");
    await generatePkgbuild();
  }

  if (buildInno) {
    console.log("Windows (Inno Setup .iss):");
    await generateInnoSetup();
  }

  console.log("\nDone.");
}

main();
