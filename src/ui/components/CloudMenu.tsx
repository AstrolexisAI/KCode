// KCode - CloudMenu component
// Interactive menu for configuring cloud API providers and keys

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { useTheme } from "../ThemeContext.js";

export interface CloudProvider {
  id: string;
  name: string;
  envVar: string;
  settingsKey: string;
  baseUrl: string;
  hint: string; // example key format
  models: string; // example models
  supportsOAuth?: boolean;
  /**
   * Short pricing summary shown next to the provider in the /cloud menu.
   * Format: "$INPUT / $OUTPUT per 1M (cheapest: $X / $Y)"
   * Prices are USD per 1M tokens. Fetched from each provider's public
   * pricing page as of 2026 — check the /stats command for live per-
   * session costs and ~/.kcode/pricing.json for overrides.
   */
  pricing: {
    flagship: { name: string; input: number; output: number };
    cheapest: { name: string; input: number; output: number };
  };
}

const PROVIDERS: CloudProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    settingsKey: "anthropicApiKey",
    baseUrl: "https://api.anthropic.com",
    hint: "sk-ant-api03-...",
    models: "claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5",
    supportsOAuth: true,
    pricing: {
      flagship: { name: "claude-opus-4-6", input: 15, output: 75 },
      cheapest: { name: "claude-haiku-4-5", input: 0.8, output: 4 },
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    envVar: "OPENAI_API_KEY",
    settingsKey: "apiKey",
    baseUrl: "https://api.openai.com",
    hint: "sk-proj-...",
    models: "gpt-4o, gpt-4o-mini, o3, o4-mini",
    supportsOAuth: true,
    pricing: {
      flagship: { name: "o3", input: 10, output: 40 },
      cheapest: { name: "gpt-4o-mini", input: 0.15, output: 0.6 },
    },
  },
  {
    id: "gemini",
    name: "Google Gemini",
    envVar: "GEMINI_API_KEY",
    settingsKey: "geminiApiKey",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    hint: "AIza...",
    models: "gemini-2.5-pro, gemini-2.5-flash",
    supportsOAuth: true,
    pricing: {
      flagship: { name: "gemini-2.5-pro", input: 1.25, output: 10 },
      cheapest: { name: "gemini-2.5-flash", input: 0.15, output: 0.6 },
    },
  },
  {
    id: "groq",
    name: "Groq",
    envVar: "GROQ_API_KEY",
    settingsKey: "groqApiKey",
    baseUrl: "https://api.groq.com/openai",
    hint: "gsk_...",
    models: "llama-3.3-70b, mixtral-8x7b, gemma2-9b",
    pricing: {
      flagship: { name: "llama-3.3-70b", input: 0.59, output: 0.79 },
      cheapest: { name: "gemma2-9b", input: 0.2, output: 0.2 },
    },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    settingsKey: "deepseekApiKey",
    baseUrl: "https://api.deepseek.com",
    hint: "sk-...",
    models: "deepseek-chat, deepseek-reasoner",
    pricing: {
      flagship: { name: "deepseek-reasoner", input: 0.55, output: 2.19 },
      cheapest: { name: "deepseek-chat", input: 0.27, output: 1.1 },
    },
  },
  {
    id: "together",
    name: "Together AI",
    envVar: "TOGETHER_API_KEY",
    settingsKey: "togetherApiKey",
    baseUrl: "https://api.together.xyz",
    hint: "tok_...",
    models: "meta-llama/Llama-3.3-70B, Qwen/Qwen2.5-Coder-32B",
    pricing: {
      flagship: { name: "Llama-3.3-70B", input: 0.88, output: 0.88 },
      cheapest: { name: "Qwen2.5-Coder-32B", input: 0.8, output: 0.8 },
    },
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    envVar: "XAI_API_KEY",
    settingsKey: "xaiApiKey",
    baseUrl: "https://api.x.ai/v1",
    hint: "xai-...",
    // First model in the list becomes the active model after /cloud.
    // grok-4.20-0309-reasoning is the user's preferred default — it's
    // the current flagship reasoning model ($2/$6 per 1M tokens, text+image).
    // Aliases (grok-4.20, grok-4.20-reasoning, grok-4.20-latest) all resolve
    // to the same model, so any of them work in /model commands.
    models: "grok-4.20-0309-reasoning, grok-code-fast-1, grok-4-fast-reasoning, grok-4, grok-3-mini",
    pricing: {
      flagship: { name: "grok-4.20-reasoning", input: 2, output: 6 },
      cheapest: { name: "grok-code-fast-1", input: 0.2, output: 1.5 },
    },
  },
];

/**
 * Render a provider's price range as a short string like
 * "$0.20–$15 in / $1.50–$75 out per 1M".
 */
function formatPricing(p: CloudProvider["pricing"]): string {
  const fmt = (n: number): string => (n < 1 ? `$${n.toFixed(2)}` : `$${n}`);
  const inLo = Math.min(p.cheapest.input, p.flagship.input);
  const inHi = Math.max(p.cheapest.input, p.flagship.input);
  const outLo = Math.min(p.cheapest.output, p.flagship.output);
  const outHi = Math.max(p.cheapest.output, p.flagship.output);
  const inRange = inLo === inHi ? fmt(inLo) : `${fmt(inLo)}–${fmt(inHi)}`;
  const outRange = outLo === outHi ? fmt(outLo) : `${fmt(outLo)}–${fmt(outHi)}`;
  return `${inRange} in / ${outRange} out per 1M`;
}

type Stage = "select" | "auth-method" | "input" | "confirm" | "oauth-pending" | "cli-detected";

export interface CloudResult {
  provider: CloudProvider;
  apiKey: string;
  /** Whether the key was obtained via OAuth (for display purposes) */
  viaOAuth?: boolean;
}

interface CloudMenuProps {
  isActive: boolean;
  onDone: (result: CloudResult | null) => void;
}

export default function CloudMenu({ isActive, onDone }: CloudMenuProps) {
  const { theme } = useTheme();
  const [stage, setStage] = useState<Stage>("select");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [authMethodIndex, setAuthMethodIndex] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<CloudProvider | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [cliDetail, setCliDetail] = useState<string | null>(null);

  // Map CloudMenu provider IDs to OAuth provider names
  const OAUTH_PROVIDER_MAP: Record<string, string> = {
    anthropic: "anthropic",
    openai: "openai-codex",
    gemini: "gemini",
  };

  const copyToClipboard = (text: string) => {
    try {
      const { execSync } = require("node:child_process");
      if (process.platform === "darwin") {
        execSync("pbcopy", { input: text, timeout: 3000 });
      } else if (process.platform === "linux") {
        try {
          execSync("xclip -selection clipboard", { input: text, timeout: 3000 });
        } catch {
          execSync("xsel --clipboard --input", { input: text, timeout: 3000 });
        }
      }
    } catch {
      // Clipboard not available
    }
  };

  const startOAuthFlow = async (provider: CloudProvider) => {
    // Set stage immediately (sync) to prevent Ink rendering a stale frame
    setStage("oauth-pending");
    setOauthError(null);
    setOauthUrl(null);
    setCliDetail(null);

    const oauthName = OAUTH_PROVIDER_MAP[provider.id] ?? provider.id;

    // Check if user already has CLI auth (Claude Code / Codex)
    try {
      const bridge = await import("../../core/auth/claude-code-bridge.js");
      if (oauthName === "anthropic" && bridge.isClaudeCodeAuthenticated()) {
        const info = bridge.getClaudeCodeAuthInfo();
        setCliDetail(`Claude Code (${info.subscriptionType ?? "active"} plan)`);
        setStage("cli-detected");
        return;
      }
      if (oauthName === "openai-codex" && bridge.isCodexAuthenticated()) {
        const info = bridge.getCodexAuthInfo();
        setCliDetail(
          `OpenAI Codex CLI (${info.authMode === "chatgpt" ? "ChatGPT subscription" : "authenticated"})`,
        );
        setStage("cli-detected");
        return;
      }
    } catch {
      /* bridge not available */
    }

    setStage("oauth-pending");

    // For Anthropic without CLI: open API key page
    if (oauthName === "anthropic") {
      const url = "https://console.anthropic.com/settings/keys";
      copyToClipboard(url);
      try {
        const { openBrowser } = await import("../../core/auth/oauth-flow.js");
        await openBrowser(url);
      } catch {
        /* ok */
      }
      setOauthUrl(url);
      setStage("input");
      return;
    }

    try {
      const { loginProvider } = await import("../../core/auth/oauth-flow.js");
      const result = await loginProvider(oauthName, {
        onAuthUrl: (url) => {
          setOauthUrl(url);
          copyToClipboard(url);
        },
      });
      if (result.method === "api_key" && result.key) {
        onDone({ provider, apiKey: result.key, viaOAuth: true });
      } else {
        onDone({ provider, apiKey: "", viaOAuth: true });
      }
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : String(err));
      setStage("auth-method");
    }
  };

  useInput(
    (input, key) => {
      if (!isActive) return;

      if (stage === "select") {
        if (key.upArrow || input === "k") {
          setSelectedIndex((i) => (i > 0 ? i - 1 : PROVIDERS.length - 1));
        } else if (key.downArrow || input === "j") {
          setSelectedIndex((i) => (i < PROVIDERS.length - 1 ? i + 1 : 0));
        } else if (key.return) {
          const provider = PROVIDERS[selectedIndex]!;
          setSelectedProvider(provider);
          if (provider.supportsOAuth) {
            setStage("auth-method");
            setAuthMethodIndex(0);
          } else {
            setStage("input");
          }
          setApiKey("");
        } else if (key.escape || input === "q") {
          onDone(null);
        }
      } else if (stage === "auth-method") {
        if (key.upArrow || input === "k") {
          setAuthMethodIndex((i) => (i > 0 ? i - 1 : 1));
        } else if (key.downArrow || input === "j") {
          setAuthMethodIndex((i) => (i < 1 ? i + 1 : 0));
        } else if (key.return) {
          if (authMethodIndex === 0) {
            // OAuth login
            startOAuthFlow(selectedProvider!);
          } else {
            // Manual API key
            setStage("input");
          }
        } else if (key.escape) {
          setStage("select");
          setOauthError(null);
        }
      } else if (stage === "input") {
        if (key.escape) {
          if (selectedProvider?.supportsOAuth) {
            setStage("auth-method");
          } else {
            setStage("select");
          }
          setApiKey("");
        } else if (key.return) {
          if (apiKey.trim().length > 0) {
            setStage("confirm");
          }
        } else if (key.backspace || key.delete) {
          setApiKey((prev) => prev.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          // Strip bracketed-paste markers that some terminals inject
          // around pasted content (\x1b[200~ ... \x1b[201~). Without
          // this, pasted API keys end up as "[200~xai-KEY[201~" with
          // the markers embedded literally in the string.
          //
          // Also strip any other ESC-sequence residue and non-printable
          // control characters, since API keys are plain ASCII.
          const cleaned = input
            .replace(/\u001b\[200~/g, "")
            .replace(/\u001b\[201~/g, "")
            .replace(/\[200~/g, "")
            .replace(/\[201~/g, "")
            // Drop any remaining control chars except tab (just in case)
            .replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, "");
          if (cleaned) {
            setApiKey((prev) => prev + cleaned);
          }
        }
      } else if (stage === "confirm") {
        if (input.toLowerCase() === "y" || key.return) {
          // Final safety strip in case any bracketed-paste marker
          // survived the input stage (shouldn't happen, but cheap).
          const finalKey = apiKey
            .replace(/\u001b\[20[01]~/g, "")
            .replace(/\[20[01]~/g, "")
            .trim();
          onDone({ provider: selectedProvider!, apiKey: finalKey });
        } else if (input.toLowerCase() === "n" || key.escape) {
          setStage("input");
        }
      } else if (stage === "oauth-pending") {
        if (key.escape) {
          setStage("auth-method");
        }
      } else if (stage === "cli-detected") {
        if (input.toLowerCase() === "y" || key.return) {
          // Use existing CLI tokens — signal success with empty key
          onDone({ provider: selectedProvider!, apiKey: "", viaOAuth: true });
        } else if (input.toLowerCase() === "n" || key.escape) {
          setStage("auth-method");
        }
      }
    },
    { isActive },
  );

  const maskKey = (k: string): string => {
    if (k.length <= 8) return "*".repeat(k.length);
    return k.slice(0, 4) + "*".repeat(k.length - 8) + k.slice(-4);
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      marginY={0}
    >
      <Text bold color={theme.primary}>
        {"☁  Cloud Provider Setup"}
      </Text>

      {stage === "select" && (
        <>
          <Box marginTop={1}>
            <Text dimColor>Select a provider with arrow keys, Enter to confirm, Esc to cancel</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {PROVIDERS.map((p, i) => {
              const isSelected = i === selectedIndex;
              const currentKey = process.env[p.envVar];
              const hasKey = !!currentKey;
              return (
                <Box key={p.id} flexDirection="column">
                  <Box gap={1}>
                    <Text color={isSelected ? theme.primary : undefined} bold={isSelected}>
                      {isSelected ? "▸ " : "  "}
                      {p.name}
                    </Text>
                    {hasKey && <Text color={theme.success}>✓</Text>}
                    {p.supportsOAuth && <Text color={theme.info ?? theme.accent}>OAuth</Text>}
                    <Text dimColor>{formatPricing(p.pricing)}</Text>
                  </Box>
                  {isSelected && (
                    <>
                      <Box paddingLeft={4}>
                        <Text dimColor>Models: {p.models}</Text>
                      </Box>
                      <Box paddingLeft={4}>
                        <Text dimColor>
                          {"Flagship: "}
                          {p.pricing.flagship.name}
                          {" — $"}
                          {p.pricing.flagship.input}
                          {"/$"}
                          {p.pricing.flagship.output}
                          {" per 1M tokens"}
                        </Text>
                      </Box>
                      <Box paddingLeft={4}>
                        <Text dimColor>
                          {"Cheapest: "}
                          {p.pricing.cheapest.name}
                          {" — $"}
                          {p.pricing.cheapest.input}
                          {"/$"}
                          {p.pricing.cheapest.output}
                          {" per 1M tokens"}
                        </Text>
                      </Box>
                    </>
                  )}
                </Box>
              );
            })}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              Prices are USD per 1M tokens (input / output). Use /stats for live session costs.
            </Text>
          </Box>
        </>
      )}

      {stage === "auth-method" && selectedProvider && (
        <>
          <Box marginTop={1} gap={1}>
            <Text>Provider:</Text>
            <Text bold color={theme.primary}>
              {selectedProvider.name}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Choose authentication method:</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Box gap={1}>
              <Text
                color={authMethodIndex === 0 ? theme.primary : undefined}
                bold={authMethodIndex === 0}
              >
                {authMethodIndex === 0 ? "▸ " : "  "}
                Login with browser (OAuth)
              </Text>
              <Text dimColor>— sign in via browser</Text>
            </Box>
            <Box gap={1}>
              <Text
                color={authMethodIndex === 1 ? theme.primary : undefined}
                bold={authMethodIndex === 1}
              >
                {authMethodIndex === 1 ? "▸ " : "  "}
                Paste API key manually
              </Text>
              <Text dimColor>— {selectedProvider.hint}</Text>
            </Box>
          </Box>
          {oauthError && (
            <Box marginTop={1}>
              <Text color={theme.error}>OAuth error: {oauthError}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>Enter to select, Esc to go back</Text>
          </Box>
        </>
      )}

      {stage === "oauth-pending" && selectedProvider && (
        <>
          <Box marginTop={1} gap={1}>
            <Text>Provider:</Text>
            <Text bold color={theme.primary}>
              {selectedProvider.name}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.warning}>Waiting for browser authentication...</Text>
          </Box>
          {oauthUrl && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Open this URL in your browser (copied to clipboard):</Text>
              <Text> </Text>
              <Text color={theme.info ?? theme.accent} wrap="wrap">
                {oauthUrl}
              </Text>
            </Box>
          )}
          {!oauthUrl && (
            <Box>
              <Text dimColor>Opening browser for {selectedProvider.name} login...</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>Esc to cancel</Text>
          </Box>
        </>
      )}

      {stage === "cli-detected" && selectedProvider && (
        <>
          <Box marginTop={1} gap={1}>
            <Text>Provider:</Text>
            <Text bold color={theme.primary}>
              {selectedProvider.name}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.success}>Existing authentication detected: {cliDetail}</Text>
          </Box>
          <Box marginTop={1}>
            <Text>KCode will reuse this login automatically. No API key needed.</Text>
          </Box>
          <Box marginTop={1} gap={2}>
            <Text>
              <Text bold color={theme.success}>
                [y]
              </Text>
              <Text> Use existing login</Text>
            </Text>
            <Text>
              <Text bold color={theme.error}>
                [n]
              </Text>
              <Text> Configure manually</Text>
            </Text>
          </Box>
        </>
      )}

      {stage === "input" && selectedProvider && (
        <>
          <Box marginTop={1} gap={1}>
            <Text>Provider:</Text>
            <Text bold color={theme.primary}>
              {selectedProvider.name}
            </Text>
          </Box>
          <Box gap={1}>
            <Text>Base URL:</Text>
            <Text dimColor>{selectedProvider.baseUrl}</Text>
          </Box>
          <Box gap={1}>
            <Text>Format:</Text>
            <Text dimColor>{selectedProvider.hint}</Text>
          </Box>
          <Box gap={1}>
            <Text>Pricing:</Text>
            <Text dimColor>{formatPricing(selectedProvider.pricing)}</Text>
          </Box>
          <Box marginTop={1} gap={1}>
            <Text bold>API Key: </Text>
            <Text color={theme.warning}>
              {apiKey.length > 0 ? maskKey(apiKey) : ""}
              <Text color={theme.primary}>▌</Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Paste your API key and press Enter. Esc to go back.</Text>
          </Box>
        </>
      )}

      {stage === "confirm" && selectedProvider && (
        <>
          <Box marginTop={1} gap={1}>
            <Text>Provider:</Text>
            <Text bold color={theme.primary}>
              {selectedProvider.name}
            </Text>
          </Box>
          <Box gap={1}>
            <Text>API Key:</Text>
            <Text color={theme.warning}>{maskKey(apiKey)}</Text>
          </Box>
          <Box marginTop={1} gap={2}>
            <Text>
              Save to <Text bold>~/.kcode/settings.json</Text>?
            </Text>
          </Box>
          <Box gap={2}>
            <Text>
              <Text bold color={theme.success}>
                [y]
              </Text>
              <Text> Save</Text>
            </Text>
            <Text>
              <Text bold color={theme.error}>
                [n]
              </Text>
              <Text> Back</Text>
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
