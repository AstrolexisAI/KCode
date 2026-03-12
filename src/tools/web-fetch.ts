// KCode - WebFetch Tool
// Fetches URL content and converts HTML to plain text

import type { ToolDefinition, ToolResult } from "../core/types";

export interface WebFetchInput {
  url: string;
  prompt?: string;
}

const MAX_CONTENT_SIZE = 512_000; // 512KB
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

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

  // Auto-upgrade HTTP to HTTPS
  if (url.startsWith("http://")) {
    url = url.replace("http://", "https://");
  }

  // Add protocol if missing
  if (!url.startsWith("https://")) {
    url = "https://" + url;
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
    const response = await fetch(url, {
      headers: {
        "User-Agent": "KCode/0.1 (AI coding assistant)",
        Accept: "text/html, application/json, text/plain, */*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });

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
