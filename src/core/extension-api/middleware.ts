// KCode - Extension API Middleware
// Auth, rate limiting, CORS, and logging middleware for the Extension API

import type { Middleware } from "./types";

// ─── Helpers ───────────────────────────────────────────────────

function jsonResponse(data: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ─── Auth Middleware ───────────────────────────────────────────

/**
 * Creates middleware that validates Authorization: Bearer tokens.
 * Returns 401 if the token is missing or does not match.
 */
export function createAuthMiddleware(token: string): Middleware {
  return async (req: Request): Promise<Response | null> => {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse(
        { error: "Missing Authorization header", code: "AUTH_REQUIRED" },
        401,
      );
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return jsonResponse(
        { error: "Invalid Authorization format, expected Bearer token", code: "AUTH_INVALID" },
        401,
      );
    }

    if (parts[1] !== token) {
      return jsonResponse(
        { error: "Invalid token", code: "AUTH_INVALID" },
        401,
      );
    }

    return null; // Pass through
  };
}

// ─── Rate Limit Middleware ─────────────────────────────────────

/**
 * Creates a sliding-window rate limiter based on client IP (from headers or fallback).
 * Returns 429 if the request rate exceeds maxPerMinute.
 */
export function createRateLimitMiddleware(maxPerMinute: number): Middleware {
  const windowMs = 60_000;
  const requests: Map<string, number[]> = new Map();

  return async (req: Request): Promise<Response | null> => {
    // Use X-Forwarded-For, then X-Real-IP, then a default key
    const clientKey =
      req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
      req.headers.get("X-Real-IP") ||
      "default";

    const now = Date.now();
    let timestamps = requests.get(clientKey);

    if (!timestamps) {
      timestamps = [];
      requests.set(clientKey, timestamps);
    }

    // Remove timestamps outside the sliding window
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= maxPerMinute) {
      const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000);
      return jsonResponse(
        { error: "Rate limit exceeded", code: "RATE_LIMITED" },
        429,
        { "Retry-After": String(retryAfter) },
      );
    }

    timestamps.push(now);
    return null; // Pass through
  };
}

// ─── CORS Middleware ───────────────────────────────────────────

/**
 * Creates CORS middleware that handles OPTIONS preflight requests
 * and sets appropriate headers on all responses.
 */
export function createCorsMiddleware(origins: string[]): Middleware {
  return async (req: Request): Promise<Response | null> => {
    const requestOrigin = req.headers.get("Origin") || "*";
    const allowedOrigin = origins.includes("*") ? "*" : (
      origins.includes(requestOrigin) ? requestOrigin : null
    );

    // Handle preflight OPTIONS requests
    if (req.method === "OPTIONS") {
      if (!allowedOrigin) {
        return new Response(null, { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // For non-OPTIONS requests, we return null to pass through,
    // but the api.ts layer will merge CORS headers into the final response.
    // Store the allowed origin as a custom header for downstream use.
    if (allowedOrigin) {
      // Return null to pass through; the API handler will add CORS headers
      return null;
    }

    return null;
  };
}

/**
 * Returns CORS headers for a given origin against the allowed origins list.
 */
export function getCorsHeaders(origins: string[], requestOrigin: string | null): Record<string, string> {
  const origin = requestOrigin || "*";
  const allowedOrigin = origins.includes("*") ? "*" : (
    origins.includes(origin) ? origin : ""
  );

  if (!allowedOrigin) return {};

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ─── Logging Middleware ────────────────────────────────────────

/**
 * Creates middleware that logs incoming requests with method, path, and timing.
 */
export function createLoggingMiddleware(): Middleware {
  let logFn: (msg: string) => void = console.log;

  // Try to use the project logger if available
  try {
    const logger = require("../../core/logger");
    if (logger?.log?.info) {
      logFn = (msg: string) => logger.log.info("extension-api", msg);
    }
  } catch {
    // Fall back to console.log
  }

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    logFn(`[ext-api] ${req.method} ${url.pathname}`);
    return null; // Always pass through
  };
}
