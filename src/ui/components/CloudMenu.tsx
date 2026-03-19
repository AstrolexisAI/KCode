// KCode - CloudMenu component
// Interactive menu for configuring cloud API providers and keys

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../ThemeContext.js";

export interface CloudProvider {
  id: string;
  name: string;
  envVar: string;
  settingsKey: string;
  baseUrl: string;
  hint: string; // example key format
  models: string; // example models
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
  },
  {
    id: "openai",
    name: "OpenAI",
    envVar: "OPENAI_API_KEY",
    settingsKey: "apiKey",
    baseUrl: "https://api.openai.com",
    hint: "sk-proj-...",
    models: "gpt-4o, gpt-4o-mini, o3, o4-mini",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    envVar: "GEMINI_API_KEY",
    settingsKey: "geminiApiKey",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    hint: "AIza...",
    models: "gemini-2.5-pro, gemini-2.5-flash",
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

type Stage = "select" | "input" | "confirm";

export interface CloudResult {
  provider: CloudProvider;
  apiKey: string;
}

interface CloudMenuProps {
  isActive: boolean;
  onDone: (result: CloudResult | null) => void;
}

export default function CloudMenu({ isActive, onDone }: CloudMenuProps) {
  const { theme } = useTheme();
  const [stage, setStage] = useState<Stage>("select");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<CloudProvider | null>(null);

  useInput(
    (input, key) => {
      if (!isActive) return;

      if (stage === "select") {
        if (key.upArrow || input === "k") {
          setSelectedIndex((i) => (i > 0 ? i - 1 : PROVIDERS.length - 1));
        } else if (key.downArrow || input === "j") {
          setSelectedIndex((i) => (i < PROVIDERS.length - 1 ? i + 1 : 0));
        } else if (key.return) {
          setSelectedProvider(PROVIDERS[selectedIndex]!);
          setStage("input");
          setApiKey("");
        } else if (key.escape || input === "q") {
          onDone(null);
        }
      } else if (stage === "input") {
        if (key.escape) {
          setStage("select");
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
                  {isSelected && (
                    <Text dimColor>{p.models}</Text>
                  )}
                </Box>
              );
            })}
          </Box>
        </>
      )}

      {stage === "input" && selectedProvider && (
        <>
          <Box marginTop={1} gap={1}>
            <Text>Provider:</Text>
            <Text bold color={theme.primary}>{selectedProvider.name}</Text>
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
            <Text bold color={theme.primary}>{selectedProvider.name}</Text>
          </Box>
          <Box gap={1}>
            <Text>API Key:</Text>
            <Text color={theme.warning}>{maskKey(apiKey)}</Text>
          </Box>
          <Box marginTop={1} gap={2}>
            <Text>Save to <Text bold>~/.kcode/settings.json</Text>?</Text>
          </Box>
          <Box gap={2}>
            <Text>
              <Text bold color={theme.success}>[y]</Text>
              <Text> Save</Text>
            </Text>
            <Text>
              <Text bold color={theme.error}>[n]</Text>
              <Text> Back</Text>
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
