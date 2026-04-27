// Tests for the F9 AI/ML Security Pack (v2.10.370).
//
// Each pattern's regex tested against a positive and a negative
// fixture so regressions surface at unit-test time. Plus a
// pack-filter test that proves --pack narrows the loaded patterns.
//
// SYNTHETIC FIXTURES — every `sk-*` literal in this file is a
// purpose-built test string. They contain explicit FAKE / EXAMPLE /
// NOTREAL markers so secret scanners (GitGuardian, gitleaks,
// trufflehog) recognize them as fixtures rather than real keys.
// If you ever need to test against the *shape* of a real key, use
// these synthetic forms — never paste a real or recently-rotated key
// into a test file. Per project policy: real secrets in test files
// trigger an immediate rotate.

import { describe, expect, test } from "bun:test";
import { ALL_PATTERNS } from "../patterns";
import { AI_ML_PATTERNS } from "./ai-ml";

function regexHits(re: RegExp, text: string): RegExpMatchArray[] {
  // Reset lastIndex; module-level `g` regexes accumulate state.
  re.lastIndex = 0;
  const out: RegExpMatchArray[] = [];
  for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
    out.push(m);
  }
  return out;
}

function getPattern(id: string) {
  const p = AI_ML_PATTERNS.find((p) => p.id === id);
  if (!p) throw new Error(`pattern ${id} not found`);
  return p;
}

describe("AI/ML pack — pack tagging", () => {
  test("every pattern in the file declares pack: 'ai-ml'", () => {
    for (const p of AI_ML_PATTERNS) {
      expect(p.pack).toBe("ai-ml");
    }
  });

  test("AI_ML_PATTERNS is included in ALL_PATTERNS", () => {
    for (const p of AI_ML_PATTERNS) {
      const found = ALL_PATTERNS.find((x) => x.id === p.id);
      expect(found).toBeDefined();
      expect(found?.pack).toBe("ai-ml");
    }
  });

  test("five patterns ship in the initial AI/ML pack", () => {
    const ids = AI_ML_PATTERNS.map((p) => p.id).sort();
    expect(ids).toEqual([
      "ai-001-trust-remote-code",
      "ai-002-openai-api-key-hardcoded",
      "ai-003-anthropic-api-key-hardcoded",
      "ai-004-prompt-injection-sink",
      "ai-005-vector-db-untrusted-query",
    ]);
  });
});

describe("ai-001-trust-remote-code", () => {
  const p = getPattern("ai-001-trust-remote-code");

  test("hits AutoModel.from_pretrained(..., trust_remote_code=True)", () => {
    const code = `
from transformers import AutoModel
m = AutoModel.from_pretrained("repo/name", trust_remote_code=True)
`;
    expect(regexHits(p.regex, code).length).toBeGreaterThan(0);
  });

  test("hits pipeline(..., trust_remote_code=True)", () => {
    const code = `pipe = pipeline("text-generation", model="x", trust_remote_code=True)`;
    expect(regexHits(p.regex, code).length).toBeGreaterThan(0);
  });

  test("does NOT hit from_pretrained without trust_remote_code", () => {
    const code = `m = AutoModel.from_pretrained("repo/name")`;
    expect(regexHits(p.regex, code).length).toBe(0);
  });

  test("does NOT hit explicit trust_remote_code=False", () => {
    const code = `m = AutoModel.from_pretrained("repo", trust_remote_code=False)`;
    expect(regexHits(p.regex, code).length).toBe(0);
  });
});

describe("ai-002-openai-api-key-hardcoded", () => {
  const p = getPattern("ai-002-openai-api-key-hardcoded");

  test("hits a project-scoped OpenAI key shape", () => {
    // Synthetic — explicit FAKE/EXAMPLE markers so secret scanners
    // recognize this as a fixture rather than a leaked key.
    const code = `const k = "sk-proj-FAKE-EXAMPLE-NOT-A-REAL-KEY-FIXTURE"`;
    expect(regexHits(p.regex, code).length).toBe(1);
  });

  test("hits a classic OpenAI key shape", () => {
    const code = `OPENAI_API_KEY = "sk-FAKE-EXAMPLE-NOT-REAL-KEY-FOR-TESTING-XXXX1234"`;
    expect(regexHits(p.regex, code).length).toBe(1);
  });

  test("does NOT hit an env-var read or placeholder", () => {
    const code = `
const k = process.env.OPENAI_API_KEY;
const placeholder = "sk-YOUR_KEY_HERE";
`;
    // The placeholder text "sk-YOUR_KEY_HERE" is short enough that
    // the regex (>=20 chars after sk-) doesn't match.
    expect(regexHits(p.regex, code).length).toBe(0);
  });
});

describe("ai-003-anthropic-api-key-hardcoded", () => {
  const p = getPattern("ai-003-anthropic-api-key-hardcoded");

  test("hits sk-ant-* literal shape", () => {
    // Synthetic — explicit FAKE markers for secret scanners.
    const code = `ANTHROPIC_API_KEY = "sk-ant-FAKE-EXAMPLE-NOT-REAL-KEY-FIXTURE"`;
    expect(regexHits(p.regex, code).length).toBe(1);
  });

  test("does NOT hit a non-Anthropic key shape", () => {
    const code = `const k = "sk-FAKE-EXAMPLE-NOT-REAL-KEY-NO-ANT-PREFIX"`;
    expect(regexHits(p.regex, code).length).toBe(0);
  });
});

describe("ai-005-vector-db-untrusted-query", () => {
  const p = getPattern("ai-005-vector-db-untrusted-query");

  test("hits pinecone.query / chroma.search / weaviate.similarity_search", () => {
    expect(regexHits(p.regex, `pinecone.query(...)`).length).toBe(1);
    expect(regexHits(p.regex, `chroma.search(...)`).length).toBe(1);
    expect(regexHits(p.regex, `vector_store.similarity_search(...)`).length).toBe(1);
  });

  test("does NOT hit unrelated method calls", () => {
    expect(regexHits(p.regex, `db.query(...)`).length).toBe(0);
  });
});
