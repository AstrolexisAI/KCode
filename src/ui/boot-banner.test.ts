import { describe, expect, test } from "bun:test";
import { renderBanner } from "./boot-banner";

describe("renderBanner", () => {
  const baseInputs = {
    version: "2.10.422",
    model: "qwen3-coder",
    contextSize: 65536,
    offlineForced: false,
    offlineDetected: false,
    apiBase: "http://localhost:10091",
    cwd: "/home/test/project",
  };

  test("includes version and KCode title", () => {
    const out = renderBanner(baseInputs);
    expect(out).toContain("KCode");
    expect(out).toContain("v2.10.422");
  });

  test("OFFLINE (forced) when forced=true", () => {
    const out = renderBanner({ ...baseInputs, offlineForced: true });
    expect(out).toContain("OFFLINE (forced)");
  });

  test("OFFLINE (auto-detected) when detected only", () => {
    const out = renderBanner({ ...baseInputs, offlineDetected: true });
    expect(out).toContain("OFFLINE (auto-detected)");
  });

  test("ONLINE when neither", () => {
    const out = renderBanner(baseInputs);
    expect(out).toContain("ONLINE");
    expect(out).not.toContain("OFFLINE");
  });

  test("classifies localhost apiBase as local", () => {
    const out = renderBanner({ ...baseInputs, apiBase: "http://localhost:10091" });
    expect(out).toContain("local");
  });

  test("classifies 127.0.0.1 as local", () => {
    const out = renderBanner({ ...baseInputs, apiBase: "http://127.0.0.1:8090" });
    expect(out).toContain("local");
  });

  test("classifies api.openai.com as cloud", () => {
    const out = renderBanner({ ...baseInputs, apiBase: "https://api.openai.com/v1" });
    expect(out).toContain("cloud");
  });

  test("warns when cloud model + offline forced", () => {
    const out = renderBanner({
      ...baseInputs,
      apiBase: "https://api.openai.com/v1",
      offlineForced: true,
    });
    expect(out).toContain("first request will fail");
  });

  test("does not warn for local + offline (the happy path)", () => {
    const out = renderBanner({ ...baseInputs, offlineForced: true });
    expect(out).not.toContain("first request will fail");
  });

  test("shortens HOME-prefixed cwd to ~", () => {
    const realHome = process.env.HOME;
    process.env.HOME = "/home/test";
    try {
      const out = renderBanner({ ...baseInputs, cwd: "/home/test/project" });
      expect(out).toContain("~/project");
    } finally {
      if (realHome) process.env.HOME = realHome;
      else delete process.env.HOME;
    }
  });

  test("formats context size in k/M units", () => {
    expect(renderBanner({ ...baseInputs, contextSize: 32768 })).toContain("33k tok");
    expect(renderBanner({ ...baseInputs, contextSize: 1_000_000 })).toContain("1M tok");
    expect(renderBanner({ ...baseInputs, contextSize: 200_000 })).toContain("200k tok");
  });

  test("falls back to dash on missing context", () => {
    const out = renderBanner({ ...baseInputs, contextSize: 0 });
    expect(out).toContain("—");
  });

  test("includes verify pointer to docs", () => {
    const out = renderBanner(baseInputs);
    expect(out).toContain("cosign verify-blob");
    expect(out).toContain("docs/security/verify-binary.md");
  });
});
