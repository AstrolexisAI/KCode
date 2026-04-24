// KCode - Reference Extractor (v2.10.306, #111 github-claim bug)
//
// Generalizes reference-memory's numbered-list capture to cover the
// shapes the model actually emits when listing repositories /
// projects / resources:
//
//   1. nasa/openmct — telemetry viewer
//   • nasa/openmct — telemetry viewer
//   - [nasa/OnAIR](https://github.com/nasa/OnAIR) — on-board AI
//   | nasa/openmct | telemetry |  (tables)
//
// Session log that motivated this: v305 shipped with a strictly
// numeric LINE_RE. The assistant then emitted a bullet list of
// `• nasa/openmct — ...` items and reference-memory captured
// nothing. Follow-up ordinal prompts had no list to resolve against.
//
// This extractor:
//   * accepts multiple list shapes
//   * locates the `owner/repo` token inside each matched line
//   * assigns ordinal by appearance when no explicit rank is given
//   * requires ≥3 items in a nearby block (rejects stray mentions)

// ─── Types ───────────────────────────────────────────────────────

export interface GithubRepoListItem {
  /** 1-based ordinal (assigned by appearance when the source list had none). */
  ordinal: number;
  /** Normalized "owner/repo". */
  repo: string;
  /** Full URL when one was present on the line, else synthesized. */
  url?: string;
  /** Optional short description that followed the repo on the line. */
  title?: string;
  /**
   * Verified means the repo was resolved against an external source
   * (WebFetch/github API). Raw capture starts at false.
   */
  verified: boolean;
}

export interface CapturedList {
  kind: "github_repo_list";
  title?: string;
  items: GithubRepoListItem[];
}

// ─── Regex building blocks ───────────────────────────────────────

/** owner/repo shape. Owner: 1-39 chars, alnum + hyphen. Repo: 1-100 chars. */
const OWNER_REPO_RE =
  /(?<![./\w-])([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})(?![\/\w])/g;

/** Markdown link [label](url) */
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Bullet prefix (•, -, *). Accepts one leading emoji + whitespace. */
const BULLET_LINE_RE = /^\s*(?:[•\-*]|[\u{1F300}-\u{1FAFF}]\s+[•\-*])\s+/u;

/** Numbered prefix. */
const NUMBERED_LINE_RE = /^\s*(?:\[#?(\d{1,3})\]|(\d{1,3})[.)])\s+/;

/** Table row (pipe-delimited). */
const TABLE_ROW_RE = /^\s*\|.*\|.*\|.*$/;

// Common tokens that look like owner/repo but aren't (paths, globs, regex fragments).
const STOP_LIST = new Set([
  "and/or",
  "i/o",
  "his/her",
  "he/she",
]);

// ─── Main extractor ──────────────────────────────────────────────

export function extractRepoList(text: string): CapturedList | null {
  const lines = text.split(/\r?\n/);

  // Phase 1: scan every line, collect candidates with a shape and the
  // repo/url pair if present.
  const candidates: Array<{
    lineIdx: number;
    shape: "numbered" | "bullet" | "table" | "markdown_link_only" | "plain";
    explicitOrdinal?: number;
    repos: Array<{ repo: string; url?: string; title?: string }>;
  }> = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.trim().length === 0) continue;

    const numberedMatch = raw.match(NUMBERED_LINE_RE);
    const isBullet = BULLET_LINE_RE.test(raw);
    const isTable = TABLE_ROW_RE.test(raw);

    const repos = extractReposFromLine(raw);
    if (repos.length === 0) continue;

    let shape: typeof candidates[number]["shape"] = "plain";
    let explicitOrdinal: number | undefined;

    if (numberedMatch) {
      shape = "numbered";
      explicitOrdinal = parseInt(
        numberedMatch[1] ?? numberedMatch[2] ?? "0",
        10,
      );
    } else if (isBullet) {
      shape = "bullet";
    } else if (isTable) {
      shape = "table";
    } else if (MD_LINK_RE.test(raw) && repos.length > 0) {
      shape = "markdown_link_only";
    }

    candidates.push({ lineIdx: i, shape, explicitOrdinal, repos });
  }

  if (candidates.length < 3) return null;

  // Phase 2: find a contiguous-ish block of ≥3 candidates of the same
  // shape family (bullets/numbered/table). "Contiguous-ish" means no
  // more than 2 blank lines between consecutive candidates.
  const blocks: Array<typeof candidates> = [];
  let currentBlock: typeof candidates = [];
  let lastIdx = -999;

  for (const c of candidates) {
    const gap = c.lineIdx - lastIdx;
    if (gap > 3 && currentBlock.length > 0) {
      blocks.push(currentBlock);
      currentBlock = [];
    }
    currentBlock.push(c);
    lastIdx = c.lineIdx;
  }
  if (currentBlock.length > 0) blocks.push(currentBlock);

  const block = blocks
    .filter((b) => b.length >= 3)
    .sort((a, b) => b.length - a.length)[0];
  if (!block) return null;

  // Phase 3: flatten the block into GithubRepoListItem[].
  const items: GithubRepoListItem[] = [];
  const seenRepos = new Set<string>();
  let autoOrdinal = 1;

  for (const c of block) {
    for (const r of c.repos) {
      if (seenRepos.has(r.repo)) continue;
      seenRepos.add(r.repo);
      const ordinal =
        c.explicitOrdinal && c.explicitOrdinal > 0 && c.explicitOrdinal < 200
          ? c.explicitOrdinal
          : autoOrdinal;
      items.push({
        ordinal,
        repo: r.repo,
        url: r.url ?? `https://github.com/${r.repo}`,
        title: r.title,
        verified: false,
      });
      autoOrdinal = Math.max(autoOrdinal + 1, ordinal + 1);
    }
  }

  if (items.length < 3) return null;

  // Sort by ordinal so resolveOrdinal lookup stays deterministic.
  items.sort((a, b) => a.ordinal - b.ordinal);

  return { kind: "github_repo_list", items };
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Pull every owner/repo token from a line, including ones that come
 * from a markdown link. Preserves URL context when present.
 */
function extractReposFromLine(
  line: string,
): Array<{ repo: string; url?: string; title?: string }> {
  const out: Array<{ repo: string; url?: string; title?: string }> = [];
  const seen = new Set<string>();

  // Markdown-link owner/repo — e.g. [nasa/OnAIR](https://github.com/nasa/OnAIR)
  // This catches cases where the visible label already is "owner/repo".
  const linkRe = new RegExp(MD_LINK_RE.source, "g");
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = linkRe.exec(line)) !== null) {
    const label = mdMatch[1] ?? "";
    const url = mdMatch[2] ?? "";
    // Try to find owner/repo in the label; fall back to the URL.
    const repoFromLabel = firstRepo(label);
    const repoFromUrl = extractRepoFromGithubUrl(url);
    const repo = repoFromLabel ?? repoFromUrl;
    if (repo && !seen.has(repo)) {
      seen.add(repo);
      out.push({ repo, url, title: stripBackticks(label).trim() });
    }
  }

  // Raw owner/repo tokens (backtick or plain).
  const rawRe = new RegExp(OWNER_REPO_RE.source, "g");
  let rawMatch: RegExpExecArray | null;
  while ((rawMatch = rawRe.exec(line)) !== null) {
    const owner = rawMatch[1] ?? "";
    const name = rawMatch[2] ?? "";
    const repo = `${owner}/${name}`;
    if (STOP_LIST.has(repo.toLowerCase())) continue;
    if (name === "" || owner === "") continue;
    // Skip obvious file-path false positives: contains a dot-slash, or
    // the "repo" has a file extension like .md / .ts / .py.
    if (/\.(md|ts|tsx|js|jsx|py|rs|go|java|rb|sh|txt|json|yml|yaml)$/i.test(name)) continue;
    if (!seen.has(repo)) {
      seen.add(repo);
      // Look for a description after an em dash or colon on the line.
      const descMatch = line.match(/(?:—|:)\s*(.+?)\s*$/);
      out.push({ repo, title: descMatch ? descMatch[1] : undefined });
    }
  }

  return out;
}

function firstRepo(text: string): string | null {
  const re = new RegExp(OWNER_REPO_RE.source);
  const m = text.match(re);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

function extractRepoFromGithubUrl(url: string): string | null {
  const m = url.match(/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})(?:[/?#]|$)/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

function stripBackticks(s: string): string {
  return s.replace(/`+/g, "");
}

// ─── Bridge to reference-memory ──────────────────────────────────

/**
 * Convert a CapturedList into reference-memory RankedListItem[] so
 * the existing ordinal resolver keeps working.
 */
export function capturedListToRankedItems(
  list: CapturedList,
): Array<{ rank: number; id: string; title: string; url?: string }> {
  return list.items.map((it) => ({
    rank: it.ordinal,
    id: it.repo,
    title: it.repo,
    url: it.url,
  }));
}
