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
  },
  {
    id: "groq",
    name: "Groq",
    envVar: "GROQ_API_KEY",
    settingsKey: "groqApiKey",
    baseUrl: "https://api.groq.com/openai",
    hint: "gsk_...",
    models: "llama-3.3-70b, mixtral-8x7b, gemma2-9b",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    settingsKey: "deepseekApiKey",
    baseUrl: "https://api.deepseek.com",
    hint: "sk-...",
    models: "deepseek-chat, deepseek-reasoner",
  },
  {
    id: "together",
    name: "Together AI",
    envVar: "TOGETHER_API_KEY",
    settingsKey: "togetherApiKey",
    baseUrl: "https://api.together.xyz",
    hint: "tok_...",
    models: "meta-llama/Llama-3.3-70B, Qwen/Qwen2.5-Coder-32B",
  },
];

type Stage = "select" | "auth-method" | "input" | "confirm" | "oauth-pending";

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
    setStage("oauth-pending");
    setOauthError(null);
    setOauthUrl(null);

    const oauthName = OAUTH_PROVIDER_MAP[provider.id] ?? provider.id;

    // For Anthropic: OAuth requires manual code paste which doesn't work in Ink.
    // Open the API key creation page directly instead.
    if (oauthName === "anthropic") {
      const url = "https://console.anthropic.com/settings/keys";
      console.error(`\n  Open this URL to create an Anthropic API key:\n\n  ${url}\n`);
      copyToClipboard(url);
      try {
        const { openBrowser } = await import("../../core/auth/oauth-flow.js");
        await openBrowser(url);
      } catch { /* ok */ }
      setOauthUrl(url);
      // Switch to manual key input after showing the URL
      setStage("input");
      return;
    }

    try {
      const { loginProvider } = await import("../../core/auth/oauth-flow.js");
      const result = await loginProvider(oauthName, {
        onAuthUrl: (url) => {
          setOauthUrl(url);
          console.error(`\n  OAuth URL (copy this):\n\n  ${url}\n`);
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
          setApiKey((prev) => prev + input);
        }
      } else if (stage === "confirm") {
        if (input.toLowerCase() === "y" || key.return) {
          onDone({ provider: selectedProvider!, apiKey: apiKey.trim() });
        } else if (input.toLowerCase() === "n" || key.escape) {
          setStage("input");
        }
      } else if (stage === "oauth-pending") {
        if (key.escape) {
          // Can't cancel the OAuth flow mid-flight, but go back to auth-method
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
                <Box key={p.id} gap={1}>
                  <Text color={isSelected ? theme.primary : undefined} bold={isSelected}>
                    {isSelected ? "▸ " : "  "}
                    {p.name}
                  </Text>
                  {hasKey && <Text color={theme.success}>✓</Text>}
                  {p.supportsOAuth && <Text color={theme.info ?? theme.accent}>OAuth</Text>}
                  {isSelected && <Text dimColor>{p.models}</Text>}
                </Box>
              );
            })}
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
            <Text color={theme.warning}>
              Waiting for browser authentication...
            </Text>
          </Box>
          {oauthUrl && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>The OAuth URL has been printed above this box and copied to clipboard.</Text>
              <Text dimColor>Open it in your browser to authenticate.</Text>
            </Box>
          )}
          {!oauthUrl && (
            <Box>
              <Text dimColor>
                Opening browser for {selectedProvider.name} login...
              </Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>Esc to cancel</Text>
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
