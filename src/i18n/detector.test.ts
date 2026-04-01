import { describe, test, expect, afterEach } from "bun:test";
import { detectLocale, normalizeLocale, isSupportedLocale } from "./detector";

describe("detectLocale", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    delete process.env.KCODE_LANG;
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    // Restore only keys we touched
    for (const k of ["KCODE_LANG", "LANG", "LC_ALL", "LC_MESSAGES"]) {
      if (origEnv[k]) process.env[k] = origEnv[k];
      else delete process.env[k];
    }
  });

  test("uses KCODE_LANG if set", () => {
    process.env.KCODE_LANG = "es";
    expect(detectLocale()).toBe("es");
  });

  test("normalizes KCODE_LANG", () => {
    process.env.KCODE_LANG = "pt-BR";
    expect(detectLocale()).toBe("pt");
  });

  test("uses LANG as fallback", () => {
    delete process.env.KCODE_LANG;
    process.env.LANG = "fr_FR.UTF-8";
    expect(detectLocale()).toBe("fr");
  });

  test("uses LC_ALL", () => {
    delete process.env.KCODE_LANG;
    delete process.env.LANG;
    process.env.LC_ALL = "de_DE.UTF-8";
    expect(detectLocale()).toBe("de");
  });

  test("defaults to en", () => {
    delete process.env.KCODE_LANG;
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    expect(detectLocale()).toBe("en");
  });
});

describe("normalizeLocale", () => {
  test("extracts base language", () => {
    expect(normalizeLocale("en_US.UTF-8")).toBe("en");
    expect(normalizeLocale("pt-BR")).toBe("pt");
    expect(normalizeLocale("zh")).toBe("zh");
  });

  test("returns en for invalid input", () => {
    expect(normalizeLocale("")).toBe("en");
    expect(normalizeLocale("123")).toBe("en");
  });
});

describe("isSupportedLocale", () => {
  test("recognizes supported locales", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("es")).toBe(true);
    expect(isSupportedLocale("ja")).toBe(true);
  });

  test("rejects unsupported locales", () => {
    expect(isSupportedLocale("xx")).toBe(false);
    expect(isSupportedLocale("")).toBe(false);
  });
});
