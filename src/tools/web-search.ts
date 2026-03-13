// KCode - WebSearch Tool
// Search the web using Brave Search API, SearXNG, or DuckDuckGo fallback scraping

import type { ToolDefinition, ToolResult } from "../core/types";

export interface WebSearchInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const webSearchDefinition: ToolDefinition = {
  name: "WebSearch",
  description:
    "Search the web for information. Uses Brave Search API if BRAVE_API_KEY is set, SearXNG if SEARXNG_URL is set, otherwise falls back to DuckDuckGo HTML scraping.",
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
    },
    required: ["query"],
  },
};

async function braveSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, count: "10" });
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

async function searxngSearch(query: string, baseUrl: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, format: "json" });
  const response = await fetch(`${baseUrl}/search?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`SearXNG error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    results?: Array<{ title: string; url: string; content: string }>;
  };

  return (data.results ?? []).slice(0, 10).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

async function fallbackScrapeSearch(query: string): Promise<SearchResult[]> {
  // Use DuckDuckGo HTML as a scraping fallback
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
    headers: {
      "User-Agent": "KCode/0.1 (AI coding assistant)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Scrape search failed: ${response.status}`);
  }

  const html = await response.text();
  const results: SearchResult[] = [];

  // Extract results from DuckDuckGo HTML
  const resultBlocks = html.split(/class="result__body"/);
  for (let i = 1; i < Math.min(resultBlocks.length, 11); i++) {
    const block = resultBlocks[i];

    // Extract title and URL
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/a>/);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/td/);

    if (titleMatch) {
      let url = titleMatch[1];
      // DuckDuckGo wraps URLs in redirects
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }

      const title = titleMatch[2].replace(/<[^>]+>/g, "").trim();
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";

      results.push({ title, url, snippet });
    }
  }

  return results;
}

function filterResults(
  results: SearchResult[],
  allowedDomains?: string[],
  blockedDomains?: string[]
): SearchResult[] {
  let filtered = results;

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

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No search results found.";
  }

  return results
    .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`)
    .join("\n\n");
}

export async function executeWebSearch(input: Record<string, unknown>): Promise<ToolResult> {
  const { query, allowed_domains, blocked_domains } = input as WebSearchInput;

  const apiKey = process.env.BRAVE_API_KEY;

  // Build search tier list in priority order
  const tiers: Array<{ name: string; fn: () => Promise<SearchResult[]> }> = [];

  if (apiKey) {
    tiers.push({ name: "Brave Search", fn: () => braveSearch(query, apiKey) });
  }

  // SearXNG: enabled when SEARXNG_URL env var is set (even if empty string, defaults to localhost:8888)
  if ("SEARXNG_URL" in process.env) {
    const searxngUrl = process.env.SEARXNG_URL || "http://localhost:8888";
    tiers.push({ name: "SearXNG", fn: () => searxngSearch(query, searxngUrl) });
  }

  tiers.push({ name: "DuckDuckGo (fallback)", fn: () => fallbackScrapeSearch(query) });

  const errors: string[] = [];

  for (const tier of tiers) {
    try {
      let results = await tier.fn();
      results = filterResults(results, allowed_domains, blocked_domains);

      const output = `Search: "${query}" (via ${tier.name})\n\n${formatResults(results)}`;
      return { tool_use_id: "", content: output };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${tier.name}: ${msg}`);
      // Fall through to next tier
    }
  }

  // All tiers failed
  return {
    tool_use_id: "",
    content: `All search backends failed for "${query}":\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    is_error: true,
  };
}
