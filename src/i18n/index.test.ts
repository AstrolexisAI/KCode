import { beforeEach, describe, expect, test } from "bun:test";
import {
  getAvailableLocales,
  getLocale,
  initI18n,
  registerLocale,
  setLocale,
  t,
  tp,
} from "./index";

describe("i18n", () => {
  beforeEach(() => {
    initI18n("en");
  });

  describe("t()", () => {
    test("returns English message by default", () => {
      expect(t("welcome")).toBe("Welcome to KCode");
    });

    test("interpolates parameters", () => {
      expect(t("tool.completed", { tool: "Bash", duration: 150 })).toBe("Bash completed in 150ms");
    });

    test("returns key for missing translation", () => {
      expect(t("nonexistent.key")).toBe("nonexistent.key");
    });

    test("handles multiple parameters", () => {
      expect(t("session.cost", { cost: "0.05" })).toBe("Session cost: $0.05");
    });
  });

  describe("tp()", () => {
    test("uses singular form for count=1", () => {
      expect(tp("files", 1)).toBe("1 file");
    });

    test("uses plural form for count>1", () => {
      expect(tp("files", 5)).toBe("5 files");
    });

    test("uses plural form for count=0", () => {
      expect(tp("errors", 0)).toBe("0 errors");
    });
  });

  describe("setLocale()", () => {
    test("switches to Spanish", () => {
      setLocale("es");
      expect(t("welcome")).toBe("Bienvenido a KCode");
      expect(getLocale()).toBe("es");
    });

    test("switches to Portuguese", () => {
      setLocale("pt");
      expect(t("welcome")).toBe("Bem-vindo ao KCode");
    });

    test("switches to French", () => {
      setLocale("fr");
      expect(t("welcome")).toBe("Bienvenue sur KCode");
    });

    test("switches to German", () => {
      setLocale("de");
      expect(t("welcome")).toBe("Willkommen bei KCode");
    });

    test("switches to Chinese", () => {
      setLocale("zh");
      expect(t("welcome")).toContain("KCode");
    });

    test("switches to Japanese", () => {
      setLocale("ja");
      expect(t("welcome")).toContain("KCode");
    });

    test("switches to Korean", () => {
      setLocale("ko");
      expect(t("welcome")).toContain("KCode");
    });
  });

  describe("fallback", () => {
    test("falls back to English for unknown locale", () => {
      initI18n("xx");
      expect(t("welcome")).toBe("Welcome to KCode");
    });

    test("falls back for missing keys in locale", () => {
      // All locales should have welcome, but test the fallback mechanism
      setLocale("es");
      expect(t("nonexistent.key")).toBe("nonexistent.key");
    });
  });

  describe("registerLocale()", () => {
    test("registers custom locale", () => {
      registerLocale("test", { welcome: "Test Welcome" });
      setLocale("test");
      expect(t("welcome")).toBe("Test Welcome");
    });
  });

  describe("getAvailableLocales()", () => {
    test("returns all built-in locales", () => {
      const locales = getAvailableLocales();
      expect(locales).toContain("en");
      expect(locales).toContain("es");
      expect(locales).toContain("pt");
      expect(locales).toContain("fr");
      expect(locales).toContain("de");
      expect(locales).toContain("zh");
      expect(locales).toContain("ja");
      expect(locales).toContain("ko");
    });
  });

  describe("interpolation edge cases", () => {
    test("handles missing params gracefully", () => {
      const result = t("tool.completed");
      expect(result).toContain("{tool}"); // unreplaced
    });

    test("handles numeric params", () => {
      expect(t("session.tokens", { count: 1000 })).toBe("1000 tokens used");
    });
  });
});
