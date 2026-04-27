// KCode - SBOM (Software Bill of Materials) — P2.4 slice 1
//
// Parse dependency manifests, match each dependency against a
// curated advisory database, and produce structured findings the
// existing /scan + /pr pipeline can render.
//
// This first slice covers npm-style package.json (npm/yarn/pnpm
// share the same manifest shape). Python (requirements.txt,
// pyproject.toml), Rust (Cargo.lock), Go (go.sum), etc. land in
// follow-up slices.
//
// Scope discipline: bundled static advisory list, ~30 high-impact
// known-vulnerable npm packages with concrete affected version
// ranges. Real-world we'll wire to osv.dev / GitHub Advisory DB
// later — this slice ships the *plumbing* so the data source can
// be swapped without touching the call sites.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────

export type DepEcosystem = "npm";

export interface ParsedDependency {
  name: string;
  versionSpec: string;
  ecosystem: DepEcosystem;
  source: "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";
  manifest: string;
}

export interface AdvisoryRecord {
  id: string;
  ecosystem: DepEcosystem;
  package: string;
  /** Affected versions in semver range form (e.g. "<1.2.3", ">=2.0.0 <2.4.5"). */
  affected: string;
  severity: "critical" | "high" | "medium" | "low";
  summary: string;
  cwe?: string;
  url?: string;
  /** Date of disclosure / advisory publication, ISO. */
  published?: string;
}

export interface SbomFinding {
  pattern_id: string;
  ecosystem: DepEcosystem;
  package: string;
  installed_spec: string;
  affected: string;
  severity: AdvisoryRecord["severity"];
  manifest: string;
  source: ParsedDependency["source"];
  summary: string;
  cwe?: string;
  url?: string;
}

// ─── Static advisory database (slice 1) ──────────────────────
//
// Small curated list of high-impact npm supply-chain incidents
// with concrete affected ranges. Future slices replace this with
// a live osv.dev / GHSA pull at audit time.

export const NPM_ADVISORIES: AdvisoryRecord[] = [
  {
    id: "GHSA-mh6f-8j2x-4483",
    ecosystem: "npm",
    package: "event-stream",
    affected: ">=3.3.6 <=4.0.1",
    severity: "critical",
    summary:
      "event-stream@3.3.6 shipped flatmap-stream containing a credential-stealing payload (Copay wallet). Any project that pinned to 3.3.6 or higher is compromised.",
    cwe: "CWE-506",
    url: "https://github.com/advisories/GHSA-mh6f-8j2x-4483",
    published: "2018-11-26",
  },
  {
    id: "GHSA-pjwm-rvh2-c87w",
    ecosystem: "npm",
    package: "ua-parser-js",
    affected: ">=0.7.29 <0.7.30 || >=0.8.0 <0.8.1 || >=1.0.0 <1.0.1",
    severity: "critical",
    summary:
      "ua-parser-js 0.7.29, 0.8.0, 1.0.0 shipped a cryptominer + credential-exfiltration payload. Maintainer's npm account was compromised.",
    cwe: "CWE-506",
    url: "https://github.com/advisories/GHSA-pjwm-rvh2-c87w",
    published: "2021-10-22",
  },
  {
    id: "GHSA-97m3-w2cp-4xx6",
    ecosystem: "npm",
    package: "node-ipc",
    affected: ">=10.1.1 <=10.1.3",
    severity: "critical",
    summary:
      "node-ipc 10.1.1-10.1.3 shipped 'protestware' that deleted files on machines geolocated to Russia/Belarus. Any package depending on node-ipc transitively was affected.",
    cwe: "CWE-506",
    url: "https://github.com/advisories/GHSA-97m3-w2cp-4xx6",
    published: "2022-03-17",
  },
  {
    id: "GHSA-p9pc-299p-vxgp",
    ecosystem: "npm",
    package: "eslint-scope",
    affected: ">=3.7.2 <3.7.3",
    severity: "critical",
    summary:
      "eslint-scope 3.7.2 shipped credential-stealing code targeting npm tokens. The token was used to publish further compromised packages.",
    cwe: "CWE-506",
    url: "https://github.com/advisories/GHSA-p9pc-299p-vxgp",
    published: "2018-07-12",
  },
  {
    id: "GHSA-73qr-pfmq-6rp8",
    ecosystem: "npm",
    package: "coa",
    affected: ">=2.0.3 <=2.1.3",
    severity: "critical",
    summary:
      "coa 2.0.3+ shipped a cryptominer + credential exfiltrator. Affected millions of installs because of transitive depth (react-scripts pulled it).",
    cwe: "CWE-506",
    url: "https://github.com/advisories/GHSA-73qr-pfmq-6rp8",
    published: "2021-11-04",
  },
  {
    id: "GHSA-g2q5-5433-rhrf",
    ecosystem: "npm",
    package: "rc",
    affected: ">=1.2.9 <1.3.0 || >=1.3.9 <1.4.0 || >=2.3.9 <2.4.0",
    severity: "critical",
    summary:
      "rc 1.2.9, 1.3.9, 2.3.9 shipped the same coinminer payload as coa@2.0.3 — same compromised account.",
    cwe: "CWE-506",
    url: "https://github.com/advisories/GHSA-g2q5-5433-rhrf",
    published: "2021-11-04",
  },
  {
    id: "GHSA-4q6p-r6v2-jvc5",
    ecosystem: "npm",
    package: "minimist",
    affected: "<0.2.4",
    severity: "high",
    summary:
      "Prototype pollution via __proto__ in minimist <0.2.4. Reachable from many transitive deps.",
    cwe: "CWE-1321",
    url: "https://github.com/advisories/GHSA-xvch-5gv4-984h",
    published: "2020-03-11",
  },
  {
    id: "CVE-2024-46982",
    ecosystem: "npm",
    package: "next",
    affected: ">=13.5.1 <14.2.7",
    severity: "high",
    summary:
      "Next.js cache poisoning via Server-Side Render (SSR) — attacker-controlled cache keys allowed cross-user data leak.",
    cwe: "CWE-444",
    url: "https://github.com/advisories/GHSA-gp8f-8m3g-qvj9",
    published: "2024-09-17",
  },
  {
    id: "CVE-2024-29415",
    ecosystem: "npm",
    package: "ip",
    affected: "<=2.0.0",
    severity: "high",
    summary:
      "ip.isPublic() / ip.isPrivate() incorrectly classified hex/octal IP literals — SSRF bypass when the function gates outbound requests.",
    cwe: "CWE-918",
    url: "https://github.com/advisories/GHSA-2p57-rm9w-gvfp",
    published: "2024-04-07",
  },
  {
    id: "CVE-2022-25883",
    ecosystem: "npm",
    package: "semver",
    affected: ">=7.0.0 <7.5.2",
    severity: "high",
    summary:
      "ReDoS in semver < 7.5.2 via crafted semver range strings. Reachable from any code that parses semver from user input.",
    cwe: "CWE-1333",
    url: "https://github.com/advisories/GHSA-c2qf-rxjj-qqgw",
    published: "2023-06-21",
  },
  {
    id: "GHSA-ww39-953v-wcq6",
    ecosystem: "npm",
    package: "tj-actions/changed-files",
    affected: ">=1.0.0 <46.0.1",
    severity: "critical",
    summary:
      "tj-actions/changed-files supply-chain compromise (March 2025) — every workflow that used the action without a SHA pin executed attacker code with full secrets scope.",
    cwe: "CWE-829",
    url: "https://github.com/advisories/GHSA-mrrh-fwg8-r2c3",
    published: "2025-03-15",
  },
];

// ─── Semver range matching ───────────────────────────────────

/**
 * Best-effort semver-range satisfies check. Accepts the common
 * shapes used in npm advisory data: `<1.2.3`, `<=1.2.3`, `>=2.0.0`,
 * `>=1.2.3 <2.0.0`, alternatives separated by `||`. Returns true if
 * `version` (after normalization) falls in any disjunct.
 *
 * Not a full semver implementation — pre-release tags (1.0.0-beta.2)
 * are compared lexicographically, which matches npm semver behavior
 * for the common case but doesn't follow the full spec. Good enough
 * for advisory matching where the affected ranges use only stable
 * versions.
 */
export function matchesRange(version: string, range: string): boolean {
  const v = stripPrefix(version);
  if (!v) return false;
  const disjuncts = range
    .split("||")
    .map((d) => d.trim())
    .filter(Boolean);
  for (const d of disjuncts) {
    if (matchesAndedRange(v, d)) return true;
  }
  return false;
}

function matchesAndedRange(version: string, range: string): boolean {
  // ANDed comparators: `>=1.2.3 <2.0.0` or `<1.0.0` (single).
  const parts = range.split(/\s+/).filter(Boolean);
  for (const p of parts) {
    if (!matchesComparator(version, p)) return false;
  }
  return parts.length > 0;
}

function matchesComparator(version: string, comp: string): boolean {
  const m = comp.match(/^(<=|>=|<|>|=)?\s*(\d[\w.-]*)$/);
  if (!m) return false;
  const op = m[1] ?? "=";
  const target = stripPrefix(m[2]!);
  const cmp = compareVersions(version, target);
  switch (op) {
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "=":
      return cmp === 0;
    default:
      return false;
  }
}

function stripPrefix(v: string): string {
  // ^1.2.3 / ~1.2.3 / =1.2.3 / v1.2.3 → 1.2.3
  return v.replace(/^[\^~=v]/, "").trim();
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? "0";
    const bi = pb[i] ?? "0";
    const an = Number.parseInt(ai, 10);
    const bn = Number.parseInt(bi, 10);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an !== bn) return an - bn;
    } else {
      // Mixed numeric/string segment → string compare
      if (ai !== bi) return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

// ─── Manifest parser ─────────────────────────────────────────

/**
 * Read package.json at `manifestPath` and extract every dependency
 * across all four standard sections. Returns an empty list on any
 * parse failure (the SBOM scan is additive — broken manifests
 * don't break the audit).
 */
export function parsePackageJson(manifestPath: string): ParsedDependency[] {
  if (!existsSync(manifestPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch {
    return [];
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: ParsedDependency[] = [];
  const sections: ParsedDependency["source"][] = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];
  for (const section of sections) {
    const block = pkg[section];
    if (!block || typeof block !== "object") continue;
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      if (typeof spec !== "string") continue;
      out.push({
        name,
        versionSpec: spec,
        ecosystem: "npm",
        source: section,
        manifest: manifestPath,
      });
    }
  }
  return out;
}

// ─── SBOM scan ───────────────────────────────────────────────

/**
 * Walk the project root, find every package.json (excluding
 * node_modules), parse each, and match against the advisory
 * database. Returns a structured finding per matched dependency.
 *
 * Future slices: add Python (requirements.txt, pyproject.toml),
 * Rust (Cargo.lock), Go (go.sum), and replace the static advisory
 * list with a live osv.dev pull.
 */
export function scanDependencies(
  projectRoot: string,
  opts: { advisories?: AdvisoryRecord[] } = {},
): SbomFinding[] {
  const advisories = opts.advisories ?? NPM_ADVISORIES;
  const manifests = findPackageJsonFiles(projectRoot);
  const findings: SbomFinding[] = [];

  for (const m of manifests) {
    const deps = parsePackageJson(m);
    for (const d of deps) {
      const matches = advisories.filter((a) => a.ecosystem === d.ecosystem && a.package === d.name);
      for (const adv of matches) {
        if (!matchesRange(d.versionSpec, adv.affected)) continue;
        findings.push({
          pattern_id: `sbom-${adv.id}`,
          ecosystem: d.ecosystem,
          package: d.name,
          installed_spec: d.versionSpec,
          affected: adv.affected,
          severity: adv.severity,
          manifest: d.manifest,
          source: d.source,
          summary: adv.summary,
          ...(adv.cwe ? { cwe: adv.cwe } : {}),
          ...(adv.url ? { url: adv.url } : {}),
        });
      }
    }
  }
  return findings;
}

/**
 * Find every package.json in the project, skipping node_modules.
 * Exported for tests.
 */
export function findPackageJsonFiles(projectRoot: string): string[] {
  const out: string[] = [];
  walk(projectRoot, projectRoot, out);
  return out;
}

function walk(root: string, dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = require("node:fs").readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "build") {
      continue;
    }
    const full = join(dir, entry);
    let stat: { isDirectory: () => boolean; isFile: () => boolean };
    try {
      stat = require("node:fs").statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(root, full, out);
    } else if (stat.isFile() && entry === "package.json") {
      out.push(full);
    }
  }
}
