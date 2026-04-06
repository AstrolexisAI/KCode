// KCode - Web Engine: Site Type & Stack Detector
//
// Detects what the user wants to build from natural language,
// then selects the optimal tech stack.

import type { SiteType, Stack } from "./types";

export interface DetectedIntent {
  siteType: SiteType;
  stack: Stack;
  name: string;
  features: string[];
  pages: string[];
  hasAuth: boolean;
  hasDb: boolean;
  hasPayments: boolean;
  hasDarkMode: boolean;
  isResponsive: boolean;
}

interface SiteRule {
  type: SiteType;
  patterns: RegExp[];
  defaultStack: Stack;
  defaultFeatures: string[];
  defaultPages: string[];
}

const SITE_RULES: SiteRule[] = [
  {
    type: "saas",
    patterns: [
      /\bsaas\b/i,
      /\b(?:app|application)\s+(?:with|con)\s+(?:auth|login|dashboard)/i,
      /\b(?:subscription|suscripci[oó]n|pricing\s+plan)/i,
    ],
    defaultStack: "nextjs",
    defaultFeatures: ["auth", "dashboard", "landing", "pricing", "api", "database", "dark-mode"],
    defaultPages: ["landing", "login", "signup", "dashboard", "settings", "pricing"],
  },
  {
    type: "landing",
    patterns: [
      /\blanding\s*(?:page)?\b/i,
      /\bmarketing\s+(?:page|site)\b/i,
      /\bp[aá]gina\s+(?:de\s+)?(?:inicio|presentaci[oó]n|marketing)\b/i,
      /\bwebsite\s+for\s+(?:my|our|a)\b/i,
      /\bsitio\s+web\s+(?:para|de)\b/i,
    ],
    defaultStack: "nextjs",
    defaultFeatures: ["hero", "features", "testimonials", "pricing", "cta", "footer", "responsive", "seo"],
    defaultPages: ["index"],
  },
  {
    type: "dashboard",
    patterns: [
      /\bdashboard\b/i,
      /\badmin\s*(?:panel)?\b/i,
      /\bpanel\s+(?:de\s+)?(?:control|admin)/i,
    ],
    defaultStack: "nextjs",
    defaultFeatures: ["sidebar", "charts", "tables", "auth", "dark-mode", "responsive"],
    defaultPages: ["dashboard", "analytics", "users", "settings"],
  },
  {
    type: "blog",
    patterns: [
      /\bblog\b/i,
      /\b(?:content|article|post)\s+(?:site|website)\b/i,
    ],
    defaultStack: "astro",
    defaultFeatures: ["markdown", "seo", "rss", "tags", "search", "responsive"],
    defaultPages: ["index", "blog/[slug]", "about"],
  },
  {
    type: "ecommerce",
    patterns: [
      /\b(?:e-?commerce|shop|store|tienda)\b/i,
      /\b(?:sell|vender)\s+(?:products|productos)\b/i,
    ],
    defaultStack: "nextjs",
    defaultFeatures: ["products", "cart", "checkout", "auth", "search", "payments", "responsive"],
    defaultPages: ["index", "products", "product/[id]", "cart", "checkout"],
  },
  {
    type: "portfolio",
    patterns: [
      /\bportfolio\b/i,
      /\bpersonal\s+(?:site|website|page)\b/i,
      /\bp[aá]gina\s+personal\b/i,
    ],
    defaultStack: "astro",
    defaultFeatures: ["hero", "projects", "about", "contact", "responsive", "seo", "dark-mode"],
    defaultPages: ["index", "projects", "about", "contact"],
  },
  {
    type: "docs",
    patterns: [
      /\bdoc(?:s|umentation)\b/i,
      /\bdocumentaci[oó]n\b/i,
    ],
    defaultStack: "astro",
    defaultFeatures: ["sidebar", "search", "markdown", "seo", "toc", "responsive"],
    defaultPages: ["index", "getting-started", "api-reference"],
  },
  {
    type: "api",
    patterns: [
      /\bapi\s+(?:server|backend|rest|graphql)\b/i,
      /\bbackend\s+(?:api|server)\b/i,
    ],
    defaultStack: "express",
    defaultFeatures: ["routes", "middleware", "validation", "auth", "database", "cors"],
    defaultPages: [],
  },
  {
    type: "fullstack",
    patterns: [
      /\bfull\s*stack\b/i,
      /\b(?:app|application)\s+(?:completa|full)\b/i,
    ],
    defaultStack: "nextjs",
    defaultFeatures: ["auth", "database", "api", "dashboard", "landing", "responsive", "dark-mode"],
    defaultPages: ["index", "login", "dashboard", "api"],
  },
];

// Stack override detection
const STACK_OVERRIDES: Array<{ pattern: RegExp; stack: Stack }> = [
  { pattern: /\b(?:next\.?js|next)\b/i, stack: "nextjs" },
  { pattern: /\bastro\b/i, stack: "astro" },
  { pattern: /\b(?:svelte|sveltekit)\b/i, stack: "svelte" },
  { pattern: /\b(?:vue|nuxt)\b/i, stack: "vue" },
  { pattern: /\bhtml\b/i, stack: "html" },
  { pattern: /\bexpress\b/i, stack: "express" },
  { pattern: /\b(?:fastapi|flask|django)\b/i, stack: "fastapi" },
  { pattern: /\brails\b/i, stack: "rails" },
];

// Feature detection from user message
const FEATURE_PATTERNS: Array<{ pattern: RegExp; feature: string }> = [
  { pattern: /\b(?:auth|login|signup|register|autenticaci[oó]n)\b/i, feature: "auth" },
  { pattern: /\b(?:dark\s*mode|modo\s*oscuro|theme)\b/i, feature: "dark-mode" },
  { pattern: /\b(?:payment|stripe|pay|pago|checkout)\b/i, feature: "payments" },
  { pattern: /\b(?:database|db|postgres|mongo|sqlite|base\s*de\s*datos)\b/i, feature: "database" },
  { pattern: /\b(?:search|buscar|b[uú]squeda)\b/i, feature: "search" },
  { pattern: /\b(?:chart|graph|analytics|gr[aá]fico)\b/i, feature: "charts" },
  { pattern: /\b(?:responsive|mobile|m[oó]vil)\b/i, feature: "responsive" },
  { pattern: /\b(?:seo|meta\s*tags|opengraph)\b/i, feature: "seo" },
  { pattern: /\b(?:i18n|multilingual|multi.?idioma|translations)\b/i, feature: "i18n" },
  { pattern: /\b(?:email|newsletter|correo)\b/i, feature: "email" },
  { pattern: /\b(?:upload|file|imagen|image|foto)\b/i, feature: "upload" },
  { pattern: /\b(?:real.?time|websocket|socket|tiempo\s*real)\b/i, feature: "realtime" },
  { pattern: /\b(?:chat|messaging|mensajer[ií]a)\b/i, feature: "chat" },
  { pattern: /\b(?:notification|notificaci[oó]n)\b/i, feature: "notifications" },
  { pattern: /\b(?:map|mapa|google\s*maps|mapbox)\b/i, feature: "maps" },
];

// Project name extraction
function extractName(message: string): string {
  // "create a site called X" / "build X website"
  const m = message.match(
    /(?:called|named|nombre|llamad[oa])\s+["']?(\w[\w-]*)/i,
  ) ?? message.match(
    /(?:for|para)\s+["']?(\w[\w-]*)/i,
  );
  return m?.[1] ?? "my-site";
}

/**
 * Detect what the user wants to build from natural language.
 */
export function detectWebIntent(message: string): DetectedIntent {
  // Detect site type
  let siteType: SiteType = "landing"; // default
  let defaultFeatures: string[] = [];
  let defaultPages: string[] = [];
  let defaultStack: Stack = "nextjs";

  for (const rule of SITE_RULES) {
    if (rule.patterns.some(p => p.test(message))) {
      siteType = rule.type;
      defaultStack = rule.defaultStack;
      defaultFeatures = [...rule.defaultFeatures];
      defaultPages = [...rule.defaultPages];
      break;
    }
  }

  // Detect stack override
  let stack = defaultStack;
  for (const override of STACK_OVERRIDES) {
    if (override.pattern.test(message)) {
      stack = override.stack;
      break;
    }
  }

  // Detect additional features
  const features = new Set(defaultFeatures);
  for (const fp of FEATURE_PATTERNS) {
    if (fp.pattern.test(message)) features.add(fp.feature);
  }

  return {
    siteType,
    stack,
    name: extractName(message),
    features: Array.from(features),
    pages: defaultPages,
    hasAuth: features.has("auth"),
    hasDb: features.has("database"),
    hasPayments: features.has("payments"),
    hasDarkMode: features.has("dark-mode"),
    isResponsive: features.has("responsive") || true, // always responsive
  };
}
