// KCode - Locale Detection

export const SUPPORTED_LOCALES = [
  "en", "es", "pt", "fr", "de", "zh", "ja", "ko",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export function detectLocale(): string {
  // 1. KCODE_LANG env var (explicit override)
  if (process.env.KCODE_LANG) {
    return normalizeLocale(process.env.KCODE_LANG);
  }

  // 2. System locale env vars
  const envLang =
    process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES;
  if (envLang) {
    const match = envLang.match(/^([a-z]{2})([_-][A-Za-z]{2})?/i);
    if (match) return match[1].toLowerCase();
  }

  // 3. Default to English
  return "en";
}

export function normalizeLocale(locale: string): string {
  const match = locale.match(/^([a-z]{2})([_-][a-z]{2})?/i);
  return match ? match[1].toLowerCase() : "en";
}

export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale);
}
