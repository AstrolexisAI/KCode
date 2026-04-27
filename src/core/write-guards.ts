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
    regex: /\[\s*\/\*[^[\]{}]{3,120}\*\/\s*\]/g,
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
    regex:
      /<!--[^>]*\b(?:follow\s+the\s+same|same\s+(?:clean\s+)?pattern\s+as\s+above)\b[^>]*-->/gi,
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
  lines.push(`Placeholder stubs like \`{ /* ... */ }\`, \`[ /* data */ ]\`, and`);
  lines.push(`\`<!-- condensed for brevity -->\` mean the file will NOT function. Writing`);
  lines.push(`a skeleton and declaring it "refactored" or "organized" is a completion`);
  lines.push(`hallucination — the user will open the file and see a broken stub.`);
  lines.push("");
  lines.push(`You MUST do ONE of:`);
  lines.push(`  a) Re-issue the Write with the FULL implementation inlined — no`);
  lines.push(`     \`/* ... */\` placeholders, no \`<!-- condensed -->\` comments.`);
  lines.push(`  b) Use Edit on the ORIGINAL file to make a targeted change instead`);
  lines.push(`     of rewriting from scratch.`);
  lines.push("");
  lines.push(`Do NOT tell the user the file was created. It was not.`);
  return lines.join("\n");
}

export function buildProliferationReport(filePath: string, verdict: ProliferationVerdict): string {
  const lines: string[] = [];
  lines.push(`BLOCKED — FILE NOT CREATED: "${basename(filePath)}" would proliferate siblings.`);
  lines.push("");
  lines.push(`"${verdict.existingSibling}" already exists. Creating "${basename(filePath)}"`);
  lines.push(`alongside it leaves two divergent copies — the user will not know which`);
  lines.push(`one is authoritative, and the next session will find three.`);
  lines.push("");
  lines.push(`You MUST do ONE of:`);
  lines.push(`  a) Use Edit or MultiEdit on "${verdict.existingSibling}" to make the`);
  lines.push(`     changes in place.`);
  lines.push(`  b) Use Write on "${verdict.existingSibling}" directly to replace its`);
  lines.push(`     contents (NOT a new ${verdict.variant ?? "variant"} copy).`);
  lines.push("");
  lines.push(`If the user explicitly asked for a separate file under a different name,`);
  lines.push(`pick a name that does NOT look like a variant of an existing file.`);
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

export function detectInPlaceShrinkage(filePath: string, newContent: string): ShrinkageVerdict {
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

export function buildShrinkageReport(filePath: string, verdict: ShrinkageVerdict): string {
  const pct = Math.round((1 - verdict.ratio) * 100);
  const lines: string[] = [];
  lines.push(`BLOCKED — FILE NOT OVERWRITTEN: "${basename(filePath)}" would shrink by ${pct}%.`);
  lines.push("");
  lines.push(
    `Original: ${verdict.originalLines} lines. Your new content: ${verdict.newLines} lines.`,
  );
  lines.push(`That's a ${pct}% reduction on a file that already works. Rewriting a large`);
  lines.push(`file from scratch in one Write almost always drops features silently —`);
  lines.push(`the model writes what it remembers, not what's actually there.`);
  lines.push("");
  lines.push(`You MUST do ONE of:`);
  lines.push(`  a) Use Edit / MultiEdit for targeted changes. Keep the original file`);
  lines.push(`     intact and change only the specific lines that need to change.`);
  lines.push(`  b) If you genuinely want a full rewrite, first LIST every feature in`);
  lines.push(`     the original (counters, modals, event handlers, animations, data`);
  lines.push(`     structures, keyboard shortcuts) and confirm each one is in your new`);
  lines.push(`     content. Do NOT claim "behavior is identical" without that check.`);
  lines.push(`  c) If the user explicitly asked for a shorter version, include that`);
  lines.push(`     intent in your response and list the features you are removing.`);
  lines.push("");
  lines.push(`Do NOT tell the user "behavior is identical" after a ${pct}% shrink —`);
  lines.push(`that claim is almost certainly false.`);
  return lines.join("\n");
}

// ─── Phase 21: unsolicited documentation files ───────────────────
//
// The Orbital NASA Dashboard session showed the model creating 10
// files (orbital.html + server.js + package.json + README.md +
// QUICK_START.md + .gitignore + TECHNICAL_REFERENCE.md + INSTALLATION_
// CHECK.md + INDEX.md + SUMMARY.txt) when the user had asked for "un
// solo archivo HTML completo, autónomo y bonito" with the server as
// an in-file comment. ~1,851 lines of documentation fabricated on the
// spot, none of it requested.
//
// Phase 21 respects intent. Doc files are NOT always wrong — if the
// user says "crea un proyecto completo" / "full project" / "repositorio"
// or explicitly mentions docs, the model should be free to create them.
// But when the user asks for a single file or doesn't mention docs
// at all, a Write to README.md / QUICK_START.md / TECHNICAL_REFERENCE.md
// is scope drift and gets blocked.

/**
 * Basename patterns that indicate a documentation file. Matched
 * case-insensitively against basename(filePath).
 */
const DOC_FILENAME_PATTERNS: RegExp[] = [
  /^README(\.\w+)?$/i,
  /^CHANGELOG(\.\w+)?$/i,
  /^CONTRIBUTING(\.\w+)?$/i,
  /^CODE_OF_CONDUCT(\.\w+)?$/i,
  /^AUTHORS(\.\w+)?$/i,
  /^QUICK[_-]?START(\.\w+)?$/i,
  /^GETTING[_-]?STARTED(\.\w+)?$/i,
  /^INSTALLATION(_\w+)?(\.\w+)?$/i,
  /^INSTALL(\.\w+)?$/i,
  /^USAGE(\.\w+)?$/i,
  /^API(\.\w+)?$/i,
  /^INDEX\.md$/i,
  /^SUMMARY(\.\w+)?$/i,
  /^TROUBLESHOOTING(\.\w+)?$/i,
  /^FAQ(\.\w+)?$/i,
  /^GUIDE(\.\w+)?$/i,
  /^MANUAL(\.\w+)?$/i,
  /^TUTORIAL(\.\w+)?$/i,
  /^NOTES?(\.\w+)?$/i,
  /^DEPLOYMENT(\.\w+)?$/i,
  /^ARCHITECTURE(\.\w+)?$/i,
  /^DESIGN(\.\w+)?$/i,
  /_REFERENCE\.(md|txt|rst)$/i,
  /_GUIDE\.(md|txt|rst)$/i,
  /_NOTES\.(md|txt|rst)$/i,
  /_DOCS?\.(md|txt|rst)$/i,
  /^TECHNICAL[_-]\w+\.(md|txt|rst)$/i,
  /^PROJECT[_-]\w+\.(md|txt|rst)$/i,
];

export function isDocFilename(filePath: string): boolean {
  const name = basename(filePath);
  return DOC_FILENAME_PATTERNS.some((re) => re.test(name));
}

/**
 * Keywords in the user's request that grant the model permission to
 * create documentation files. The user either explicitly asked for
 * docs OR signaled they want a full project/repo/deliverable.
 */
const DOC_ALLOWANCE_KEYWORDS = [
  // direct doc requests
  /\bread\s*me\b/i,
  /\breadme\b/i,
  /\bdocument/i, // matches document, documentation, documenta, documentaci[oó]n
  /\bdocs?\b/i,
  /\bdoc\s+(?:files?|comments?)\b/i,
  /\bguide\b/i,
  /\bgu[ií]a\b/i,
  /\btutorial\b/i,
  /\bchangelog\b/i,
  /\bmanual\b/i,
  /\binstructions\b/i,
  /\binstrucciones\b/i,
  /\bquick\s*start\b/i,
  /\btroubleshoot/i,
  // project-completeness signals
  /\bcomplete\s+project\b/i,
  /\bfull\s+project\b/i,
  /\bproyecto\s+completo\b/i,
  /\brepositorio\b/i,
  /\brepository\b/i,
  /\bboilerplate\b/i,
  /\bscaffold(?:ing)?\b/i,
  /\bstarter\s*kit\b/i,
  /\bdeliverable\b/i,
  /\bentrega(?:ble)?\b/i,
  /\bvarios\s+archivos\b/i,
  /\bm[uú]ltiples?\s+archivos\b/i,
  /\bmultiple\s+files\b/i,
];

/**
 * Look at the user-authored text messages in the conversation and
 * determine whether they granted doc-creation permission. Considers
 * ALL user text messages — the user might set scope in an earlier
 * turn and keep issuing small follow-ups after.
 */
export function userAllowedDocs(userTexts: readonly string[]): {
  allowed: boolean;
  matchedKeyword: string | null;
} {
  for (const text of userTexts) {
    if (!text) continue;
    for (const re of DOC_ALLOWANCE_KEYWORDS) {
      const m = text.match(re);
      if (m) return { allowed: true, matchedKeyword: m[0] };
    }
  }
  return { allowed: false, matchedKeyword: null };
}

export interface UnsolicitedDocVerdict {
  isUnsolicitedDoc: boolean;
  filename: string;
  /** Matched keyword if the user DID allow docs. Empty string if blocked. */
  allowanceKeyword: string;
}

/**
 * Combined check: is this Write creating a doc file that the user did
 * not ask for? Returns isUnsolicitedDoc=true when the filename matches
 * the doc blocklist AND none of the user's text messages contain a
 * doc-allowance keyword.
 */
export function detectUnsolicitedDoc(
  filePath: string,
  userTexts: readonly string[],
): UnsolicitedDocVerdict {
  const filename = basename(filePath);
  if (!isDocFilename(filePath)) {
    return { isUnsolicitedDoc: false, filename, allowanceKeyword: "" };
  }
  const { allowed, matchedKeyword } = userAllowedDocs(userTexts);
  if (allowed) {
    return {
      isUnsolicitedDoc: false,
      filename,
      allowanceKeyword: matchedKeyword ?? "",
    };
  }
  return { isUnsolicitedDoc: true, filename, allowanceKeyword: "" };
}

export function buildUnsolicitedDocReport(verdict: UnsolicitedDocVerdict): string {
  const lines: string[] = [];
  lines.push(
    `BLOCKED — FILE NOT CREATED: "${verdict.filename}" looks like an unsolicited documentation file.`,
  );
  lines.push("");
  lines.push(`The user did NOT ask for docs. None of their messages in this`);
  lines.push(`conversation contain any of: readme, documentation, guide, docs,`);
  lines.push(`tutorial, changelog, instructions, manual, complete project, full`);
  lines.push(`project, proyecto completo, repositorio, boilerplate, scaffold,`);
  lines.push(`deliverable, multiple files, varios archivos.`);
  lines.push("");
  lines.push(`The Write tool description is explicit: "NEVER create documentation`);
  lines.push(`files (*.md) or README files unless explicitly requested by the`);
  lines.push(`User." This file is blocked for that reason.`);
  lines.push("");
  lines.push(`You MUST do ONE of:`);
  lines.push(`  a) If the user asked for a single file or a specific deliverable,`);
  lines.push(`     put any explanatory text as inline comments in that file instead`);
  lines.push(`     of a separate doc.`);
  lines.push(`  b) Skip the doc. Finish the real task. If the user wants a README`);
  lines.push(`     later, they'll ask.`);
  lines.push(`  c) If you believe the user DID ask for docs and the detection is`);
  lines.push(`     wrong, re-read their request carefully. Common trigger phrases`);
  lines.push(`     are "full project", "complete repo", "README", "documentation".`);
  lines.push(`     If none of those are there, they did not ask for docs.`);
  lines.push("");
  lines.push(`Do NOT tell the user you created "${verdict.filename}" — you did not.`);
  return lines.join("\n");
}
