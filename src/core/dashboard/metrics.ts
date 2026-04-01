// KCode - Dashboard Metrics Collection
// Helpers for gathering project statistics.

import { log } from "../logger";

// ─── Shell helpers ─────────────────────────────────────────────

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { ok: code === 0, stdout: stdout.trim() };
  } catch (err) {
    log.debug("dashboard/metrics", `Command failed [${cmd.join(" ")}]: ${err}`);
    return { ok: false, stdout: "" };
  }
}

// ─── Language detection ────────────────────────────────────────

const LANGUAGE_MARKERS: Array<[string, string]> = [
  ["tsconfig.json", "TypeScript"],
  ["package.json", "JavaScript"],
  ["Cargo.toml", "Rust"],
  ["go.mod", "Go"],
  ["setup.py", "Python"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  ["build.gradle", "Java"],
  ["pom.xml", "Java"],
  ["Gemfile", "Ruby"],
  ["mix.exs", "Elixir"],
  ["Package.swift", "Swift"],
  ["CMakeLists.txt", "C/C++"],
  ["Makefile", "C/C++"],
];

export async function detectLanguage(dir: string): Promise<string> {
  for (const [marker, lang] of LANGUAGE_MARKERS) {
    const file = Bun.file(`${dir}/${marker}`);
    if (await file.exists()) return lang;
  }
  return "Unknown";
}

// ─── Test framework detection ──────────────────────────────────

export async function detectTestFramework(dir: string): Promise<string> {
  try {
    const pkg = Bun.file(`${dir}/package.json`);
    if (await pkg.exists()) {
      const json = await pkg.json();
      const testScript: string = json?.scripts?.test ?? "";
      if (testScript.includes("vitest")) return "vitest";
      if (testScript.includes("jest")) return "jest";
      if (testScript.includes("bun test") || testScript.includes("bun:test")) return "bun:test";
      if (testScript.includes("mocha")) return "mocha";
      if (testScript.includes("ava")) return "ava";
      // Check devDependencies as fallback
      const devDeps = json?.devDependencies ?? {};
      if (devDeps["vitest"]) return "vitest";
      if (devDeps["jest"]) return "jest";
    }
  } catch (err) {
    log.debug("dashboard/metrics", `detectTestFramework error: ${err}`);
  }

  // Non-JS ecosystems
  const markers: Array<[string, string]> = [
    ["pytest.ini", "pytest"],
    ["setup.cfg", "pytest"],
    ["Cargo.toml", "cargo test"],
    ["go.mod", "go test"],
  ];
  for (const [marker, fw] of markers) {
    const f = Bun.file(`${dir}/${marker}`);
    if (await f.exists()) return fw;
  }
  return "unknown";
}

// ─── File counting ─────────────────────────────────────────────

const SOURCE_EXTENSIONS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "go",
  "rs",
  "java",
  "rb",
  "ex",
  "exs",
  "c",
  "cpp",
  "h",
  "swift",
];

export async function countFiles(dir: string, extensions?: string[]): Promise<number> {
  const exts = extensions ?? SOURCE_EXTENSIONS;
  const nameArgs = exts.flatMap((e, i) =>
    i === 0 ? ["-name", `*.${e}`] : ["-o", "-name", `*.${e}`],
  );
  const result = await run([
    "find",
    dir,
    "-type",
    "f",
    "(",
    ...nameArgs,
    ")",
    "-not",
    "-path",
    "*/node_modules/*",
    "-not",
    "-path",
    "*/.git/*",
    "-not",
    "-path",
    "*/dist/*",
    "-not",
    "-path",
    "*/build/*",
  ]);
  if (!result.ok || !result.stdout) return 0;
  return result.stdout.split("\n").filter(Boolean).length;
}

export async function countLinesOfCode(dir: string, extensions?: string[]): Promise<number> {
  const exts = extensions ?? SOURCE_EXTENSIONS;
  const nameArgs = exts.flatMap((e, i) =>
    i === 0 ? ["-name", `*.${e}`] : ["-o", "-name", `*.${e}`],
  );
  const findResult = await run([
    "find",
    dir,
    "-type",
    "f",
    "(",
    ...nameArgs,
    ")",
    "-not",
    "-path",
    "*/node_modules/*",
    "-not",
    "-path",
    "*/.git/*",
    "-not",
    "-path",
    "*/dist/*",
  ]);
  if (!findResult.ok || !findResult.stdout) return 0;

  const files = findResult.stdout.split("\n").filter(Boolean);
  if (files.length === 0) return 0;

  // Use xargs + wc for efficiency
  const wcResult = await run([
    "sh",
    "-c",
    `echo '${files.join("\n")}' | xargs wc -l 2>/dev/null | tail -1`,
  ]);
  if (!wcResult.ok) return 0;
  const total = parseInt(wcResult.stdout.trim().split(/\s+/)[0]!, 10);
  return isNaN(total) ? 0 : total;
}

// ─── Coverage parsing ──────────────────────────────────────────

export async function parseCoverage(dir: string): Promise<number | undefined> {
  // Try coverage-summary.json first (Istanbul/NYC format)
  try {
    const summaryFile = Bun.file(`${dir}/coverage/coverage-summary.json`);
    if (await summaryFile.exists()) {
      const summary = await summaryFile.json();
      const total = summary?.total?.lines?.pct ?? summary?.total?.statements?.pct;
      if (typeof total === "number") return Math.round(total);
    }
  } catch (err) {
    log.debug("dashboard/metrics", `coverage-summary parse error: ${err}`);
  }

  // Try lcov.info
  try {
    const lcovFile = Bun.file(`${dir}/coverage/lcov.info`);
    if (await lcovFile.exists()) {
      const content = await lcovFile.text();
      let linesFound = 0;
      let linesHit = 0;
      for (const line of content.split("\n")) {
        if (line.startsWith("LF:")) linesFound += parseInt(line.slice(3), 10) || 0;
        if (line.startsWith("LH:")) linesHit += parseInt(line.slice(3), 10) || 0;
      }
      if (linesFound > 0) return Math.round((linesHit / linesFound) * 100);
    }
  } catch (err) {
    log.debug("dashboard/metrics", `lcov parse error: ${err}`);
  }

  return undefined;
}

// ─── Git activity ──────────────────────────────────────────────

export async function getLastCommitTime(dir: string): Promise<string> {
  const result = await run(["git", "-C", dir, "log", "-1", "--format=%ci"]);
  return result.ok ? result.stdout : "unknown";
}

export async function getProjectName(dir: string): Promise<string> {
  // Try package.json
  try {
    const pkg = Bun.file(`${dir}/package.json`);
    if (await pkg.exists()) {
      const json = await pkg.json();
      if (json?.name) return json.name;
    }
  } catch {}
  // Try Cargo.toml
  try {
    const cargo = Bun.file(`${dir}/Cargo.toml`);
    if (await cargo.exists()) {
      const text = await cargo.text();
      const match = text.match(/^name\s*=\s*"([^"]+)"/m);
      if (match) return match[1]!;
    }
  } catch {}
  // Fallback to directory name
  return dir.split("/").pop() ?? "unknown";
}

// ─── Dependency counting ───────────────────────────────────────

export async function countDependencies(
  dir: string,
): Promise<{ total: number; outdated: number; vulnerable: number }> {
  let total = 0;
  let outdated = 0;
  const vulnerable = 0;

  try {
    const pkg = Bun.file(`${dir}/package.json`);
    if (await pkg.exists()) {
      const json = await pkg.json();
      total =
        Object.keys(json?.dependencies ?? {}).length +
        Object.keys(json?.devDependencies ?? {}).length;
    }
  } catch (err) {
    log.debug("dashboard/metrics", `countDependencies error: ${err}`);
  }

  // Try bun outdated (non-blocking)
  try {
    const result = await run(["bun", "outdated"]);
    if (result.ok && result.stdout) {
      // Count non-header lines
      const lines = result.stdout
        .split("\n")
        .filter(
          (l) =>
            l.trim() &&
            !l.startsWith("┌") &&
            !l.startsWith("│ Package") &&
            !l.startsWith("├") &&
            !l.startsWith("└"),
        );
      outdated = lines.length;
    }
  } catch {}

  return { total, outdated, vulnerable };
}
