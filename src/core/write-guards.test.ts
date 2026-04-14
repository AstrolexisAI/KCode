// Tests for phase 17 — skeleton detection + sibling proliferation guards
// on the Write tool.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProliferationReport,
  buildShrinkageReport,
  buildSkeletonReport,
  buildUnsolicitedDocReport,
  checkDegradation,
  detectInPlaceShrinkage,
  detectSiblingProliferation,
  detectSkeletonContent,
  detectUnsolicitedDoc,
  isDocFilename,
  userAllowedDocs,
} from "./write-guards";

describe("detectSkeletonContent", () => {
  test("fires on NASA Explorer-style skeleton (mixed stubs)", () => {
    const content = `
      const DATA = {
        apod: { /* ... */ },
        rovers: [ /* Curiosity, Perseverance, Opportunity data */ ],
        earthImages: [ /* EPIC images */ ],
        launches: [ /* Upcoming launches */ ]
      };

      function hideModals() { /* ... */ }
      function showModal(title, html, actions = '') { /* reusable modal system */ }

      <!-- ==================== EARTH & LIVE & FACTS (condensed for brevity) ==================== -->
      <!-- (Sections for Earth, Live, Quick Facts, Footer, and Modals follow the same clean pattern as above) -->
    `;
    const v = detectSkeletonContent(content);
    expect(v.isSkeleton).toBe(true);
    expect(v.hitNames.length).toBeGreaterThanOrEqual(2);
    expect(v.totalOccurrences).toBeGreaterThanOrEqual(5);
  });

  test("does not fire on real code with ordinary comments", () => {
    const content = `
      // Main entry point
      function init() {
        const config = loadConfig();
        /* TOCTOU-safe: we re-check after fd open */
        return config;
      }

      /**
       * Handles incoming requests.
       * Returns a parsed result.
       */
      function handle(req) {
        return parse(req);
      }
    `;
    const v = detectSkeletonContent(content);
    expect(v.isSkeleton).toBe(false);
  });

  test("fires on 3+ empty function bodies in a row", () => {
    const content = `
      function renderMarsGallery(index) { /* ... */ }
      function renderEarthGrid() { /* ... */ }
      function renderLaunches() { /* ... */ }
    `;
    const v = detectSkeletonContent(content);
    expect(v.isSkeleton).toBe(true);
  });

  test("fires on condensed-for-brevity HTML comment + one more signal", () => {
    const content = `
      <section>real content</section>
      <!-- condensed for brevity -->
      <!-- follow the same pattern as above -->
    `;
    const v = detectSkeletonContent(content);
    expect(v.isSkeleton).toBe(true);
  });

  test("single ordinary /* ... */ stub alone does not fire", () => {
    const content = `
      function f() {
        return 42;
      }
      // one TODO-style note
      // ...
    `;
    const v = detectSkeletonContent(content);
    expect(v.isSkeleton).toBe(false);
  });
});

describe("detectSiblingProliferation", () => {
  test("flags foo-refactored.html when foo.html exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "kcode-prolif-"));
    try {
      writeFileSync(join(dir, "nasa-explorer.html"), "<html></html>");
      const v = detectSiblingProliferation(join(dir, "nasa-explorer-refactored.html"));
      expect(v.isProliferation).toBe(true);
      expect(v.variant).toBe("refactored");
      expect(v.existingSibling).toBe(join(dir, "nasa-explorer.html"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flags foo-organized.html when foo.html exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "kcode-prolif-"));
    try {
      writeFileSync(join(dir, "nasa-explorer.html"), "<html></html>");
      const v = detectSiblingProliferation(join(dir, "nasa-explorer-organized.html"));
      expect(v.isProliferation).toBe(true);
      expect(v.variant).toBe("organized");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT flag when the base file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "kcode-prolif-"));
    try {
      const v = detectSiblingProliferation(join(dir, "nasa-explorer-refactored.html"));
      expect(v.isProliferation).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT flag non-variant suffixes (e.g. foo-utils.ts)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kcode-prolif-"));
    try {
      writeFileSync(join(dir, "foo.ts"), "export {};");
      const v = detectSiblingProliferation(join(dir, "foo-utils.ts"));
      expect(v.isProliferation).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT flag a file with no hyphen (regular new file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kcode-prolif-"));
    try {
      const v = detectSiblingProliferation(join(dir, "newfile.html"));
      expect(v.isProliferation).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flags underscore variant (foo_refactored.py when foo.py exists)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kcode-prolif-"));
    try {
      writeFileSync(join(dir, "parser.py"), "pass");
      const v = detectSiblingProliferation(join(dir, "parser_refactored.py"));
      expect(v.isProliferation).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkDegradation", () => {
  test("flags when original file has significantly more lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "kcode-degrade-"));
    try {
      const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
      writeFileSync(join(dir, "nasa.html"), big);
      const tinyContent = "line 1\nline 2\nline 3\n";
      const d = checkDegradation(join(dir, "nasa-refactored.html"), tinyContent);
      expect(d).not.toBeNull();
      expect(d!.originalLines).toBe(100);
      expect(d!.newLines).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT flag when new content is similar or larger", () => {
    const dir = mkdtempSync(join(tmpdir(), "kcode-degrade-"));
    try {
      const small = "line 1\nline 2\n";
      writeFileSync(join(dir, "nasa.html"), small);
      const similarContent = "line 1\nline 2\nline 3\n";
      const d = checkDegradation(join(dir, "nasa-refactored.html"), similarContent);
      expect(d).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("report builders", () => {
  test("skeleton report contains actionable language", () => {
    const v = detectSkeletonContent(
      `function a() { /* ... */ }\nfunction b() { /* ... */ }\nrovers: [ /* data */ ]`,
    );
    const report = buildSkeletonReport("/tmp/foo.html", v);
    expect(report).toContain("BLOCKED");
    expect(report).toContain("SKELETON");
    expect(report).toContain("NOT function");
    expect(report).toContain("FULL implementation");
    expect(report).toContain("Do NOT tell the user the file was created");
  });

  test("proliferation report names both files and suggests Edit", () => {
    const report = buildProliferationReport("/tmp/foo-refactored.html", {
      isProliferation: true,
      existingSibling: "/tmp/foo.html",
      variant: "refactored",
    });
    expect(report).toContain("BLOCKED");
    expect(report).toContain("/tmp/foo.html");
    expect(report).toContain("foo-refactored.html");
    expect(report).toContain("Edit");
  });
});

// ─── Phase 19: in-place shrinkage detection ─────────────────────

describe("detectInPlaceShrinkage", () => {
  test("fires on NASA Explorer-style 901 → 554 line in-place rewrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "kcode-shrink-"));
    try {
      const original = Array.from({ length: 901 }, (_, i) => `line ${i}`).join("\n");
      const target = join(dir, "nasa-explorer.html");
      writeFileSync(target, original);
      const newContent = Array.from({ length: 554 }, (_, i) => `line ${i}`).join("\n");
      const v = detectInPlaceShrinkage(target, newContent);
      expect(v.isShrinking).toBe(true);
      expect(v.originalLines).toBe(901);
      expect(v.newLines).toBe(554);
      expect(v.ratio).toBeLessThan(0.65);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT fire when new content is larger than original", () => {
    const dir = mkdtempSync(join(tmpdir(), "kcode-shrink-"));
    try {
      const target = join(dir, "f.ts");
      writeFileSync(
        target,
        Array.from({ length: 400 }, (_, i) => `a ${i}`).join("\n"),
      );
      const newContent = Array.from({ length: 500 }, (_, i) => `a ${i}`).join("\n");
      const v = detectInPlaceShrinkage(target, newContent);
      expect(v.isShrinking).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT fire when original is small (< 300 lines)", () => {
    // Legitimate small-file cleanups should pass through freely.
    const dir = mkdtempSync(join(tmpdir(), "kcode-shrink-"));
    try {
      const target = join(dir, "small.ts");
      writeFileSync(
        target,
        Array.from({ length: 200 }, (_, i) => `a ${i}`).join("\n"),
      );
      const newContent = "a\nb\nc\n"; // 4 lines — huge ratio drop
      const v = detectInPlaceShrinkage(target, newContent);
      expect(v.isShrinking).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT fire when shrinkage is modest (70%+ of original)", () => {
    // Legitimate cleanup: 500 → 400 lines (80% of original) should pass.
    const dir = mkdtempSync(join(tmpdir(), "kcode-shrink-"));
    try {
      const target = join(dir, "f.ts");
      writeFileSync(
        target,
        Array.from({ length: 500 }, (_, i) => `a ${i}`).join("\n"),
      );
      const newContent = Array.from({ length: 400 }, (_, i) => `a ${i}`).join("\n");
      const v = detectInPlaceShrinkage(target, newContent);
      expect(v.isShrinking).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT fire when target file does not exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "kcode-shrink-"));
    try {
      const target = join(dir, "brand-new.ts");
      const v = detectInPlaceShrinkage(target, "only 1 line");
      expect(v.isShrinking).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildShrinkageReport", () => {
  test("names the percentage drop and offers three resolutions", () => {
    const report = buildShrinkageReport("/tmp/nasa-explorer.html", {
      isShrinking: true,
      originalLines: 901,
      newLines: 554,
      ratio: 554 / 901,
    });
    expect(report).toContain("BLOCKED");
    expect(report).toContain("nasa-explorer.html");
    expect(report).toContain("901 lines");
    expect(report).toContain("554 lines");
    expect(report).toContain("39%");
    expect(report).toMatch(/a\)/);
    expect(report).toMatch(/b\)/);
    expect(report).toMatch(/c\)/);
    expect(report).toMatch(/behavior is identical/);
  });
});

// ─── Phase 21: unsolicited documentation detection ───────────────

describe("isDocFilename", () => {
  test("matches common doc filenames", () => {
    expect(isDocFilename("/tmp/README.md")).toBe(true);
    expect(isDocFilename("/tmp/QUICK_START.md")).toBe(true);
    expect(isDocFilename("/tmp/TECHNICAL_REFERENCE.md")).toBe(true);
    expect(isDocFilename("/tmp/INDEX.md")).toBe(true);
    expect(isDocFilename("/tmp/SUMMARY.txt")).toBe(true);
    expect(isDocFilename("/tmp/INSTALLATION_CHECK.md")).toBe(true);
    expect(isDocFilename("/tmp/CHANGELOG.md")).toBe(true);
    expect(isDocFilename("/tmp/CONTRIBUTING.md")).toBe(true);
    expect(isDocFilename("/tmp/GUIDE.md")).toBe(true);
    expect(isDocFilename("/tmp/getting-started.md")).toBe(true);
    expect(isDocFilename("/tmp/PROJECT_OVERVIEW.md")).toBe(true);
  });

  test("does not match normal source/config files", () => {
    expect(isDocFilename("/tmp/orbital.html")).toBe(false);
    expect(isDocFilename("/tmp/server.js")).toBe(false);
    expect(isDocFilename("/tmp/package.json")).toBe(false);
    expect(isDocFilename("/tmp/main.py")).toBe(false);
    expect(isDocFilename("/tmp/app.tsx")).toBe(false);
    expect(isDocFilename("/tmp/index.ts")).toBe(false); // not INDEX.md
    expect(isDocFilename("/tmp/style.css")).toBe(false);
  });
});

describe("userAllowedDocs", () => {
  test("grants permission on explicit doc request", () => {
    expect(userAllowedDocs(["add a README to the project"]).allowed).toBe(true);
    expect(userAllowedDocs(["documenta todo el código"]).allowed).toBe(true);
    expect(userAllowedDocs(["write a guide"]).allowed).toBe(true);
    expect(userAllowedDocs(["include a changelog"]).allowed).toBe(true);
  });

  test("grants permission on project-completeness signals", () => {
    expect(userAllowedDocs(["crea un proyecto completo"]).allowed).toBe(true);
    expect(userAllowedDocs(["build a complete project"]).allowed).toBe(true);
    expect(userAllowedDocs(["monta un repositorio listo"]).allowed).toBe(true);
    expect(userAllowedDocs(["scaffold a starter kit"]).allowed).toBe(true);
    expect(userAllowedDocs(["quiero varios archivos"]).allowed).toBe(true);
  });

  test("denies permission on the Orbital/NASA single-file prompt", () => {
    const prompt = `
      Crea una aplicación web completa llamada "Orbital".
      La aplicación debe ser un solo archivo HTML completo, autónomo y bonito.
      Al final del código HTML, agrega una sección comentada con el código Node.js
    `;
    expect(userAllowedDocs([prompt]).allowed).toBe(false);
  });

  test("denies permission when no doc keywords are present", () => {
    expect(userAllowedDocs(["crea una herramienta web moderna"]).allowed).toBe(false);
    expect(userAllowedDocs(["fix the bug in login.ts"]).allowed).toBe(false);
    expect(userAllowedDocs([]).allowed).toBe(false);
  });

  test("grants permission across multiple user messages", () => {
    // Earlier turn sets scope
    const texts = [
      "crea una app",
      "ok ahora añádele un README",
      "también",
    ];
    expect(userAllowedDocs(texts).allowed).toBe(true);
  });
});

describe("detectUnsolicitedDoc", () => {
  test("fires on Orbital reproduction: README.md when user asked for single file", () => {
    const orbitalPrompt = `La aplicación debe ser un solo archivo HTML completo, autónomo y bonito`;
    const v = detectUnsolicitedDoc("/tmp/README.md", [orbitalPrompt]);
    expect(v.isUnsolicitedDoc).toBe(true);
    expect(v.filename).toBe("README.md");
  });

  test("fires on TECHNICAL_REFERENCE.md when user asked for single file", () => {
    const orbitalPrompt = `crea una herramienta web llamada "NASA Explorer" en un solo archivo HTML`;
    const v = detectUnsolicitedDoc("/tmp/TECHNICAL_REFERENCE.md", [orbitalPrompt]);
    expect(v.isUnsolicitedDoc).toBe(true);
  });

  test("does NOT fire on README.md when user said 'proyecto completo'", () => {
    const v = detectUnsolicitedDoc("/tmp/README.md", [
      "crea un proyecto completo con todo lo necesario",
    ]);
    expect(v.isUnsolicitedDoc).toBe(false);
    expect(v.allowanceKeyword).toMatch(/proyecto completo/i);
  });

  test("does NOT fire on README.md when user explicitly asked for README", () => {
    const v = detectUnsolicitedDoc("/tmp/README.md", [
      "add a README with usage instructions",
    ]);
    expect(v.isUnsolicitedDoc).toBe(false);
  });

  test("does NOT fire on non-doc files even without doc keywords", () => {
    expect(
      detectUnsolicitedDoc("/tmp/orbital.html", ["crea un archivo html"])
        .isUnsolicitedDoc,
    ).toBe(false);
    expect(
      detectUnsolicitedDoc("/tmp/server.js", ["crea un servidor"])
        .isUnsolicitedDoc,
    ).toBe(false);
  });
});

describe("buildUnsolicitedDocReport", () => {
  test("names the file and offers resolutions", () => {
    const report = buildUnsolicitedDocReport({
      isUnsolicitedDoc: true,
      filename: "TECHNICAL_REFERENCE.md",
      allowanceKeyword: "",
    });
    expect(report).toContain("BLOCKED");
    expect(report).toContain("TECHNICAL_REFERENCE.md");
    expect(report).toContain("NEVER create documentation");
    expect(report).toMatch(/a\)/);
    expect(report).toMatch(/b\)/);
    expect(report).toMatch(/c\)/);
    expect(report).toContain("Do NOT tell the user you created");
  });
});
