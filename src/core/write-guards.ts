// KCode - Write guards (phase 17)
//
// Two post-Read / pre-Write checks to catch the failure modes we saw
// in the NASA Explorer session:
//
//   1. Skeleton degradation — the model writes a smaller file full of
//      placeholder stubs (`{ /* ... */ }`, `[ /* data */ ]`,
//      `<!-- condensed for brevity -->`) and declares it "refactored"
//      or "organized". Phase 15 (claim-reality) doesn't catch this
//      because the Write succeeds with is_error: false — the file
//      IS written, just with garbage content.
//
//   2. Sibling proliferation — the model writes
//      `nasa-explorer-refactored.html` and then
//      `nasa-explorer-organized.html` as siblings of the original
//      `nasa-explorer.html` instead of editing the original in place.
//      Three files where one was asked for.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

// ─── Skeleton detection ──────────────────────────────────────────

interface SkeletonHit {
  name: string;
  snippet: string;
}

/**
 * Regex signatures that strongly indicate placeholder stubs. Each entry
 * is a single pattern — if it matches, that's one hit. We deliberately
 * keep the patterns narrow so we don't flag real comments.
 */
const SKELETON_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // function body containing only a placeholder comment:
  //   function foo() { /* ... */ }
  //   function bar(x, y) { /* reusable modal system */ }
  {
    name: "empty-fn-body-with-placeholder",
    regex: /\)\s*(?:=>\s*)?\{\s*\/\*[^{}]{1,120}\*\/\s*\}/g,
  },
  // array literal containing only a placeholder comment:
  //   rovers: [ /* Curiosity, Perseverance, Opportunity data */ ]
  //   earthImages: [ /* EPIC images */ ]
  {
    name: "array-with-placeholder-comment",
    regex: /\[\s*\/\*[^\[\]{}]{3,120}\*\/\s*\]/g,
  },
  // object literal containing only a placeholder comment:
  //   apod: { /* ... */ }
  {
    name: "object-with-placeholder-comment",
    regex: /:\s*\{\s*\/\*[^{}]{1,120}\*\/\s*\}/g,
  },
  // HTML "condensed for brevity" style stubs
  {
    name: "condensed-for-brevity",
    regex: /<!--[^>]*\b(?:condensed\s+for\s+brevity|for\s+brevity)\b[^>]*-->/gi,
  },
  // HTML "same pattern as above / follow the same" stubs
  {
    name: "follow-same-pattern",
    regex: /<!--[^>]*\b(?:follow\s+the\s+same|same\s+(?:clean\s+)?pattern\s+as\s+above)\b[^>]*-->/gi,
  },
  // bare placeholder comment lines like `/* ... */` sitting alone
  {
    name: "bare-ellipsis-comment",
    regex: /^\s*\/\*\s*\.\.\.\s*\*\/\s*$/gm,
  },
  // ellipsis-only single-line comments used as body stubs
  //   // ...
  //   # ...
  {
    name: "ellipsis-line-comment",
    regex: /^\s*(?:\/\/|#)\s*\.\.\.\s*$/gm,
  },
];

export interface SkeletonVerdict {
  /** Whether the content has enough placeholder signals to be considered a skeleton. */
  isSkeleton: boolean;
  /** Distinct signature names that matched (deduped). */
  hitNames: string[];
  /** Total number of individual placeholder occurrences across all patterns. */
  totalOccurrences: number;
  /** Up to 5 sample snippets to show the model what triggered the check. */
  samples: SkeletonHit[];
}

export function detectSkeletonContent(content: string): SkeletonVerdict {
  const hitNames: string[] = [];
  const samples: SkeletonHit[] = [];
  let totalOccurrences = 0;

  for (const { name, regex } of SKELETON_PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    let sawOne = false;
    while ((m = regex.exec(content)) !== null) {
      totalOccurrences++;
      sawOne = true;
      if (samples.length < 5) {
        const snippet = m[0].replace(/\s+/g, " ").trim().slice(0, 100);
        samples.push({ name, snippet });
      }
    }
    if (sawOne) hitNames.push(name);
  }

  // Fire when ≥2 DISTINCT signatures match, OR ≥3 total occurrences of
  // any one signature. Distinct signatures catches mixed stubs (the
  // NASA Explorer case: empty-fn-body + array-placeholder +
  // condensed-for-brevity). Total-occurrence threshold catches a file
  // that stubs every function the same way.
  const isSkeleton = hitNames.length >= 2 || totalOccurrences >= 3;
  return { isSkeleton, hitNames, totalOccurrences, samples };
}

// ─── Sibling proliferation detection ─────────────────────────────

/**
 * Suffix words that indicate a "variant" filename — when one of these
 * appears after a hyphen or underscore just before the extension, the
 * model is probably writing a copy instead of editing the original.
 */
const VARIANT_SUFFIXES = new Set([
  "refactored",
  "refactor",
  "organized",
  "organised",
  "cleaned",
  "cleanup",
  "fixed",
  "updated",
  "improved",
  "new",
  "copy",
  "final",
  "backup",
  "old",
  "v2",
  "v3",
  "rewrite",
  "rewritten",
  "revised",
  "improved2",
]);

export interface ProliferationVerdict {
  /** True if target is `<base>-<variant>.<ext>` AND `<base>.<ext>` already exists. */
  isProliferation: boolean;
  /** The existing sibling the model should edit instead. */
  existingSibling: string | null;
  /** Variant suffix that triggered the check (e.g. "refactored"). */
  variant: string | null;
}

export function detectSiblingProliferation(filePath: string): ProliferationVerdict {
  const ext = extname(filePath);
  if (!ext) return { isProliferation: false, existingSibling: null, variant: null };

  const dir = dirname(filePath);
  const name = basename(filePath, ext);

  // Split on the last hyphen or underscore. If the trailing segment
  // is a variant suffix and what's left is non-empty, that's a
  // candidate sibling.
  const m = name.match(/^(.+)[-_]([A-Za-z0-9]+)$/);
  if (!m) return { isProliferation: false, existingSibling: null, variant: null };

  const baseName = m[1]!;
  const suffix = m[2]!.toLowerCase();
  if (!VARIANT_SUFFIXES.has(suffix)) {
    return { isProliferation: false, existingSibling: null, variant: null };
  }

  const siblingPath = join(dir, `${baseName}${ext}`);
  try {
    if (existsSync(siblingPath) && statSync(siblingPath).isFile()) {
      return { isProliferation: true, existingSibling: siblingPath, variant: suffix };
    }
  } catch {
    /* dir not readable — treat as no sibling */
  }
  return { isProliferation: false, existingSibling: null, variant: null };
}

// ─── Report builders ─────────────────────────────────────────────

export function buildSkeletonReport(filePath: string, verdict: SkeletonVerdict): string {
  const lines: string[] = [];
  lines.push(`BLOCKED — FILE NOT CREATED: "${basename(filePath)}" looks like a SKELETON.`);
  lines.push("");
  lines.push(
    `Your content contains ${verdict.totalOccurrences} placeholder stub(s) across ` +
      `${verdict.hitNames.length} distinct signature(s):`,
  );
  for (const h of verdict.samples) {
    lines.push(`  [${h.name}] ${h.snippet}`);
  }
  lines.push("");
  lines.push(
    `Placeholder stubs like \`{ /* ... */ }\`, \`[ /* data */ ]\`, and`,
  );
  lines.push(
    `\`<!-- condensed for brevity -->\` mean the file will NOT function. Writing`,
  );
  lines.push(
    `a skeleton and declaring it "refactored" or "organized" is a completion`,
  );
  lines.push(`hallucination — the user will open the file and see a broken stub.`);
  lines.push("");
  lines.push(`You MUST do ONE of:`);
  lines.push(
    `  a) Re-issue the Write with the FULL implementation inlined — no`,
  );
  lines.push(`     \`/* ... */\` placeholders, no \`<!-- condensed -->\` comments.`);
  lines.push(
    `  b) Use Edit on the ORIGINAL file to make a targeted change instead`,
  );
  lines.push(`     of rewriting from scratch.`);
  lines.push("");
  lines.push(
    `Do NOT tell the user the file was created. It was not.`,
  );
  return lines.join("\n");
}

export function buildProliferationReport(
  filePath: string,
  verdict: ProliferationVerdict,
): string {
  const lines: string[] = [];
  lines.push(`BLOCKED — FILE NOT CREATED: "${basename(filePath)}" would proliferate siblings.`);
  lines.push("");
  lines.push(
    `"${verdict.existingSibling}" already exists. Creating "${basename(filePath)}"`,
  );
  lines.push(
    `alongside it leaves two divergent copies — the user will not know which`,
  );
  lines.push(`one is authoritative, and the next session will find three.`);
  lines.push("");
  lines.push(`You MUST do ONE of:`);
  lines.push(
    `  a) Use Edit or MultiEdit on "${verdict.existingSibling}" to make the`,
  );
  lines.push(`     changes in place.`);
  lines.push(
    `  b) Use Write on "${verdict.existingSibling}" directly to replace its`,
  );
  lines.push(`     contents (NOT a new ${verdict.variant ?? "variant"} copy).`);
  lines.push("");
  lines.push(
    `If the user explicitly asked for a separate file under a different name,`,
  );
  lines.push(
    `pick a name that does NOT look like a variant of an existing file.`,
  );
  return lines.join("\n");
}

// ─── Degradation check (optional strengthener) ───────────────────

/**
 * When skeleton detection fires, check whether the same-basename file
 * already exists in the target directory — if it does and has MORE
 * lines than the new content, that's strong evidence the model is
 * degrading an existing implementation.
 */
export function checkDegradation(
  filePath: string,
  newContent: string,
): { original: string; originalLines: number; newLines: number } | null {
  const dir = dirname(filePath);
  const ext = extname(filePath);
  const name = basename(filePath, ext);

  // Strip any variant suffix to find the original
  const m = name.match(/^(.+)[-_]([A-Za-z0-9]+)$/);
  const candidates: string[] = [filePath];
  if (m && VARIANT_SUFFIXES.has(m[2]!.toLowerCase())) {
    candidates.push(join(dir, `${m[1]}${ext}`));
  }

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      if (candidate === filePath) continue; // skip self
      const original = readFileSync(candidate, "utf-8");
      const originalLines = original.split("\n").length;
      const newLines = newContent.split("\n").length;
      if (originalLines > newLines * 1.3) {
        return { original: candidate, originalLines, newLines };
      }
    } catch {
      /* unreadable — skip */
    }
  }
  return null;
}

// ─── Phase 19: in-place shrinkage detection ──────────────────────
//
// Different from checkDegradation above — that one compares the new
// Write against a SIBLING file (foo.html when writing foo-refactored.html).
// checkShrinkage fires when Write is REPLACING the same file that
// already exists. The NASA Explorer v2.10.54 session showed the model
// overwriting nasa-explorer.html from 901 lines to 554 lines (39%
// shrinkage) in-place, while claiming "behavior is identical" — a
// silent lossy rewrite that neither skeleton detection nor phase 15
// caught.

export interface ShrinkageVerdict {
  /** True if the in-place Write drops below the shrinkage threshold. */
  isShrinking: boolean;
  originalLines: number;
  newLines: number;
  /** New content as a fraction of the original (e.g. 0.61 = new is 61% of original). */
  ratio: number;
}

const SHRINKAGE_MIN_ORIGINAL_LINES = 300;
/** Fire when new content is less than this fraction of the original. */
const SHRINKAGE_MAX_RATIO = 0.65;

export function detectInPlaceShrinkage(
  filePath: string,
  newContent: string,
): ShrinkageVerdict {
  try {
    if (!existsSync(filePath)) {
      return { isShrinking: false, originalLines: 0, newLines: 0, ratio: 1 };
    }
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { isShrinking: false, originalLines: 0, newLines: 0, ratio: 1 };
    }
    const original = readFileSync(filePath, "utf-8");
    const originalLines = original.split("\n").length;
    const newLines = newContent.split("\n").length;
    if (originalLines < SHRINKAGE_MIN_ORIGINAL_LINES) {
      return { isShrinking: false, originalLines, newLines, ratio: 1 };
    }
    const ratio = newLines / originalLines;
    return {
      isShrinking: ratio < SHRINKAGE_MAX_RATIO,
      originalLines,
      newLines,
      ratio,
    };
  } catch {
    return { isShrinking: false, originalLines: 0, newLines: 0, ratio: 1 };
  }
}

export function buildShrinkageReport(
  filePath: string,
  verdict: ShrinkageVerdict,
): string {
  const pct = Math.round((1 - verdict.ratio) * 100);
  const lines: string[] = [];
  lines.push(
    `BLOCKED — FILE NOT OVERWRITTEN: "${basename(filePath)}" would shrink by ${pct}%.`,
  );
  lines.push("");
  lines.push(
    `Original: ${verdict.originalLines} lines. Your new content: ${verdict.newLines} lines.`,
  );
  lines.push(
    `That's a ${pct}% reduction on a file that already works. Rewriting a large`,
  );
  lines.push(
    `file from scratch in one Write almost always drops features silently —`,
  );
  lines.push(
    `the model writes what it remembers, not what's actually there.`,
  );
  lines.push("");
  lines.push(`You MUST do ONE of:`);
  lines.push(
    `  a) Use Edit / MultiEdit for targeted changes. Keep the original file`,
  );
  lines.push(
    `     intact and change only the specific lines that need to change.`,
  );
  lines.push(
    `  b) If you genuinely want a full rewrite, first LIST every feature in`,
  );
  lines.push(
    `     the original (counters, modals, event handlers, animations, data`,
  );
  lines.push(
    `     structures, keyboard shortcuts) and confirm each one is in your new`,
  );
  lines.push(`     content. Do NOT claim "behavior is identical" without that check.`);
  lines.push(
    `  c) If the user explicitly asked for a shorter version, include that`,
  );
  lines.push(
    `     intent in your response and list the features you are removing.`,
  );
  lines.push("");
  lines.push(
    `Do NOT tell the user "behavior is identical" after a ${pct}% shrink —`,
  );
  lines.push(`that claim is almost certainly false.`);
  return lines.join("\n");
}
