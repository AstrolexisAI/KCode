// Tests for reference-extractor (v2.10.306).

import { describe, expect, it } from "bun:test";
import { capturedListToRankedItems, extractRepoList } from "./reference-extractor";

describe("extractRepoList — bullets", () => {
  it("captures a bullet list with emoji category prefix", () => {
    const text = `Los repos de la NASA son:

🚀 Exploración
 • \`nasa/openmct\` — Open Mission Control Telemetry
 • \`nasa/deep-space-navigation\` — herramientas para navegación
 • \`nasa/earthdata\` — plataforma de datos
 • \`nasa/rocket-math\` — educativo

Fin.`;
    const list = extractRepoList(text);
    expect(list).not.toBeNull();
    expect(list!.items.length).toBeGreaterThanOrEqual(4);
    const repos = list!.items.map((it) => it.repo);
    expect(repos).toContain("nasa/openmct");
    expect(repos).toContain("nasa/earthdata");
    expect(list!.items[0]!.ordinal).toBe(1);
    expect(list!.items[3]!.ordinal).toBe(4);
    expect(list!.items.every((it) => !it.verified)).toBe(true);
  });

  it("captures a list with markdown links", () => {
    const text = `Here are 4 repos:

- [nasa/OnAIR](https://github.com/nasa/OnAIR) — on-board AI
- [nasa/AI4LS](https://github.com/nasa/AI4LS) — life science
- [nasa/airfoil-learning](https://github.com/nasa/airfoil-learning) — aero ML
- [nasa/openmct](https://github.com/nasa/openmct) — telemetry`;
    const list = extractRepoList(text);
    expect(list).not.toBeNull();
    expect(list!.items.length).toBe(4);
    expect(list!.items[0]!.repo).toBe("nasa/OnAIR");
    expect(list!.items[0]!.url).toBe("https://github.com/nasa/OnAIR");
    expect(list!.items[3]!.repo).toBe("nasa/openmct");
  });

  it("captures a numbered list", () => {
    const text = `1. nasa/openmct — telemetry
2. nasa/fprime — flight software
3. nasa/trick — simulator
4. nasa/cumulus — cloud pipeline`;
    const list = extractRepoList(text);
    expect(list).not.toBeNull();
    expect(list!.items.length).toBe(4);
    expect(list!.items[0]!.ordinal).toBe(1);
    expect(list!.items[3]!.ordinal).toBe(4);
  });

  it("captures a simple table", () => {
    const text = `| Repo | Descripción |
|------|-------------|
| nasa/OnAIR | on-board AI |
| nasa/AI4LS | life science |
| nasa/openmct | telemetry |
| nasa/cumulus | pipelines |`;
    const list = extractRepoList(text);
    expect(list).not.toBeNull();
    expect(list!.items.length).toBeGreaterThanOrEqual(4);
    const repos = list!.items.map((it) => it.repo);
    expect(repos).toContain("nasa/OnAIR");
    expect(repos).toContain("nasa/openmct");
  });

  it("rejects a list with fewer than 3 repos", () => {
    const text = `Here are some:
- nasa/openmct
- nasa/fprime`;
    expect(extractRepoList(text)).toBeNull();
  });

  it("rejects stray owner/repo mentions in prose", () => {
    const text = `Hoy revisé nasa/openmct y descubrí que también nasa/fprime tiene buena documentación. Esos son los únicos dos que exploré.`;
    // Prose mentions don't have list shape → null (no bullets/numbered/table near each other).
    const list = extractRepoList(text);
    expect(list).toBeNull();
  });

  it("ignores file extensions that look like owner/repo", () => {
    const text = `Revisé varios archivos:
- src/index.ts (entrypoint)
- README.md (documentación)
- package.json (deps)
- bin/main.js (binario)`;
    const list = extractRepoList(text);
    // Even if bullets parse, file-paths-with-ext should be filtered out.
    if (list !== null) {
      const repos = list.items.map((it) => it.repo);
      for (const r of repos) {
        expect(r).not.toMatch(/\.(md|ts|js|py|json)$/i);
      }
    }
  });

  it("preserves repo capitalization exactly", () => {
    const text = `- nasa/OnAIR — keeps case
- nasa/AI4LS — keeps case
- nasa/JWSTCalibration — keeps case
- nasa/openMCT — keeps case`;
    const list = extractRepoList(text);
    expect(list!.items.map((it) => it.repo)).toEqual([
      "nasa/OnAIR",
      "nasa/AI4LS",
      "nasa/JWSTCalibration",
      "nasa/openMCT",
    ]);
  });
});

describe("capturedListToRankedItems", () => {
  it("maps a CapturedList into RankedListItem[] format", () => {
    const text = `- nasa/openmct — a
- nasa/fprime — b
- nasa/trick — c`;
    const list = extractRepoList(text)!;
    const items = capturedListToRankedItems(list);
    expect(items.length).toBe(3);
    expect(items[0]!.rank).toBe(1);
    expect(items[0]!.id).toBe("nasa/openmct");
    expect(items[0]!.title).toBe("nasa/openmct");
    expect(items[0]!.url).toBe("https://github.com/nasa/openmct");
  });
});
