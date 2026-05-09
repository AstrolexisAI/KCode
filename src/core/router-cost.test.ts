// KCode - Tests for cost-aware model preference in the router
import { describe, expect, test } from "bun:test";
import { priceModel } from "./router";

describe("priceModel", () => {
  test("local models cost 0/0", () => {
    expect(
      priceModel({ name: "mlx-community/anything", baseUrl: "http://localhost:10091" }),
    ).toEqual({ inPrice: 0, outPrice: 0 });
    expect(priceModel({ name: "any-llama", baseUrl: "http://127.0.0.1:8080" })).toEqual({
      inPrice: 0,
      outPrice: 0,
    });
  });

  test("explicit pricePerMtok* fields override fallback table", () => {
    expect(
      priceModel({
        name: "claude-haiku-4-5-20251001",
        baseUrl: "https://api.anthropic.com",
        pricePerMtokInput: 99,
        pricePerMtokOutput: 999,
      }),
    ).toEqual({ inPrice: 99, outPrice: 999 });
  });

  test("Claude Haiku falls back to $1/$5", () => {
    expect(
      priceModel({ name: "claude-haiku-4-5-20251001", baseUrl: "https://api.anthropic.com" }),
    ).toEqual({ inPrice: 1, outPrice: 5 });
  });

  test("Claude Opus falls back to $15/$75", () => {
    expect(priceModel({ name: "claude-opus-4-7", baseUrl: "https://api.anthropic.com" })).toEqual({
      inPrice: 15,
      outPrice: 75,
    });
  });

  test("Grok-3-mini cheaper than Grok-4", () => {
    const mini = priceModel({ name: "grok-3-mini", baseUrl: "https://api.x.ai" });
    const four = priceModel({ name: "grok-4", baseUrl: "https://api.x.ai" });
    expect(mini.inPrice).toBeLessThan(four.inPrice);
  });

  test("unknown cloud model gets conservative moderate fallback ($5/$25)", () => {
    expect(
      priceModel({ name: "custom-internal-cloud-model", baseUrl: "https://api.example.com" }),
    ).toEqual({ inPrice: 5, outPrice: 25 });
  });
});
