import { describe, test, expect } from "bun:test";
import { matchDebugPatterns, extractSearchKeywords } from "./debug-patterns";

describe("debug-patterns", () => {
  // ── Pattern matching ──
  test("detects repeating behavior", () => {
    expect(matchDebugPatterns("el modal me pregunta cada vez").length).toBeGreaterThan(0);
    expect(matchDebugPatterns("el modal me pregunta cada vez")[0]!.id).toBe("repeating-behavior");
    expect(matchDebugPatterns("it always asks me to login").length).toBeGreaterThan(0);
    expect(matchDebugPatterns("keeps showing the popup").length).toBeGreaterThan(0);
    expect(matchDebugPatterns("the dialog won't stop appearing").length).toBeGreaterThan(0);
  });

  test("detects not-working", () => {
    expect(matchDebugPatterns("the button doesn't work")[0]!.id).toBe("not-working");
    expect(matchDebugPatterns("el formulario no funciona")[0]!.id).toBe("not-working");
    expect(matchDebugPatterns("the app crashed")[0]!.id).toBe("not-working");
  });

  test("detects slow performance", () => {
    expect(matchDebugPatterns("the page is really slow")[0]!.id).toBe("slow-performance");
    expect(matchDebugPatterns("la app tarda mucho en cargar")[0]!.id).toBe("slow-performance");
    expect(matchDebugPatterns("there's a memory leak")[0]!.id).toBe("slow-performance");
  });

  test("detects stale UI", () => {
    expect(matchDebugPatterns("the count doesn't update")[0]!.id).toBe("stale-ui");
    expect(matchDebugPatterns("no se actualiza el valor")[0]!.id).toBe("stale-ui");
    expect(matchDebugPatterns("showing stale data")[0]!.id).toBe("stale-ui");
  });

  test("detects wrong data", () => {
    expect(matchDebugPatterns("shows the wrong total")[0]!.id).toBe("wrong-data");
    expect(matchDebugPatterns("el precio calcula mal")[0]!.id).toBe("wrong-data");
  });

  test("detects missing behavior", () => {
    expect(matchDebugPatterns("it's not saving the data")[0]!.id).toBe("missing-behavior");
    expect(matchDebugPatterns("falta la validación")[0]!.id).toBe("missing-behavior");
  });

  test("detects auth issues", () => {
    expect(matchDebugPatterns("can't log in")[0]!.id).toBe("auth-issue");
    expect(matchDebugPatterns("getting 401 unauthorized")[0]!.id).toBe("auth-issue");
    expect(matchDebugPatterns("access denied to the API")[0]!.id).toBe("auth-issue");
  });

  test("detects import errors", () => {
    expect(matchDebugPatterns("cannot find module '../utils'")[0]!.id).toBe("import-error");
    expect(matchDebugPatterns("module not found error")[0]!.id).toBe("import-error");
  });

  test("detects visual bugs", () => {
    expect(matchDebugPatterns("the sidebar is not visible")[0]!.id).toBe("visual-bug");
    expect(matchDebugPatterns("content overflow issue")[0]!.id).toBe("visual-bug");
    expect(matchDebugPatterns("z-index issue with dropdown")[0]!.id).toBe("visual-bug");
  });

  test("detects network errors", () => {
    expect(matchDebugPatterns("CORS error on fetch")[0]!.id).toBe("network-error");
    expect(matchDebugPatterns("API returns 500")[0]!.id).toBe("network-error");
    expect(matchDebugPatterns("connection refused")[0]!.id).toBe("network-error");
  });

  test("returns empty for unmatched descriptions", () => {
    expect(matchDebugPatterns("add a new button to the header")).toHaveLength(0);
    expect(matchDebugPatterns("refactor the utils module")).toHaveLength(0);
  });

  // ── Keyword extraction ──
  test("extracts technical terms", () => {
    const kw = extractSearchKeywords("the modal dialog is broken");
    expect(kw).toContain("modal");
    expect(kw).toContain("dialog");
  });

  test("extracts quoted terms", () => {
    const kw = extractSearchKeywords('error: "cannot read property"');
    expect(kw).toContain("cannot read property");
  });

  test("extracts component names", () => {
    const kw = extractSearchKeywords("the LoginDialog component crashes");
    expect(kw).toContain("LoginDialog");
  });

  test("extracts error codes", () => {
    const kw = extractSearchKeywords("getting ERR_CONNECTION_REFUSED");
    expect(kw).toContain("ERR_CONNECTION_REFUSED");
  });
});
