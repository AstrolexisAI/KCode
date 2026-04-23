import { describe, expect, test } from "bun:test";
import { formatCritiqueBanner, parseCritiqueResponse } from "./self-critique";

describe("parseCritiqueResponse", () => {
  test("parses a clean ok response", () => {
    const raw = `{"contradictions":[],"verdict":"ok"}`;
    const parsed = parseCritiqueResponse(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.contradictions).toHaveLength(0);
    expect(parsed?.verdict).toBe("ok");
  });

  test("parses a downgrade with high-severity contradiction", () => {
    const raw = `{
      "contradictions": [
        {
          "claim": "The app is ready",
          "evidence": "ModuleNotFoundError: No module named 'bitcoin'",
          "severity": "high"
        }
      ],
      "verdict": "downgrade"
    }`;
    const parsed = parseCritiqueResponse(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.verdict).toBe("downgrade");
    expect(parsed?.contradictions).toHaveLength(1);
    expect(parsed?.contradictions[0]?.severity).toBe("high");
    expect(parsed?.contradictions[0]?.claim).toBe("The app is ready");
  });

  test("tolerates markdown code fences (small-model quirk)", () => {
    const raw =
      '```json\n{"contradictions":[{"claim":"X","evidence":"Y","severity":"medium"}],"verdict":"downgrade"}\n```';
    const parsed = parseCritiqueResponse(raw);
    expect(parsed?.contradictions).toHaveLength(1);
  });

  test("tolerates leading prose before JSON", () => {
    const raw =
      'Here is the audit:\n{"contradictions":[],"verdict":"ok"}\n\nThank you.';
    const parsed = parseCritiqueResponse(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.verdict).toBe("ok");
  });

  test("handles nested braces inside claim/evidence strings", () => {
    const raw = `{
      "contradictions": [
        {"claim": "says {foo: bar}", "evidence": "actual {} is empty", "severity": "low"}
      ],
      "verdict": "downgrade"
    }`;
    const parsed = parseCritiqueResponse(raw);
    expect(parsed?.contradictions).toHaveLength(1);
  });

  test("returns null on malformed JSON", () => {
    expect(parseCritiqueResponse("not json")).toBeNull();
    expect(parseCritiqueResponse("{broken")).toBeNull();
    expect(parseCritiqueResponse("")).toBeNull();
  });

  test("normalizes unknown severity to medium", () => {
    const raw = `{
      "contradictions": [{"claim": "x", "evidence": "y", "severity": "bogus"}],
      "verdict": "downgrade"
    }`;
    const parsed = parseCritiqueResponse(raw);
    expect(parsed?.contradictions[0]?.severity).toBe("medium");
  });

  test("drops contradictions with empty claim or evidence", () => {
    const raw = `{
      "contradictions": [
        {"claim": "", "evidence": "y", "severity": "high"},
        {"claim": "x", "evidence": "", "severity": "high"},
        {"claim": "x", "evidence": "y", "severity": "high"}
      ],
      "verdict": "downgrade"
    }`;
    const parsed = parseCritiqueResponse(raw);
    expect(parsed?.contradictions).toHaveLength(1);
  });

  test("defaults verdict to ok when missing", () => {
    const raw = `{"contradictions":[]}`;
    const parsed = parseCritiqueResponse(raw);
    expect(parsed?.verdict).toBe("ok");
  });
});

describe("formatCritiqueBanner", () => {
  test("empty for no contradictions", () => {
    expect(
      formatCritiqueBanner({ contradictions: [], verdict: "ok", skipped: false }),
    ).toBe("");
  });

  test("renders the #103 scenario readably", () => {
    const banner = formatCritiqueBanner({
      contradictions: [
        {
          claim: "app.py is ready",
          evidence: "python3 app.py → ModuleNotFoundError: No module named 'bitcoin'",
          severity: "high",
        },
        {
          claim: "The dashboard displays real-time stats",
          evidence: "Edit blocked by audit-mode; no working version exists",
          severity: "high",
        },
      ],
      verdict: "downgrade",
      skipped: false,
    });
    expect(banner).toContain("flagged 2 issue(s)");
    expect(banner).toContain("app.py is ready");
    expect(banner).toContain("ModuleNotFoundError");
    expect(banner).toContain("[high]");
  });

  test("caps at 5 items with overflow note", () => {
    const contradictions = Array.from({ length: 8 }, (_, i) => ({
      claim: `claim${i}`,
      evidence: `evidence${i}`,
      severity: "medium" as const,
    }));
    const banner = formatCritiqueBanner({
      contradictions,
      verdict: "downgrade",
      skipped: false,
    });
    expect(banner).toContain("flagged 8 issue(s)");
    expect(banner).toContain("3 more");
  });

  test("truncates long claim and evidence strings", () => {
    const longClaim = "a".repeat(200);
    const longEvidence = "b".repeat(200);
    const banner = formatCritiqueBanner({
      contradictions: [
        { claim: longClaim, evidence: longEvidence, severity: "medium" },
      ],
      verdict: "downgrade",
      skipped: false,
    });
    expect(banner).toContain("…");
    expect(banner.length).toBeLessThan(500);
  });
});
