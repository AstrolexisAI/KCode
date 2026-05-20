#!/usr/bin/env bun
// Generates Keep-a-Changelog entries from git history.
//
// Detects version bumps by reading the "version" field of package.json
// at every commit that touches it, then groups commits between bumps
// and emits user-facing changes (feat/fix/perf/security/refactor!) in
// Keep-a-Changelog format. Skips releases where no user-facing commit
// landed (lint/style/test/ci/chore-only).
//
// Usage: bun run scripts/changelog-backfill.ts [stopAtPatch]
//   stopAtPatch: integer; emit entries for patches strictly above this
//                (default 150 — anchored to the last entry in CHANGELOG).

const STOP_AT_PATCH = Number(process.argv[2] ?? "150");

const INTERNAL_RE = /^(chore|style|test|ci|build)(\([^)]*\))?:/;
const FEAT_RE = /^feat(\([^)]*\))?:/;
const FIX_RE = /^fix(\([^)]*\))?:/;
const PERF_RE = /^perf(\([^)]*\))?:/;
const SEC_RE = /^(security|sec)(\([^)]*\))?:/;
const REFACTOR_RE = /^refactor(\([^)]*\))?:/;
const DOCS_RE = /^docs(\([^)]*\))?:/;
const PREFIX_STRIP =
  /^(feat|fix|perf|refactor|chore|docs|style|test|ci|build|security)(\([^)]*\))?:\s*/;

function sh(args: string[]): string {
  const p = Bun.spawnSync({ cmd: args });
  return new TextDecoder().decode(p.stdout);
}

// All commits on master, newest first.
const allLog = sh(["git", "log", "--pretty=format:%H|%ai|%s", "master"]).split("\n");
const shaIndex = new Map<string, number>();
allLog.forEach((line, idx) => {
  const sha = line.split("|")[0];
  if (sha) shaIndex.set(sha, idx);
});

// Commits that touched package.json, newest first.
const pkgShas = sh([
  "git",
  "log",
  "--pretty=format:%H",
  "master",
  "--",
  "package.json",
]).split("\n").filter(Boolean);

// For each of those, read the package.json version AT that commit.
// Walk oldest -> newest. Each time version changes from the previous,
// the commit is a bump that "produced" that new version.
const pkgShasAsc = [...pkgShas].reverse();
const versionAtSha = new Map<string, string>();
for (const sha of pkgShasAsc) {
  const pkg = sh(["git", "show", `${sha}:package.json`]);
  const m = pkg.match(/"version":\s*"([^"]+)"/);
  if (m) versionAtSha.set(sha, m[1]);
}

// Detect bumps (asc): bump at sha[i] if version differs from sha[i-1].
type Bump = { sha: string; version: string; date: string; idxInAllLog: number };
const bumps: Bump[] = [];
let prevVersion: string | null = null;
for (const sha of pkgShasAsc) {
  const v = versionAtSha.get(sha);
  if (!v) continue;
  if (v !== prevVersion) {
    const idx = shaIndex.get(sha);
    if (idx !== undefined) {
      const date = allLog[idx].split("|")[1].split(" ")[0];
      bumps.push({ sha, version: v, date, idxInAllLog: idx });
    }
    prevVersion = v;
  }
}

// Now bumps are in asc order (oldest first). To enumerate work commits:
// the work for bump[k] is the commits in allLog between bumps[k-1].idxInAllLog
// (exclusive, newer) and bumps[k].idxInAllLog (inclusive, the bump commit itself).
// allLog is newest-first → bumps[k].idxInAllLog > bumps[k-1].idxInAllLog.

function classify(s: string): string | null {
  if (FEAT_RE.test(s)) return "added";
  if (PERF_RE.test(s)) return "changed";
  if (REFACTOR_RE.test(s) && /breaking/i.test(s)) return "changed";
  if (FIX_RE.test(s)) return "fixed";
  if (SEC_RE.test(s)) return "security";
  if (DOCS_RE.test(s) && /(readme|brochure|migrate|breaking)/i.test(s)) return "docs";
  if (INTERNAL_RE.test(s)) return null;
  // Unknown prefix → drop (conservative)
  return null;
}

function isReleaseBumpSubject(s: string): boolean {
  return /chore\(release\)/.test(s) || /^bump:?\s/i.test(s) || /^Bump\s/.test(s);
}

// Emit newest-first to match the existing CHANGELOG.md ordering.
const bumpsDesc = [...bumps].reverse();
const out: string[] = [];

for (let k = 0; k < bumpsDesc.length; k++) {
  const bump = bumpsDesc[k];
  const patch = Number(bump.version.split(".")[2]);
  if (patch <= STOP_AT_PATCH) break;

  // Work commits: the bump commit ITSELF (when it carries content, e.g.
  // `fix(router): ...` that also bumped version via auto-bump hook), PLUS
  // any commits between this bump and the previous (older) bump. Pure
  // release commits (`chore(release): bump to X`) are dropped by the
  // classifier downstream.
  //
  // In this repo most commits both ship content and bump the patch, so
  // including the bump commit itself is essential — without it, we'd
  // emit empty releases.
  const olderIdx =
    k + 1 < bumpsDesc.length ? bumpsDesc[k + 1].idxInAllLog : allLog.length;
  const workLines = allLog.slice(bump.idxInAllLog, olderIdx);

  const sec: Record<string, string[]> = {
    added: [],
    changed: [],
    fixed: [],
    security: [],
    docs: [],
  };
  for (const line of workLines) {
    const subject = line.split("|").slice(2).join("|");
    if (isReleaseBumpSubject(subject)) continue;
    const cls = classify(subject);
    if (cls) sec[cls].push(subject.replace(PREFIX_STRIP, ""));
  }

  const total = Object.values(sec).reduce((a, b) => a + b.length, 0);
  if (total === 0) continue;

  out.push(`## [${bump.version}] — ${bump.date}`);
  out.push("");
  const emit = (label: string, items: string[]) => {
    if (!items.length) return;
    out.push(`### ${label}`);
    for (const it of items) out.push(`- ${it}`);
    out.push("");
  };
  emit("Added", sec.added);
  emit("Changed", sec.changed);
  emit("Fixed", sec.fixed);
  emit("Security", sec.security);
  emit("Docs", sec.docs);
}

console.log(out.join("\n"));
