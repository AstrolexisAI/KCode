// Tests for github-claim-grounding (v2.10.306).
//
// Verification uses network HEAD requests against github.com. The
// tests stub the global fetch so they run offline and deterministically.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  _resetRepoCache,
  detectGithubRepoClaims,
  groundGithubRepoClaims,
  rewriteUnverifiedRepoClaims,
  seedVerifiedRepo,
  type VerifiedRepoClaim,
  verifyRepoClaims,
} from "./github-claim-grounding";

// biome-ignore lint/suspicious/noExplicitAny: fetch stub
let originalFetch: any;

beforeEach(() => {
  _resetRepoCache();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(map: Record<string, number>) {
  globalThis.fetch = (async (url: string) => {
    const match = String(url).match(/github\.com\/([^/]+\/[^/]+)/);
    const repo = match?.[1] ?? "";
    const status = map[repo] ?? 404;
    return new Response(null, { status });
  }) as unknown as typeof fetch;
}

describe("detectGithubRepoClaims", () => {
  it("captures bare owner/repo tokens", () => {
    const text = "Los repos son nasa/openmct, nasa/fprime, y nasa/trick.";
    const claims = detectGithubRepoClaims(text);
    expect(claims.map((c) => c.repo)).toEqual(["nasa/openmct", "nasa/fprime", "nasa/trick"]);
  });

  it("captures backticked owner/repo", () => {
    const text = "Proyecto clave: `nasa/OnAIR` — on-board AI";
    const claims = detectGithubRepoClaims(text);
    expect(claims.map((c) => c.repo)).toEqual(["nasa/OnAIR"]);
  });

  it("ignores file paths that look like owner/repo", () => {
    const text = "Ver src/index.ts y README.md y docs/guide.md";
    const claims = detectGithubRepoClaims(text);
    expect(claims.length).toBe(0);
  });

  it("ignores URLs — owner/repo inside an https://github.com URL is not a naked claim", () => {
    const text = "See https://github.com/nasa/openmct/blob/main/README.md for details.";
    const claims = detectGithubRepoClaims(text);
    // The URL is NOT counted as a claim (the slug there is inside a URL, not a naked claim).
    // Our detector uses a pre-/post- lookbehind/lookahead that excludes slashes.
    expect(claims.length).toBe(0);
  });

  it("dedupes repeated mentions", () => {
    const text = "nasa/openmct is great. I recommend nasa/openmct strongly.";
    const claims = detectGithubRepoClaims(text);
    expect(claims.length).toBe(1);
  });
});

describe("verifyRepoClaims (with stubbed fetch)", () => {
  it("marks existing repos verified", async () => {
    stubFetch({ "nasa/openmct": 200, "nasa/fprime": 200 });
    const claims = detectGithubRepoClaims("nasa/openmct and nasa/fprime");
    const results = await verifyRepoClaims(claims);
    expect(results.every((r) => r.status === "verified")).toBe(true);
  });

  it("marks 404s as missing", async () => {
    stubFetch({ "nasa/openmct": 200, "nasa/ai": 404 });
    const claims = detectGithubRepoClaims("nasa/openmct vs nasa/ai");
    const results = await verifyRepoClaims(claims);
    const missing = results.find((r) => r.repo === "nasa/ai");
    expect(missing?.status).toBe("missing");
  });

  it("marks network errors as unknown", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const claims = detectGithubRepoClaims("nasa/openmct");
    const results = await verifyRepoClaims(claims);
    expect(results[0]!.status).toBe("unknown");
    expect(results[0]!.evidence).toContain("ENOTFOUND");
  });

  it("caches results — second call does not re-fetch", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const claims = detectGithubRepoClaims("nasa/openmct");
    await verifyRepoClaims(claims);
    await verifyRepoClaims(claims);
    expect(calls).toBe(1);
  });

  it("respects seedVerifiedRepo pre-marks", async () => {
    seedVerifiedRepo("nasa/openmct", "from WebFetch");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const claims = detectGithubRepoClaims("nasa/openmct");
    const results = await verifyRepoClaims(claims);
    expect(results[0]!.status).toBe("verified");
    expect(calls).toBe(0);
  });
});

describe("rewriteUnverifiedRepoClaims", () => {
  it("annotates missing repos with 'repo no encontrado'", () => {
    const text = "Recomiendo `nasa/ai` para análisis.";
    const claims: VerifiedRepoClaim[] = [
      { repo: "nasa/ai", start: 12, end: 19, status: "missing", evidence: "HTTP 404" },
    ];
    const { text: out, rewritten } = rewriteUnverifiedRepoClaims(text, claims);
    expect(out).toContain("repo no encontrado");
    expect(rewritten).toBe(1);
  });

  it("leaves verified repos untouched", () => {
    const text = "Recomiendo `nasa/openmct` para telemetría.";
    const claims: VerifiedRepoClaim[] = [
      { repo: "nasa/openmct", start: 12, end: 24, status: "verified", evidence: "HTTP 200" },
    ];
    const { text: out, rewritten } = rewriteUnverifiedRepoClaims(text, claims);
    expect(out).toBe(text);
    expect(rewritten).toBe(0);
  });

  it("annotates unknown as '(no verificado)' — softer language than missing", () => {
    const text = "nasa/maybe";
    const claims: VerifiedRepoClaim[] = [
      { repo: "nasa/maybe", start: 0, end: 10, status: "unknown", evidence: "timeout" },
    ];
    const { text: out } = rewriteUnverifiedRepoClaims(text, claims);
    expect(out).toContain("(no verificado)");
    expect(out).not.toContain("posiblemente alucinado");
  });

  it("rewrites every occurrence of the same repo, not just the first", () => {
    const text = "First: nasa/fake. Second mention: nasa/fake again.";
    const claims: VerifiedRepoClaim[] = [
      { repo: "nasa/fake", start: 7, end: 16, status: "missing", evidence: "HTTP 404" },
    ];
    const { text: out, rewritten } = rewriteUnverifiedRepoClaims(text, claims);
    expect(rewritten).toBe(2);
    expect(out.match(/repo no encontrado/g)?.length).toBe(2);
  });

  it("does not break verified + unverified mix", () => {
    const text = "Top picks: nasa/openmct y nasa/ai son interesantes.";
    const claims: VerifiedRepoClaim[] = [
      { repo: "nasa/openmct", start: 11, end: 23, status: "verified", evidence: "HTTP 200" },
      { repo: "nasa/ai", start: 26, end: 33, status: "missing", evidence: "HTTP 404" },
    ];
    const { text: out } = rewriteUnverifiedRepoClaims(text, claims);
    expect(out).toContain("nasa/openmct y");
    expect(out).toMatch(/nasa\/ai.*repo no encontrado/);
    expect(out).not.toMatch(/nasa\/openmct.*no verificado/);
  });
});

describe("groundGithubRepoClaims — end-to-end", () => {
  it("verifies + rewrites in one call", async () => {
    stubFetch({ "nasa/openmct": 200, "nasa/ai": 404 });
    const text = "Recomiendo nasa/openmct y nasa/ai.";
    const result = await groundGithubRepoClaims(text);
    expect(result.verified.map((v) => v.repo)).toEqual(["nasa/openmct"]);
    expect(result.missing.map((v) => v.repo)).toEqual(["nasa/ai"]);
    expect(result.text).toContain("nasa/openmct");
    expect(result.text).toMatch(/nasa\/ai.*repo no encontrado/);
    expect(result.text).not.toMatch(/^Recomiendo nasa\/ai\.$/);
  });

  it("no-op when there are no repo claims", async () => {
    const text = "Hello world, I wrote 3 lines of code.";
    const result = await groundGithubRepoClaims(text);
    expect(result.text).toBe(text);
    expect(result.verified.length + result.missing.length + result.unknown.length).toBe(0);
  });
});
