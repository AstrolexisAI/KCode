// KCode - Internationalization Engine

import { detectLocale } from "./detector";
import de from "./locales/de";
import en from "./locales/en";
import es from "./locales/es";
import fr from "./locales/fr";
import ja from "./locales/ja";
import ko from "./locales/ko";
import pt from "./locales/pt";
import zh from "./locales/zh";

type LocaleMessages = Record<string, string>;

interface I18nConfig {
  locale: string;
  fallback: string;
}

const BUILTIN_LOCALES: Record<string, LocaleMessages> = {
  en,
  es,
  pt,
  fr,
  de,
  zh,
  ja,
  ko,
};

const customLocales: Record<string, LocaleMessages> = {};

class I18n {
  private locale: string;
  private messages: LocaleMessages;
  private fallbackMessages: LocaleMessages;

  constructor(config: I18nConfig) {
    this.locale = config.locale;
    this.messages = resolveLocale(config.locale);
    this.fallbackMessages =
      config.locale !== config.fallback ? resolveLocale(config.fallback) : this.messages;
  }

  t(key: string, params?: Record<string, string | number>): string {
    let message = this.messages[key] || this.fallbackMessages[key] || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        message = message.replaceAll(`{${k}}`, String(v));
      }
    }
    return message;
  }

  tp(key: string, count: number, params?: Record<string, string | number>): string {
    const pluralKey = count === 1 ? `${key}.one` : `${key}.other`;
    return this.t(pluralKey, { ...params, count });
  }

  getLocale(): string {
    return this.locale;
  }

  setLocale(locale: string): void {
    this.locale = locale;
    this.messages = resolveLocale(locale);
  }
}

function resolveLocale(locale: string): LocaleMessages {
  return (
    customLocales[locale] ||
    BUILTIN_LOCALES[locale] ||
    customLocales[locale.split("-")[0]] ||
    BUILTIN_LOCALES[locale.split("-")[0]] ||
    {}
  );
}

// ─── Singleton ──────────────────────────────────────────────────

let _i18n: I18n | null = null;

export function initI18n(locale?: string): void {
  const resolved = locale || detectLocale();
  _i18n = new I18n({ locale: resolved, fallback: "en" });
}

function ensureInit(): I18n {
  if (!_i18n) initI18n();
  return _i18n!;
}

export function t(key: string, params?: Record<string, string | number>): string {
  return ensureInit().t(key, params);
}

export function tp(key: string, count: number, params?: Record<string, string | number>): string {
  return ensureInit().tp(key, count, params);
}

export function setLocale(locale: string): void {
  ensureInit().setLocale(locale);
}

export function getLocale(): string {
  return ensureInit().getLocale();
}

export function registerLocale(code: string, messages: LocaleMessages): void {
  customLocales[code] = messages;
}

export function getAvailableLocales(): string[] {
  return [...new Set([...Object.keys(BUILTIN_LOCALES), ...Object.keys(customLocales)])];
}

export type { SupportedLocale } from "./detector";
export { detectLocale, isSupportedLocale, SUPPORTED_LOCALES } from "./detector";
