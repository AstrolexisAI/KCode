// KCode - GitHub Claim Grounding (v2.10.306, #111 fabricated-repo bug)
//
// Preventive layer that verifies owner/repo claims against github.com
// BEFORE the final text renders, so fabrications like `nasa/ai` (real
// session example — model invented it and recommended it) cannot reach
// the user as factual recommendations.
//
// Decision tree for each detected owner/repo:
//   1. Is it already verified via an earlier WebFetch/ToolUse URL
//      that fetched this specific repo page? → verified=true
//   2. Run a lightweight HEAD against https://github.com/{owner}/{repo}
//      → 2xx = verified, 404 = missing, other = unknown
//   3. Results cached for the process lifetime (no repeat fetches).
//
// Output actions:
//   * "missing" repos → rewrite in text as "posible repo: ... (no verificado)"
//   * "unknown" (timeout / network error) → same degrade, with a
//     different annotation
//   * "verified" → left untouched
//
// Opt-out: KCODE_DISABLE_REPO_GROUNDING=1.

export type RepoVerifyStatus = "verified" | "missing" | "unknown";

export interface RepoClaim {
  repo: string; // owner/repo
  start: number; // byte offset in source text
  end: number;
}

export interface VerifiedRepoClaim extends RepoClaim {
  status: RepoVerifyStatus;
  evidence?: string; // short reason, e.g. "HTTP 200" / "HTTP 404" / "timeout"
}

// ─── Detection ───────────────────────────────────────────────────

// Capture owner/repo only when it looks like a GitHub-style slug,
// NOT when it's a file path or a URL.
const CLAIM_RE =
  /(?<![./\w-])`?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,98}[A-Za-z0-9_-]|[A-Za-z0-9])`?(?![/\w])/g;

const FILE_EXT_RE =
  /\.(md|ts|tsx|js|jsx|py|rs|go|java|rb|sh|txt|json|yml|yaml|toml|lock|xml|html|css|svg)$/i;

const STOP_OWNERS = new Set(["src", "bin", "docs", "node_modules", "dist"]);

export function detectGithubRepoClaims(text: string): RepoClaim[] {
  const out: RepoClaim[] = [];
  const seen = new Set<string>();
  const re = new RegExp(CLAIM_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const owner = m[1] ?? "";
    const name = m[2] ?? "";
    if (!owner || !name) continue;
    if (STOP_OWNERS.has(owner.toLowerCase())) continue;
    if (FILE_EXT_RE.test(name)) continue;
    const repo = `${owner}/${name}`;
    if (seen.has(repo)) continue; // dedupe — only first occurrence matters for rewriting (we'll rewrite all occurrences in a second pass)
    seen.add(repo);
    out.push({ repo, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// ─── Verification (HEAD request with cache) ──────────────────────

const _cache = new Map<string, RepoVerifyStatus>();
const _cacheEvidence = new Map<string, string>();

/** Reset cache — test hooks. */
export function _resetRepoCache(): void {
  _cache.clear();
  _cacheEvidence.clear();
}

/** Seed the cache (used to mark repos that already came from a WebFetch/tool result). */
export function seedVerifiedRepo(repo: string, evidence = "prior tool result"): void {
  _cache.set(repo, "verified");
  _cacheEvidence.set(repo, evidence);
}

async function verifyOne(
  repo: string,
  timeoutMs: number,
): Promise<{ status: RepoVerifyStatus; evidence: string }> {
  const cached = _cache.get(repo);
  if (cached !== undefined) {
    return { status: cached, evidence: _cacheEvidence.get(repo) ?? "cached" };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(`https://github.com/${repo}`, {
      method: "HEAD",
      redirect: "manual",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    let status: RepoVerifyStatus;
    // GitHub returns 200 for public repos, 301/302 for renames,
    // 404 for missing, 429 for rate limit (treat as unknown).
    if (resp.status >= 200 && resp.status < 400) status = "verified";
    else if (resp.status === 404) status = "missing";
    else status = "unknown";
    const evidence = `HTTP ${resp.status}`;
    _cache.set(repo, status);
    _cacheEvidence.set(repo, evidence);
    return { status, evidence };
  } catch (err) {
    const evidence = err instanceof Error ? err.message : String(err);
    _cache.set(repo, "unknown");
    _cacheEvidence.set(repo, evidence);
    return { status: "unknown", evidence };
  }
}

/**
 * Verify a batch of claims in parallel. Returns the original list
 * enriched with status + evidence. Respects the global cache.
 */
export async function verifyRepoClaims(
  claims: RepoClaim[],
  opts?: { timeoutMs?: number; concurrency?: number },
): Promise<VerifiedRepoClaim[]> {
  const timeoutMs = opts?.timeoutMs ?? 3000;
  const concurrency = Math.max(1, opts?.concurrency ?? 6);
  const out: VerifiedRepoClaim[] = new Array(claims.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= claims.length) return;
      const claim = claims[idx]!;
      const { status, evidence } = await verifyOne(claim.repo, timeoutMs);
      out[idx] = { ...claim, status, evidence };
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, claims.length) }, worker);
  await Promise.all(workers);
  return out.filter(Boolean);
}

// ─── Rewriting ───────────────────────────────────────────────────

/**
 * Rewrite all occurrences (NOT just first) of unverified repos in the
 * text with a tagged "possible repo" annotation. Verified repos are
 * left untouched.
 *
 * Format:
 *   missing  → `nasa/ai` (repo no encontrado — posiblemente alucinado)
 *   unknown  → `nasa/ai` (no verificado)
 */
export function rewriteUnverifiedRepoClaims(
  text: string,
  claims: VerifiedRepoClaim[],
): { text: string; rewritten: number; details: VerifiedRepoClaim[] } {
  let out = text;
  let rewritten = 0;
  const details: VerifiedRepoClaim[] = [];

  for (const claim of claims) {
    if (claim.status === "verified") continue;
    const marker =
      claim.status === "missing"
        ? "(repo no encontrado — posiblemente alucinado)"
        : "(no verificado)";
    // Replace every occurrence of the bare `owner/repo` token, with
    // or without surrounding backticks. Only outside of real URLs
    // (we avoid rewriting inside an https://... token).
    //
    // Strategy: single regex that matches the repo token NOT
    // preceded by `/` (URL path char) or `.` (file path), and NOT
    // followed by `/` + word char (continued path).
    const esc = claim.repo.replace(/[-/.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![./\\w-])(\`?)${esc}(\`?)(?![\\w/])`, "g");
    const before = out;
    out = out.replace(re, (_m, bt1, bt2) => {
      rewritten++;
      return `${bt1}${claim.repo}${bt2} ${marker}`;
    });
    if (out !== before) details.push(claim);
  }

  return { text: out, rewritten, details };
}

// ─── Top-level convenience ───────────────────────────────────────

/**
 * End-to-end: detect, verify, rewrite. Returns the new text + a
 * summary of every claim checked (so callers can emit a banner or
 * flag scope).
 */
export async function groundGithubRepoClaims(
  text: string,
  opts?: { timeoutMs?: number },
): Promise<{
  text: string;
  verified: VerifiedRepoClaim[];
  missing: VerifiedRepoClaim[];
  unknown: VerifiedRepoClaim[];
}> {
  const claims = detectGithubRepoClaims(text);
  if (claims.length === 0) {
    return { text, verified: [], missing: [], unknown: [] };
  }
  const results = await verifyRepoClaims(claims, opts);
  const { text: rewritten } = rewriteUnverifiedRepoClaims(text, results);
  return {
    text: rewritten,
    verified: results.filter((r) => r.status === "verified"),
    missing: results.filter((r) => r.status === "missing"),
    unknown: results.filter((r) => r.status === "unknown"),
  };
}
