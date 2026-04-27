// KCode - Reference Memory (v305, #111 ordinal-resolution fix)
//
// Stores structured references the assistant emitted in recent turns
// — ranked lists of repos/projects/files, named selections, etc. —
// so that follow-up prompts like "clona el proyecto 6" / "abre #2"
// resolve to the correct item BEFORE the model's free-text recall
// can drift.
//
// Why this exists: session showed the assistant listed 10 NASA
// repos as (1) openmct ... (6) cumulus ... (7) ogma, user typed
// "clona el proyecto 6", but KCode cloned ogma (#7). The model's
// token-level recall of the list had drifted. Structured capture +
// explicit resolution kills that class of bug.

// ─── Types ───────────────────────────────────────────────────────

export interface RankedListItem {
  rank: number;
  id: string;
  title: string;
  url?: string;
  metadata?: Record<string, string | number>;
}

export type RecentReference =
  | {
      kind: "ranked_list";
      label: string;
      createdAtTurn: number;
      items: RankedListItem[];
    }
  | {
      kind: "selection";
      key: string;
      value: { id: string; title: string; url?: string };
      createdAtTurn: number;
    };

// ─── In-memory store ─────────────────────────────────────────────

const _references: RecentReference[] = [];
let _currentTurn = 0;
/** Capped history. Older entries drop off. */
const MAX_HISTORY = 8;

/** Called by post-turn when a new assistant turn completes. */
export function bumpTurnCounter(): void {
  _currentTurn++;
}

export function currentTurn(): number {
  return _currentTurn;
}

/** Record a structured ranked list (auto-captured or explicitly added). */
export function recordRankedList(label: string, items: RankedListItem[]): void {
  if (items.length === 0) return;
  _references.push({
    kind: "ranked_list",
    label,
    createdAtTurn: _currentTurn,
    items,
  });
  while (_references.length > MAX_HISTORY) _references.shift();
}

/** Record a specific selection (e.g. "we're now working on X"). */
export function recordSelection(
  key: string,
  value: { id: string; title: string; url?: string },
): void {
  _references.push({
    kind: "selection",
    key,
    value,
    createdAtTurn: _currentTurn,
  });
  while (_references.length > MAX_HISTORY) _references.shift();
}

/** Most recent ranked list, newest first. */
export function getLastRankedList(): RecentReference | null {
  for (let i = _references.length - 1; i >= 0; i--) {
    const r = _references[i]!;
    if (r.kind === "ranked_list") return r;
  }
  return null;
}

/** Reset — tests only. */
export function resetReferences(): void {
  _references.length = 0;
  _currentTurn = 0;
}

/** Introspection for tests / debugging. */
export function allReferences(): readonly RecentReference[] {
  return _references;
}

// ─── Ranked-list extraction from assistant text ──────────────────

/**
 * Scan an assistant text block for a numbered/bulleted list where
 * each item references a URL or identifiable title. Captures the
 * first such list found. Returns null when no matchable list exists.
 *
 * Patterns recognized:
 *   1. **title** (N stars): description. url
 *   1. title — description (github.com/org/repo)
 *   [#1] title — description
 *   1) title: description — https://...
 */
const HEAD_RE =
  /^\s*(?:\[#?(\d{1,3})\]|(\d{1,3})[.)])\s+(?:\*\*)?([^*:—\n(]+?)(?:\*\*)?(?=\s*(?:[:—(-]|$))/;
const URL_RE = /\b(https?:\/\/[^\s)]+)/i;
const SHORT_URL_RE = /\b([a-z0-9.-]+\.[a-z]{2,}\/[\w./-]+)\b/i;

export function extractRankedListFromText(text: string, label: string = "items"): RankedListItem[] {
  const items: RankedListItem[] = [];
  const lines = text.split(/\r?\n/);
  const seenRanks = new Set<number>();
  for (const line of lines) {
    const m = line.match(HEAD_RE);
    if (!m) continue;
    const rank = parseInt(m[1] ?? m[2] ?? "0", 10);
    if (!Number.isFinite(rank) || rank < 1 || rank > 200) continue;
    if (seenRanks.has(rank)) continue;
    const title = (m[3] ?? "").trim();
    if (!title || title.length > 120) continue;
    // URL is captured separately from the rest of the line so the
    // title pattern can stay loose (matches markdown emphasis, em
    // dashes, parens) without eating the URL.
    const rest = line.slice(m[0].length);
    const urlMatch = rest.match(URL_RE);
    const shortMatch = !urlMatch ? rest.match(SHORT_URL_RE) : null;
    const url = urlMatch?.[1] ?? (shortMatch ? `https://${shortMatch[1]}` : undefined);
    items.push({
      rank,
      id: url ?? title.toLowerCase().replace(/\s+/g, "-"),
      title,
      url,
    });
    seenRanks.add(rank);
  }
  // Require at least 3 items with sequential ranks to qualify — avoids
  // capturing stray "1. intro" preambles.
  if (items.length < 3) return [];
  items.sort((a, b) => a.rank - b.rank);
  // Sanity: ranks roughly contiguous 1..N
  const maxRank = items[items.length - 1]!.rank;
  if (maxRank - items[0]!.rank > items.length * 2) return [];
  void label;
  return items;
}

// ─── Ordinal resolution ──────────────────────────────────────────

/**
 * Detect an ordinal reference in a user prompt. Returns the rank the
 * user meant + a textual snippet for logging, or null when no ordinal
 * shape is present.
 *
 * Patterns:
 *   "clona el proyecto 6" → 6
 *   "abre el repo 2"      → 2
 *   "el sexto"            → 6
 *   "número 3"            → 3
 *   "#4"                  → 4
 */
const SPANISH_ORDINALS: Record<string, number> = {
  primero: 1,
  primera: 1,
  segundo: 2,
  segunda: 2,
  tercero: 3,
  tercera: 3,
  cuarto: 4,
  cuarta: 4,
  quinto: 5,
  quinta: 5,
  sexto: 6,
  sexta: 6,
  séptimo: 7,
  septima: 7,
  séptima: 7,
  octavo: 8,
  octava: 8,
  noveno: 9,
  novena: 9,
  décimo: 10,
  decima: 10,
  décima: 10,
};
const ENGLISH_ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

export function detectOrdinalReference(text: string): { rank: number; snippet: string } | null {
  const lower = text.toLowerCase();

  // "#N" form (explicit anchor)
  const hash = lower.match(/(?:^|\s)#(\d{1,3})\b/);
  if (hash) {
    const rank = parseInt(hash[1]!, 10);
    return { rank, snippet: `#${rank}` };
  }

  // "proyecto N" / "repo N" / "item N" / "número N"
  const noun = lower.match(
    /\b(?:proyecto|repo|repositorio|item|número|number|project)\s+(\d{1,3})\b/,
  );
  if (noun) {
    const rank = parseInt(noun[1]!, 10);
    return { rank, snippet: `#${rank}` };
  }

  // Spanish ordinal word
  for (const [word, rank] of Object.entries(SPANISH_ORDINALS)) {
    const re = new RegExp(`\\bel\\s+${word}\\b`, "i");
    if (re.test(text)) return { rank, snippet: `#${rank} (${word})` };
  }
  // English ordinal word
  for (const [word, rank] of Object.entries(ENGLISH_ORDINALS)) {
    const re = new RegExp(`\\bthe\\s+${word}\\b`, "i");
    if (re.test(text)) return { rank, snippet: `#${rank} (${word})` };
  }

  return null;
}

/**
 * Resolve an ordinal reference against the most recent ranked list.
 * Returns null when the list is stale (>3 turns old), absent, or the
 * rank is out of range. Returns a typed result for the caller to
 * anchor visibly before executing the action.
 */
export function resolveOrdinal(
  userPrompt: string,
): { rank: number; item: RankedListItem; listLabel: string } | null {
  const ord = detectOrdinalReference(userPrompt);
  if (!ord) return null;

  const list = getLastRankedList();
  if (!list || list.kind !== "ranked_list") return null;

  // Staleness: refuse to resolve if the list was emitted >3 turns ago.
  // User is likely referring to something more recent.
  if (_currentTurn - list.createdAtTurn > 3) return null;

  const item = list.items.find((it) => it.rank === ord.rank);
  if (!item) return null;
  return { rank: ord.rank, item, listLabel: list.label };
}

// ─── Destructive-action detection ────────────────────────────────

const DESTRUCTIVE_ACTION_RE =
  /\b(?:clona|clone|clonar|abre|open|abrir|borra|borrar|delete|elimina|eliminar|instala|install|instalar|cambiar\s+a|checkout|pull)\b/i;

export function hasDestructiveActionIntent(text: string): boolean {
  return DESTRUCTIVE_ACTION_RE.test(text);
}
