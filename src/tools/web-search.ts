// KCode - WebSearch Tool
// Search the web using Brave Search API, SearXNG, or DuckDuckGo fallback scraping.
// Features: domain filtering, freshness filter, result caching, rate limiting, deduplication.

import type { ToolDefinition, ToolResult } from "../core/types";

export interface WebSearchInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  max_results?: number;
  freshness?: "day" | "week" | "month" | "year";
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ─── Cache ──────────────────────────────────────────────────────

interface CacheEntry {
  results: SearchResult[];
  provider: string;
  timestamp: number;
}

const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const searchCache = new Map<string, CacheEntry>();

function buildCacheKey(input: WebSearchInput): string {
  const parts = [
    input.query.toLowerCase().trim(),
    input.allowed_domains?.sort().join(",") ?? "",
    input.blocked_domains?.sort().join(",") ?? "",
    String(input.max_results ?? 10),
    input.freshness ?? "",
  ];
  return parts.join("|");
}

function getCached(key: string): CacheEntry | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    searchCache.delete(key);
    return null;
  }
  return entry;
}

function setCache(key: string, results: SearchResult[], provider: string): void {
  // Evict expired entries when cache grows large
  if (searchCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of searchCache) {
      if (now - v.timestamp > CACHE_TTL) searchCache.delete(k);
    }
  }
  searchCache.set(key, { results, provider, timestamp: Date.now() });
}

// ─── Rate Limiting ──────────────────────────────────────────────

const MAX_SEARCHES_PER_MINUTE = 10;
const searchTimestamps: number[] = [];

function checkRateLimit(): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  // Remove timestamps older than 1 minute
  while (searchTimestamps.length > 0 && searchTimestamps[0] < cutoff) {
    searchTimestamps.shift();
  }
  if (searchTimestamps.length >= MAX_SEARCHES_PER_MINUTE) {
    return false;
  }
  searchTimestamps.push(now);
  return true;
}

// ─── Tool Definition ────────────────────────────────────────────

export const webSearchDefinition: ToolDefinition = {
  name: "WebSearch",
  description:
    "Search the web for information. Uses Brave Search API if BRAVE_API_KEY is set, SearXNG if SEARXNG_URL is set, otherwise falls back to DuckDuckGo HTML scraping. Supports domain filtering, freshness filters, and result caching.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      allowed_domains: {
        type: "array",
        items: { type: "string" },
        description: "Only return results from these domains",
      },
      blocked_domains: {
        type: "array",
        items: { type: "string" },
        description: "Exclude results from these domains",
      },
      max_results: {
        type: "number",
        description: "Maximum number of results to return (default: 10)",
      },
      freshness: {
        type: "string",
        enum: ["day", "week", "month", "year"],
        description: "Filter results by recency",
      },
    },
    required: ["query"],
  },
};

// ─── Search Providers ───────────────────────────────────────────

async function braveSearch(query: string, apiKey: string, freshness?: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, count: "20" });
  if (freshness) {
    const freshnessMap: Record<string, string> = {
      day: "pd",
      week: "pw",
      month: "pm",
      year: "py",
    };
    if (freshnessMap[freshness]) {
      params.set("freshness", freshnessMap[freshness]);
    }
  }

  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };

  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

async function searxngSearch(query: string, baseUrl: string, freshness?: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, format: "json" });
  if (freshness) {
    const timeRangeMap: Record<string, string> = {
      day: "day",
      week: "week",
      month: "month",
      year: "year",
    };
    if (timeRangeMap[freshness]) {
      params.set("time_range", timeRangeMap[freshness]);
    }
  }

  const response = await fetch(`${baseUrl}/search?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`SearXNG error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    results?: Array<{ title: string; url: string; content: string }>;
  };

  return (data.results ?? []).slice(0, 20).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

async function fallbackScrapeSearch(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
    headers: {
      "User-Agent": "KCode/1.0 (AI coding assistant)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Scrape search failed: ${response.status}`);
  }

  const html = await response.text();
  const results: SearchResult[] = [];

  const resultBlocks = html.split(/class="result__body"/);
  for (let i = 1; i < Math.min(resultBlocks.length, 21); i++) {
    const block = resultBlocks[i];

    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/a>/);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/td/);

    if (titleMatch) {
      let url = titleMatch[1];
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }

      const title = sanitizeHtml(titleMatch[2]);
      const snippet = snippetMatch ? sanitizeHtml(snippetMatch[1]) : "";

      results.push({ title, url, snippet });
    }
  }

  return results;
}

// ─── Result Processing ──────────────────────────────────────────

function sanitizeHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function filterResults(
  results: SearchResult[],
  allowedDomains?: string[],
  blockedDomains?: string[]
): SearchResult[] {
  let filtered = results;

  // HTTPS only
  filtered = filtered.filter((r) => {
    try {
      const parsed = new URL(r.url);
      return parsed.protocol === "https:";
    } catch {
      return false;
    }
  });

  if (allowedDomains && allowedDomains.length > 0) {
    filtered = filtered.filter((r) => {
      try {
        const hostname = new URL(r.url).hostname;
        return allowedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
      } catch {
        return false;
      }
    });
  }

  if (blockedDomains && blockedDomains.length > 0) {
    filtered = filtered.filter((r) => {
      try {
        const hostname = new URL(r.url).hostname;
        return !blockedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
      } catch {
        return true;
      }
    });
  }

  return filtered;
}

function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];

  for (const result of results) {
    let normalizedUrl: string;
    try {
      const parsed = new URL(result.url);
      parsed.hash = "";
      parsed.searchParams.delete("utm_source");
      parsed.searchParams.delete("utm_medium");
      parsed.searchParams.delete("utm_campaign");
      parsed.searchParams.delete("utm_content");
      parsed.searchParams.delete("utm_term");
      normalizedUrl = parsed.toString().replace(/\/+$/, "");
    } catch {
      normalizedUrl = result.url;
    }

    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);

    // Also check for near-duplicate titles (same title from different URL variants)
    const normalizedTitle = result.title.toLowerCase().replace(/\s+/g, " ").trim();
    const titleKey = `title:${normalizedTitle}`;
    if (normalizedTitle.length > 10 && seen.has(titleKey)) continue;
    if (normalizedTitle.length > 10) seen.add(titleKey);

    deduped.push(result);
  }

  return deduped;
}

function formatResults(results: SearchResult[], provider: string): string {
  if (results.length === 0) {
    return "No search results found.";
  }

  const lines = results.map((r, i) => {
    const snippet = r.snippet ? `\n   ${r.snippet}` : "";
    return `${i + 1}. **${r.title}**\n   ${r.url}${snippet}`;
  });

  return lines.join("\n\n") + `\n\n---\n*Source: ${provider}*`;
}

// ─── Execute ────────────────────────────────────────────────────

export async function executeWebSearch(input: Record<string, unknown>): Promise<ToolResult> {
  const {
    query,
    allowed_domains,
    blocked_domains,
    max_results = 10,
    freshness,
  } = input as WebSearchInput;

  const maxCount = Math.min(Math.max(1, max_results), 20);

  // Rate limiting
  if (!checkRateLimit()) {
    return {
      tool_use_id: "",
      content: "Rate limit exceeded: maximum 10 searches per minute. Please wait before searching again.",
      is_error: true,
    };
  }

  // Check cache
  const cacheKey = buildCacheKey({ query, allowed_domains, blocked_domains, max_results: maxCount, freshness });
  const cached = getCached(cacheKey);
  if (cached) {
    const filtered = filterResults(cached.results, allowed_domains, blocked_domains);
    const deduped = deduplicateResults(filtered).slice(0, maxCount);
    const output = `Search: "${query}" (via ${cached.provider}, cached)\n\n${formatResults(deduped, cached.provider)}`;
    return { tool_use_id: "", content: output };
  }

  const apiKey = process.env.BRAVE_API_KEY;

  const tiers: Array<{ name: string; fn: () => Promise<SearchResult[]> }> = [];

  if (apiKey) {
    tiers.push({ name: "Brave Search", fn: () => braveSearch(query, apiKey, freshness) });
  }

  if ("SEARXNG_URL" in process.env) {
    const searxngUrl = process.env.SEARXNG_URL || "http://localhost:8888";
    tiers.push({ name: "SearXNG", fn: () => searxngSearch(query, searxngUrl, freshness) });
  }

  tiers.push({ name: "DuckDuckGo (fallback)", fn: () => fallbackScrapeSearch(query) });

  const errors: string[] = [];

  for (const tier of tiers) {
    try {
      let results = await tier.fn();
      // Cache raw results before filtering
      setCache(cacheKey, results, tier.name);

      results = filterResults(results, allowed_domains, blocked_domains);
      results = deduplicateResults(results).slice(0, maxCount);

      const output = `Search: "${query}" (via ${tier.name})\n\n${formatResults(results, tier.name)}`;
      return { tool_use_id: "", content: output };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${tier.name}: ${msg}`);
    }
  }

  return {
    tool_use_id: "",
    content: `All search backends failed for "${query}":\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    is_error: true,
  };
}
