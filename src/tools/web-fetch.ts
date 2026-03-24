// KCode - WebFetch Tool
// Fetches URL content and converts HTML to plain text

import type { ToolDefinition, ToolResult } from "../core/types";

export interface WebFetchInput {
  url: string;
  prompt?: string;
}

const MAX_CONTENT_SIZE = 512_000; // 512KB
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_CACHE_ENTRIES = 100;

// ─── SSRF Protection ──────────────────────────────────────────
// Block requests to private/internal networks and cloud metadata endpoints

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
]);

/** Check if an IP address is in a private/reserved range */
function isPrivateIP(hostname: string): boolean {
  // IPv4 private ranges
  if (/^127\./.test(hostname)) return true;        // Loopback
  if (/^10\./.test(hostname)) return true;          // Class A private
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true; // Class B private
  if (/^192\.168\./.test(hostname)) return true;    // Class C private
  if (/^169\.254\./.test(hostname)) return true;    // Link-local / AWS metadata
  if (/^0\./.test(hostname)) return true;           // "This" network
  if (hostname === "0.0.0.0") return true;
  // IPv6
  if (hostname === "::1" || hostname === "[::1]") return true;
  if (/^fe80:/i.test(hostname)) return true;          // Link-local IPv6
  if (/^fd/i.test(hostname)) return true;             // Unique local IPv6
  if (/^fc/i.test(hostname)) return true;             // Unique local IPv6
  // IPv4-mapped IPv6 (::ffff:127.0.0.1, ::ffff:10.0.0.1, etc.)
  const v4mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped && isPrivateIP(v4mapped[1]!)) return true;
  return false;
}

/** Validate URL is safe to fetch (no SSRF) */
export function validateFetchUrl(url: string): string | null {
  try {
    const parsed = new URL(url);

    // Only allow HTTP(S)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return `Blocked: unsupported protocol "${parsed.protocol}"`;
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

    // Block known internal hostnames
    if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
      return `Blocked: "${hostname}" is an internal/reserved hostname`;
    }

    // Block private IP addresses
    if (isPrivateIP(hostname)) {
      return `Blocked: "${hostname}" is a private/reserved IP address`;
    }

    // Block cloud metadata endpoints (various providers)
    if (hostname === "169.254.169.254") {
      return "Blocked: cloud metadata endpoint";
    }

    return null; // Safe
  } catch {
    return `Blocked: invalid URL`;
  }
}

interface CacheEntry {
  content: string;
  timestamp: number;
}

const responseCache = new Map<string, CacheEntry>();

export const webFetchDefinition: ToolDefinition = {
  name: "WebFetch",
  description: "Fetch the content of a URL. HTML is converted to plain text. Responses are cached for 15 minutes.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      prompt: {
        type: "string",
        description: "Optional guidance for content extraction (e.g. 'extract the API documentation')",
      },
    },
    required: ["url"],
  },
};

function stripHtmlTags(html: string): string {
  // Remove script and style blocks entirely
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

  // Replace common block elements with newlines
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|pre|hr)[^>]*>/gi, "\n");

  // Replace list items and table cells with meaningful separators
  text = text.replace(/<td[^>]*>/gi, "\t");
  text = text.replace(/<th[^>]*>/gi, "\t");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  // Collapse multiple newlines and trim
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
  text = text.trim();

  return text;
}

export async function executeWebFetch(input: Record<string, unknown>): Promise<ToolResult> {
  let { url } = input as WebFetchInput;
  const { prompt } = input as WebFetchInput;

  // Add protocol if missing (default to HTTPS)
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  // SSRF protection: block private/internal URLs
  const ssrfError = validateFetchUrl(url);
  if (ssrfError) {
    return { tool_use_id: "", content: ssrfError, is_error: true };
  }

  // Check cache
  const cached = responseCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    const output = prompt
      ? `[Cached] URL: ${url}\nExtraction prompt: ${prompt}\n\n${cached.content}`
      : `[Cached] URL: ${url}\n\n${cached.content}`;

    return { tool_use_id: "", content: output };
  }

  try {
    // Manual redirect following with SSRF re-validation on each hop
    let currentUrl = url;
    let response: Response | undefined;
    const MAX_REDIRECTS = 5;

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      response = await fetch(currentUrl, {
        headers: {
          "User-Agent": "KCode/0.1 (AI coding assistant)",
          Accept: "text/html, application/json, text/plain, */*",
        },
        redirect: "manual",  // Don't auto-follow redirects
        signal: AbortSignal.timeout(30_000),
      });

      // Handle redirects manually — re-validate SSRF on each hop
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) break;
        // Resolve relative redirects
        currentUrl = new URL(location, currentUrl).toString();
        const redirectSsrfError = validateFetchUrl(currentUrl);
        if (redirectSsrfError) {
          return { tool_use_id: "", content: `Redirect blocked: ${redirectSsrfError}`, is_error: true };
        }
        continue;
      }
      break;
    }

    if (!response) {
      return { tool_use_id: "", content: `Error: no response from ${url}`, is_error: true };
    }

    if (!response.ok) {
      return {
        tool_use_id: "",
        content: `Error: HTTP ${response.status} ${response.statusText} for ${url}`,
        is_error: true,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    let body = await response.text();

    // Enforce size limit
    if (body.length > MAX_CONTENT_SIZE) {
      body = body.slice(0, MAX_CONTENT_SIZE) + "\n\n[Content truncated at 512KB]";
    }

    // Convert HTML to plain text
    let content: string;
    if (contentType.includes("text/html")) {
      content = stripHtmlTags(body);
    } else {
      content = body;
    }

    // Cache the result
    // Evict expired entries when cache is full
    if (responseCache.size >= MAX_CACHE_ENTRIES) {
      const now = Date.now();
      for (const [k, v] of responseCache) {
        if (now - v.timestamp > CACHE_TTL_MS) responseCache.delete(k);
      }
      // If still full after eviction, drop oldest
      if (responseCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = responseCache.keys().next().value;
        if (oldest) responseCache.delete(oldest);
      }
    }
    responseCache.set(url, { content, timestamp: Date.now() });

    const output = prompt
      ? `URL: ${url}\nExtraction prompt: ${prompt}\n\n${content}`
      : `URL: ${url}\n\n${content}`;

    return { tool_use_id: "", content: output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      tool_use_id: "",
      content: `Error fetching ${url}: ${msg}`,
      is_error: true,
    };
  }
}
