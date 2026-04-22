// KCode - Conversation Retry Module
// Extracted from conversation.ts — retry logic with exponential backoff and fallback chain

import type { DebugTracer } from "./debug-tracer";
import { log } from "./logger";
import { executeModelRequest, isRateLimitError } from "./request-builder";
import { routeToModel } from "./router";
import type { SSEChunk } from "./sse-parser";
import type { ToolRegistry } from "./tool-registry";
import type { KCodeConfig, Message } from "./types";

// ─── Constants ───────────────────────────────────────────────────

const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8000;
const MIN_RATE_LIMIT_DELAY_MS = 5_000; // Min 5s for rate limits (server Retry-After takes priority)

// Anthropic cloud model cascade for 429 rate limit fallback (largest → smallest)
const ANTHROPIC_RATE_LIMIT_CASCADE: string[] = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

function getAnthropicRateLimitFallbacks(currentModel: string): string[] {
  const lower = currentModel.toLowerCase();
  const idx = ANTHROPIC_RATE_LIMIT_CASCADE.findIndex((m) => lower.includes(m) || m.includes(lower));
  if (idx < 0) return [];
  // Return models smaller than current (further down the cascade)
  return ANTHROPIC_RATE_LIMIT_CASCADE.slice(idx + 1);
}

// ─── Helpers ─────────────────────────────────────────────────────

export function isRetryableError(error: unknown): boolean {
  if (isRateLimitError(error)) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Retry on network errors and common HTTP errors
    if (
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("unable to connect") ||
      msg.includes("timeout") ||
      msg.includes("socket") ||
      msg.includes("429") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503")
    ) {
      return true;
    }
  }
  return false;
}

export function computeRetryDelay(attempt: number): number {
  // Exponential backoff: 0.5s, 1s, 2s, 4s, 8s capped at MAX_RETRY_DELAY_MS
  const baseDelay = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
  // 75-100% jitter
  const jitter = 0.75 + Math.random() * 0.25;
  return Math.round(baseDelay * jitter);
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Stream With Retry ───────────────────────────────────────────

export interface CreateStreamContext {
  config: KCodeConfig;
  systemPrompt: string;
  messages: Message[];
  tools: ToolRegistry;
  maxRetries: number;
  abortController: AbortController | null;
  debugTracer: DebugTracer | null;
  getRecentMessageText: () => string;
  /** Optional: called when waiting for rate limit retry (UI can show countdown) */
  onRetryWait?: (secondsRemaining: number) => void;
}

/**
 * Create a streaming API call with exponential backoff retry.
 * Delegates to executeModelRequest() for the actual request.
 * Tries auto-routing, primary model, fallback, tertiary, and fallback chain.
 */
export async function createStreamWithRetry(
  ctx: CreateStreamContext,
): Promise<AsyncGenerator<SSEChunk>> {
  let lastError: Error | undefined;
  const maxAttempts = Math.max(ctx.maxRetries, 3); // 3 retries for rate limits — cascade sooner
  let burstRetries = 0; // Extra retries for low-utilization burst limits
  const MAX_BURST_RETRIES = 2; // 2 extra burst retries max

  // Restore original model if rate-limit cooldown has expired
  if (ctx.config._rateLimitedModel && ctx.config._rateLimitedUntil) {
    if (Date.now() >= ctx.config._rateLimitedUntil) {
      log.info("llm", `Rate-limit cooldown expired — restoring ${ctx.config._rateLimitedModel}`);
      ctx.config.model = ctx.config._rateLimitedModel;
      ctx.config._rateLimitedModel = undefined;
      ctx.config._rateLimitedUntil = undefined;
    }
  }

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    let effectiveModel = ctx.config.model;
    try {
      if (ctx.config.autoRoute !== false && !ctx.config.modelExplicitlySet) {
        const recentText = ctx.getRecentMessageText();
        effectiveModel = await routeToModel(ctx.config.model, recentText);
        if (ctx.debugTracer?.isEnabled() && effectiveModel !== ctx.config.model) {
          ctx.debugTracer.traceModelSwitch(
            ctx.config.model,
            effectiveModel,
            "Auto-router selected different model based on message content",
          );
        }
      }

      const requestStart = Date.now();
      const stream = await executeModelRequest(
        effectiveModel,
        ctx.config,
        ctx.systemPrompt,
        ctx.messages,
        ctx.tools,
        ctx.abortController,
      );
      log.debug("llm", `Stream opened in ${Date.now() - requestStart}ms`);
      return stream;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // If the abort signal fired, stop immediately — don't retry or fallback
      if (ctx.abortController?.signal.aborted) {
        throw new Error("The operation was aborted.");
      }

      // If the router sent us to a different model and it failed, fall back to primary
      if (effectiveModel !== ctx.config.model) {
        log.warn(
          "llm",
          `Routed model ${effectiveModel} failed, falling back to primary ${ctx.config.model}`,
        );
        try {
          const stream = await executeModelRequest(
            ctx.config.model,
            ctx.config,
            ctx.systemPrompt,
            ctx.messages,
            ctx.tools,
            ctx.abortController,
          );
          log.info("llm", `Primary model ${ctx.config.model} connected after routed model failure`);
          return stream;
        } catch (primaryErr) {
          log.error(
            "llm",
            `Primary model also failed: ${primaryErr instanceof Error ? primaryErr.message : primaryErr}`,
          );
        }
      }

      // If server explicitly says don't retry (subscription hard limit), skip to cascade
      if (isRateLimitError(error) && error.shouldNotRetry) {
        log.warn(
          "llm",
          `Rate limit with x-should-retry:false — skipping retries, going to cascade`,
        );
        // Fall through to fallback/cascade logic below
      } else

      // Rate limits: 3 retries max before cascading to smaller models
      if (attempt < (isRateLimitError(error) ? Math.max(ctx.maxRetries, 3) : ctx.maxRetries) && isRetryableError(error)) {
        let delay: number;
        if (isRateLimitError(error)) {
          // Use server-provided Retry-After, with a minimum floor
          delay = Math.max(error.retryAfterMs, MIN_RATE_LIMIT_DELAY_MS);
          const secs = Math.ceil(delay / 1000);
          log.warn(
            "llm",
            `Rate limited — retrying in ${secs}s (attempt ${attempt + 1}/${ctx.maxRetries})`,
          );
          // Notify UI with countdown if callback provided
          if (ctx.onRetryWait) {
            for (let s = secs; s > 0; s--) {
              ctx.onRetryWait(s);
              await sleep(1000);
            }
            ctx.onRetryWait(0);
            continue;
          }
        } else {
          delay = computeRetryDelay(attempt);
          log.warn(
            "llm",
            `Retryable error (attempt ${attempt + 1}/${ctx.maxRetries}), retrying in ${delay}ms`,
            lastError,
          );
        }
        await sleep(delay);
        continue;
      }

      // Fallback model
      if (ctx.config.fallbackModel && ctx.config.fallbackModel !== ctx.config.model) {
        log.warn("llm", `Primary model failed, switching to fallback: ${ctx.config.fallbackModel}`);
        if (ctx.debugTracer?.isEnabled()) {
          ctx.debugTracer.traceModelSwitch(
            ctx.config.model,
            ctx.config.fallbackModel,
            `Primary model failed after ${attempt + 1} attempts: ${lastError?.message}`,
          );
        }
        // Resolve the fallback model's apiBase/apiKey so the request goes to the
        // correct provider, not whatever apiBase the primary model was using.
        // Without this, routing that switched apiBase to (e.g.) api.x.ai would
        // leak into the fallback → Anthropic request sent to xAI → format error.
        const fallbackConfig = { ...ctx.config };
        try {
          const { getModelBaseUrl } = await import("./models.js");
          const { listModels } = await import("./models.js");
          const all = await listModels();
          // Fuzzy match: fallback "claude-haiku-4-5" matches "claude-haiku-4-5-20251001"
          const match = all.find((m) =>
            m.name === ctx.config.fallbackModel ||
            m.name.startsWith(ctx.config.fallbackModel + "-")
          );
          if (match) {
            fallbackConfig.apiBase = match.baseUrl;
            const { loadUserSettingsRaw } = await import("./config.js");
            const settings = await loadUserSettingsRaw();
            const url = match.baseUrl.toLowerCase();
            if (url.includes("anthropic.com")) {
              fallbackConfig.apiKey = String(settings.anthropicApiKey ?? settings.apiKey ?? "");
            } else if (url.includes("x.ai")) {
              fallbackConfig.apiKey = String(settings.xaiApiKey ?? "");
            } else if (url.includes("openai.com")) {
              fallbackConfig.apiKey = String(settings.apiKey ?? "");
            } else if (url.includes("moonshot")) {
              fallbackConfig.apiKey = String(settings.kimiApiKey ?? "");
            }
          } else {
            // Model not in registry — trust getModelBaseUrl fallback (uses config.apiBase)
            fallbackConfig.apiBase = await getModelBaseUrl(ctx.config.fallbackModel, undefined);
          }
        } catch (resolveErr) {
          log.debug("llm", `Fallback provider resolution failed: ${resolveErr}`);
        }
        try {
          const stream = await executeModelRequest(
            ctx.config.fallbackModel,
            fallbackConfig,
            ctx.systemPrompt,
            ctx.messages,
            ctx.tools,
            ctx.abortController,
          );
          log.info("llm", `Fallback model ${ctx.config.fallbackModel} connected`);
          ctx.config._activeFallback = ctx.config.fallbackModel;
          // If fallback was triggered by rate limit, switch the active model for the
          // rest of the session to avoid re-hitting the rate limit on every turn
          if (isRateLimitError(error)) {
            ctx.config._rateLimitedModel = ctx.config.model;
            ctx.config._rateLimitedUntil = Date.now() + 5 * 60 * 1000; // 5 min cooldown
            ctx.config.model = ctx.config.fallbackModel;
            log.warn("llm", `Rate-limited model ${ctx.config._rateLimitedModel} parked for 5 min — using ${ctx.config.model}`);
          }
          return stream;
        } catch (fallbackErr) {
          log.error(
            "llm",
            `Fallback model also failed: ${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`,
          );
        }
      }

      // Tertiary model
      if (
        ctx.config.tertiaryModel &&
        ctx.config.tertiaryModel !== ctx.config.model &&
        ctx.config.tertiaryModel !== ctx.config.fallbackModel
      ) {
        log.warn(
          "llm",
          `Primary + fallback failed, trying tertiary model: ${ctx.config.tertiaryModel}`,
        );
        try {
          const stream = await executeModelRequest(
            ctx.config.tertiaryModel,
            ctx.config,
            ctx.systemPrompt,
            ctx.messages,
            ctx.tools,
            ctx.abortController,
            {
              maxTokens: Math.min(ctx.config.maxTokens, 4096),
              includeTools: false,
            },
          );
          log.info("llm", `Tertiary model ${ctx.config.tertiaryModel} connected (no tools)`);
          return stream;
        } catch (tertiaryErr) {
          log.error(
            "llm",
            `Tertiary model also failed: ${tertiaryErr instanceof Error ? tertiaryErr.message : tertiaryErr}`,
          );
        }
      }

      // Fallback chain
      if (ctx.config.fallbackModels && ctx.config.fallbackModels.length > 0) {
        const triedModels = new Set(
          [ctx.config.model, ctx.config.fallbackModel, ctx.config.tertiaryModel].filter(Boolean),
        );
        for (const chainModel of ctx.config.fallbackModels) {
          if (triedModels.has(chainModel)) continue;
          triedModels.add(chainModel);
          log.warn("llm", `Falling back to model: ${chainModel}`);
          try {
            const stream = await executeModelRequest(
              chainModel,
              ctx.config,
              ctx.systemPrompt,
              ctx.messages,
              ctx.tools,
              ctx.abortController,
            );
            log.info("llm", `Fallback chain model ${chainModel} connected`);
            return stream;
          } catch (chainErr) {
            log.error(
              "llm",
              `Fallback chain model ${chainModel} failed: ${chainErr instanceof Error ? chainErr.message : chainErr}`,
            );
          }
        }
      }

      // Auto-cascade to smaller Anthropic models on rate limit exhaustion
      // Only cascade if utilization is high (>80%) — low utilization means it's a
      // temporary burst limit that will resolve with more retries on the same model
      if (isRateLimitError(error)) {
        const utilization = error.fiveHourUtilization;
        const isHighUtilization = utilization === undefined || utilization > 0.8;
        const isAnthropicCloud =
          ctx.config.model.toLowerCase().startsWith("claude-") ||
          ctx.config.apiBase?.includes("anthropic.com");

        if (isAnthropicCloud && !isHighUtilization && burstRetries < MAX_BURST_RETRIES) {
          // Low utilization burst limit — honor server's Retry-After (typically 1-5s)
          // Don't consume an attempt slot: decrement so the for-loop increment nets to zero
          burstRetries++;
          attempt--;
          const burstDelay = Math.max(error.retryAfterMs, MIN_RATE_LIMIT_DELAY_MS);
          const burstSecs = Math.ceil(burstDelay / 1000);
          log.warn(
            "llm",
            `Rate limit on ${ctx.config.model} but utilization is only ${Math.round((utilization ?? 0) * 100)}% — burst retry ${burstRetries}/${MAX_BURST_RETRIES} in ${burstSecs}s`,
          );
          if (ctx.onRetryWait) {
            for (let s = burstSecs; s > 0; s--) {
              ctx.onRetryWait(s);
              await sleep(1000);
            }
            ctx.onRetryWait(0);
          } else {
            await sleep(burstDelay);
          }
          continue;
        }

        if (isAnthropicCloud && isHighUtilization) {
          const cascadeFallbacks = getAnthropicRateLimitFallbacks(ctx.config.model);
          const triedModels = new Set(
            [
              ctx.config.model,
              ctx.config.fallbackModel,
              ctx.config.tertiaryModel,
              ...(ctx.config.fallbackModels ?? []),
            ].filter(Boolean),
          );
          for (const cascadeModel of cascadeFallbacks) {
            if (triedModels.has(cascadeModel)) continue;
            triedModels.add(cascadeModel);
            const pct = utilization !== undefined ? ` (${Math.round(utilization * 100)}% used)` : "";
            log.warn(
              "llm",
              `Rate limit exhausted on ${ctx.config.model}${pct} — auto-cascading to ${cascadeModel}`,
            );
            if (ctx.debugTracer?.isEnabled()) {
              ctx.debugTracer.traceModelSwitch(
                ctx.config.model,
                cascadeModel,
                `Rate limit exhausted after ${attempt + 1} attempts${pct}, auto-cascading to smaller model`,
              );
            }
            try {
              // Wait a bit before trying the smaller model
              await sleep(MIN_RATE_LIMIT_DELAY_MS);
              const stream = await executeModelRequest(
                cascadeModel,
                ctx.config,
                ctx.systemPrompt,
                ctx.messages,
                ctx.tools,
                ctx.abortController,
              );
              log.info("llm", `Rate-limit cascade model ${cascadeModel} connected`);
              ctx.config._activeFallback = cascadeModel;
              return stream;
            } catch (cascadeErr) {
              log.error(
                "llm",
                `Cascade model ${cascadeModel} also failed: ${cascadeErr instanceof Error ? cascadeErr.message : cascadeErr}`,
              );
            }
          }
        }
      }

      log.error("llm", `Request failed: ${lastError.message}`, lastError);
      throw lastError;
    }
  }

  throw lastError ?? new Error("Unexpected retry exhaustion");
}
