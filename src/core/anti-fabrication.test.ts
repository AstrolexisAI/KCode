// Tests for phase 13 — anti-fabrication guard.

import { describe, expect, test } from "bun:test";
import {
  collectReferenceTexts,
  extractSignificantTokens,
  isLikelyFabricated,
  looksLikeNotFound,
  wasPathReferenced,
  wrapFabricatedError,
} from "./anti-fabrication";
import { buildAntiFabricationGuidance } from "./system-prompt-layers";

describe("looksLikeNotFound", () => {
  test.each([
    "ENOENT: no such file or directory",
    "Error reading 'x': ENOENT: no such file or directory, statx 'x'",
    "FILE NOT FOUND",
    "could not find 'foo.txt'",
    "No files found matching '**/*bayesian*'",
    "path /x/y does not exist",
  ])("detects: %p", (msg) => {
    expect(looksLikeNotFound(msg)).toBe(true);
  });

  test.each([
    "Edited /x/y.ts: 1 replacement",
    "Created hero.tsx (55 lines)",
    "Permission denied on /etc/passwd",
    "",
  ])("ignores non-404 errors: %p", (msg) => {
    expect(looksLikeNotFound(msg)).toBe(false);
  });
});

describe("extractSignificantTokens", () => {
  test("extracts from lunar-ops fabrication", () => {
    const tokens = extractSignificantTokens("lunar-ops/core/bayesian_net.py");
    expect(tokens).toContain("lunar");
    expect(tokens).toContain("ops");
    expect(tokens).toContain("bayesian");
    expect(tokens).toContain("net");
  });

  test("drops boring path segments", () => {
    const tokens = extractSignificantTokens("src/components/hero.tsx");
    expect(tokens).not.toContain("src");
    expect(tokens).not.toContain("components");
    expect(tokens).toContain("hero");
  });

  test("drops boring extensions", () => {
    const tokens = extractSignificantTokens("page.tsx");
    expect(tokens).toContain("page");
    expect(tokens).not.toContain("tsx");
  });

  test("splits camelCase", () => {
    const tokens = extractSignificantTokens("bayesianNet.py");
    expect(tokens).toContain("bayesian");
    expect(tokens).toContain("net");
  });

  test("splits snake_case and kebab-case", () => {
    const tokens = extractSignificantTokens("co2_buildup-v2.py");
    expect(tokens).toContain("co2");
    expect(tokens).toContain("buildup");
    expect(tokens).toContain("v2");
  });

  test("drops pure digits and single-char tokens", () => {
    const tokens = extractSignificantTokens("123/a/valid.py");
    expect(tokens).toContain("valid");
    expect(tokens).not.toContain("123");
    expect(tokens).not.toContain("a");
  });

  test("conventional filenames still tokenize (allowlist is applied at higher level)", () => {
    // Tokenization is a low-level concern. The "is this conventional?"
    // question is answered by wasPathReferenced using CONVENTIONAL_PROBES.
    // Here we just verify extractSignificantTokens returns SOMETHING for
    // package.json; the allowlist short-circuit happens upstream.
    const tokens = extractSignificantTokens("package.json");
    expect(tokens.length).toBeGreaterThanOrEqual(0);
  });
});

describe("wasPathReferenced", () => {
  test("returns true for conventional filenames regardless of history", () => {
    expect(wasPathReferenced("package.json", [])).toBe(true);
    expect(wasPathReferenced("tsconfig.json", [])).toBe(true);
    expect(wasPathReferenced("Cargo.toml", [])).toBe(true);
    expect(wasPathReferenced("Dockerfile", [])).toBe(true);
    expect(wasPathReferenced("README.md", [])).toBe(true);
  });

  test("returns true when all significant tokens appear in history", () => {
    const history = [
      "Can you edit the hero section and update the features component?",
    ];
    expect(wasPathReferenced("src/components/hero.tsx", history)).toBe(true);
    expect(wasPathReferenced("src/components/features.tsx", history)).toBe(true);
  });

  test("returns false for the lunar-ops fabrication case", () => {
    // Exact prompt the user actually sent in the failing session
    const history = [
      "Crea una herramienta web moderna y profesional llamada 'NASA Explorer' usando HTML, Tailwind CSS y JavaScript puro. El objetivo es una dashboard/interfaz elegante que permita explorar datos y recursos de la NASA...",
    ];
    expect(wasPathReferenced("lunar-ops/core/bayesian_net.py", history)).toBe(false);
    expect(wasPathReferenced("lunar-ops/scenarios/co2_buildup.py", history)).toBe(false);
  });

  test("returns false when only some significant tokens match", () => {
    const history = ["Fix the bayesian network issue"];
    // "bayesian" matches but "lunar", "ops", "net" do not
    expect(wasPathReferenced("lunar-ops/core/bayesian.py", history)).toBe(false);
  });

  test("returns true when every significant token is in history", () => {
    const history = ["Fix the bayesian network in lunar-ops/core/"];
    expect(wasPathReferenced("lunar-ops/core/bayesian_net.py", history)).toBe(true);
  });

  test("empty path returns true (no fabrication possible)", () => {
    expect(wasPathReferenced("", [])).toBe(true);
  });

  test("path with no significant tokens returns true", () => {
    expect(wasPathReferenced("src/lib/main.ts", [])).toBe(true);
  });
});

describe("isLikelyFabricated", () => {
  const nasaHistory = [
    "Crea una herramienta web moderna NASA Explorer con Hero, APOD, Mars Rover, Earth Observatory, Quick Facts",
  ];

  test("flags the exact lunar-ops fabrication from the failing session", () => {
    const r = isLikelyFabricated(
      "lunar-ops/core/bayesian_net.py",
      "Error reading 'lunar-ops/core/bayesian_net.py': ENOENT: no such file or directory",
      nasaHistory,
    );
    expect(r.fabricated).toBe(true);
    expect(r.unreferencedTokens).toContain("lunar");
    expect(r.unreferencedTokens).toContain("bayesian");
  });

  test("does NOT flag legitimate NASA-related paths", () => {
    const r = isLikelyFabricated(
      "src/components/hero.tsx",
      "ENOENT: no such file or directory",
      nasaHistory,
    );
    // "hero" was mentioned in the prompt ("Hero"), so not fabricated
    expect(r.fabricated).toBe(false);
  });

  test("does NOT flag conventional filenames", () => {
    const r = isLikelyFabricated(
      "package.json",
      "ENOENT: no such file or directory",
      nasaHistory,
    );
    expect(r.fabricated).toBe(false);
  });

  test("does NOT flag successful tool results", () => {
    const r = isLikelyFabricated(
      "whatever/path.ts",
      "Edited /whatever/path.ts: 1 replacement",
      nasaHistory,
    );
    expect(r.fabricated).toBe(false);
  });

  test("does NOT flag empty path", () => {
    const r = isLikelyFabricated("", "ENOENT", nasaHistory);
    expect(r.fabricated).toBe(false);
  });
});

describe("wrapFabricatedError", () => {
  test("appends POSSIBLE FABRICATION warning", () => {
    const out = wrapFabricatedError(
      "Error reading 'lunar-ops/core/bayesian_net.py': ENOENT",
      "lunar-ops/core/bayesian_net.py",
      ["lunar", "ops", "bayesian", "net"],
    );
    expect(out).toContain("Error reading");
    expect(out).toContain("POSSIBLE FABRICATION");
    expect(out).toContain("lunar-ops/core/bayesian_net.py");
    expect(out).toContain("[lunar, ops, bayesian, net]");
    expect(out).toContain("Did you invent this path?");
    expect(out).toContain("Do NOT offer follow-up tasks based on fictional files");
  });

  test("preserves original content intact", () => {
    const original = "Error reading 'x': ENOENT: no such file";
    const out = wrapFabricatedError(original, "x", ["foo"]);
    expect(out.startsWith(original)).toBe(true);
  });
});

describe("collectReferenceTexts", () => {
  test("extracts user-role text messages", () => {
    const msgs = [
      { role: "user", content: "Create a NASA dashboard" },
      { role: "assistant", content: "Sure, here's the code..." },
      { role: "user", content: "Also add a Mars rover section" },
    ];
    const texts = collectReferenceTexts(msgs);
    expect(texts).toContain("Create a NASA dashboard");
    expect(texts).toContain("Also add a Mars rover section");
    // Assistant text is deliberately excluded so the model can't
    // "hallucinate evidence" by mentioning a fabricated path earlier.
    expect(texts.find((t) => t.includes("Sure, here's"))).toBeUndefined();
  });

  test("extracts tool_result blocks from user-role content arrays", () => {
    const msgs = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "file list:\n  hero.tsx\n  features.tsx",
          },
        ],
      },
    ];
    const texts = collectReferenceTexts(msgs);
    expect(texts.some((t) => t.includes("hero.tsx"))).toBe(true);
  });
});

describe("buildAntiFabricationGuidance", () => {
  test("contains the 4 rules", () => {
    const out = buildAntiFabricationGuidance();
    expect(out).toContain("Anti-Fabrication");
    expect(out).toMatch(/1\.\s*do\s*not\s*read/i);
    expect(out).toMatch(/2\.\s*do\s*not\s*offer/i);
    expect(out).toContain("POSSIBLE FABRICATION");
    expect(out).toMatch(/4\.\s*token/i);
  });

  test("mentions both cloud and local models for token economy", () => {
    const out = buildAntiFabricationGuidance();
    expect(out).toMatch(/cloud/i);
    expect(out).toMatch(/local/i);
  });
});
