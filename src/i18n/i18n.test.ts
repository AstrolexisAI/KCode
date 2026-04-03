// KCode - i18n integration tests
// Tests translation lookup, fallback, language switching, and auto-detection

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { detectLocale, isSupportedLocale, normalizeLocale, SUPPORTED_LOCALES } from "./detector";
import {
  getAvailableLocales,
  getLocale,
  initI18n,
  registerLocale,
  setLocale,
  t,
  tp,
} from "./index";

// ─── Translation Lookup ─────────────────────────────────────────

describe("Translation lookup (t function)", () => {
  beforeEach(() => {
    initI18n("en");
  });

  test("returns correct translation for known key", () => {
    expect(t("welcome")).toBe("Welcome to KCode");
    expect(t("goodbye")).toBe("Goodbye");
    expect(t("loading")).toBe("Loading...");
  });

  test("interpolates single parameter", () => {
    expect(t("session.model", { model: "gpt-4" })).toBe("Model: gpt-4");
  });

  test("interpolates multiple parameters", () => {
    expect(t("tool.completed", { tool: "Grep", duration: 42 })).toBe("Grep completed in 42ms");
  });

  test("returns key verbatim for missing translation", () => {
    expect(t("this.key.does.not.exist")).toBe("this.key.does.not.exist");
  });

  test("leaves unreplaced placeholders when params are missing", () => {
    const result = t("tool.completed");
    expect(result).toContain("{tool}");
    expect(result).toContain("{duration}");
  });

  test("handles numeric zero as parameter", () => {
    expect(t("session.tokens", { count: 0 })).toBe("0 tokens used");
  });

  test("pluralization via tp()", () => {
    expect(tp("files", 1)).toBe("1 file");
    expect(tp("files", 3)).toBe("3 files");
    expect(tp("files", 0)).toBe("0 files");
    expect(tp("errors", 1)).toBe("1 error");
    expect(tp("errors", 99)).toBe("99 errors");
  });
});

// ─── Fallback to English ────────────────────────────────────────

describe("Fallback to English for missing keys", () => {
  test("unknown locale falls back to English", () => {
    initI18n("xx");
    expect(t("welcome")).toBe("Welcome to KCode");
    expect(t("loading")).toBe("Loading...");
  });

  test("regional variant falls back to base language", () => {
    // "es-MX" should fall back to "es"
    initI18n("es-MX");
    expect(t("welcome")).toBe("Bienvenido a KCode");
  });

  test("partially translated locale falls back to English for missing keys", () => {
    registerLocale("partial", { welcome: "Partial Welcome" });
    initI18n("partial");
    expect(t("welcome")).toBe("Partial Welcome");
    // Key not in partial locale — should fall back to English
    expect(t("goodbye")).toBe("Goodbye");
  });

  test("completely empty locale falls back to English for all keys", () => {
    registerLocale("empty", {});
    initI18n("empty");
    expect(t("welcome")).toBe("Welcome to KCode");
  });
});

// ─── Language Switching ─────────────────────────────────────────

describe("Language switching at runtime", () => {
  beforeEach(() => {
    initI18n("en");
  });

  test("switches from English to Spanish", () => {
    expect(t("welcome")).toBe("Welcome to KCode");
    setLocale("es");
    expect(t("welcome")).toBe("Bienvenido a KCode");
    expect(getLocale()).toBe("es");
  });

  test("switches from Spanish back to English", () => {
    setLocale("es");
    expect(t("welcome")).toBe("Bienvenido a KCode");
    setLocale("en");
    expect(t("welcome")).toBe("Welcome to KCode");
    expect(getLocale()).toBe("en");
  });

  test("cycles through all built-in locales", () => {
    for (const locale of SUPPORTED_LOCALES) {
      setLocale(locale);
      expect(getLocale()).toBe(locale);
      // Every locale should have a welcome message containing "KCode"
      expect(t("welcome")).toContain("KCode");
    }
  });

  test("getAvailableLocales returns all 8 built-in locales", () => {
    const locales = getAvailableLocales();
    expect(locales.length).toBeGreaterThanOrEqual(8);
    for (const code of ["en", "es", "fr", "de", "ja", "ko", "pt", "zh"]) {
      expect(locales).toContain(code);
    }
  });

  test("registerLocale adds to available locales", () => {
    registerLocale("test-lang", { welcome: "Test" });
    expect(getAvailableLocales()).toContain("test-lang");
    setLocale("test-lang");
    expect(t("welcome")).toBe("Test");
  });
});

// ─── Auto-detection ─────────────────────────────────────────────

describe("Locale auto-detection", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const k of ["KCODE_LANG", "LANG", "LC_ALL", "LC_MESSAGES"]) {
      if (origEnv[k]) process.env[k] = origEnv[k];
      else delete process.env[k];
    }
  });

  test("KCODE_LANG env var takes highest priority", () => {
    process.env.KCODE_LANG = "fr";
    process.env.LANG = "de_DE.UTF-8";
    expect(detectLocale()).toBe("fr");
  });

  test("falls back to LANG when KCODE_LANG is not set", () => {
    delete process.env.KCODE_LANG;
    process.env.LANG = "ja_JP.UTF-8";
    expect(detectLocale()).toBe("ja");
  });

  test("falls back to LC_ALL when LANG is not set", () => {
    delete process.env.KCODE_LANG;
    delete process.env.LANG;
    process.env.LC_ALL = "ko_KR.UTF-8";
    expect(detectLocale()).toBe("ko");
  });

  test("defaults to en when no env vars are set", () => {
    delete process.env.KCODE_LANG;
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    expect(detectLocale()).toBe("en");
  });

  test("normalizeLocale strips region and encoding", () => {
    expect(normalizeLocale("pt_BR.UTF-8")).toBe("pt");
    expect(normalizeLocale("zh-CN")).toBe("zh");
    expect(normalizeLocale("en_US")).toBe("en");
  });

  test("isSupportedLocale validates correctly", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("es")).toBe(true);
    expect(isSupportedLocale("xx")).toBe(false);
    expect(isSupportedLocale("")).toBe(false);
  });

  test("initI18n with no argument uses auto-detection", () => {
    process.env.KCODE_LANG = "de";
    initI18n();
    expect(getLocale()).toBe("de");
    expect(t("welcome")).toBe("Willkommen bei KCode");
  });
});
