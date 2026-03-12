// KCode - Main Ink application component
// Top-level component managing conversation flow and rendering

import React, { useState, useCallback } from "react";
import { Box, useInput, useApp } from "ink";
import type { ConversationManager } from "../core/conversation.js";
import type { KCodeConfig, StreamEvent } from "../core/types.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import { SkillManager } from "../core/skills.js";

import Header from "./components/Header.js";
import MessageList, { type MessageEntry } from "./components/MessageList.js";
import InputPrompt from "./components/InputPrompt.js";
import PermissionDialog, {
  type PermissionRequest,
  type PermissionChoice,
} from "./components/PermissionDialog.js";

interface AppProps {
  config: KCodeConfig;
  conversationManager: ConversationManager;
  tools: ToolRegistry;
}

type AppMode = "input" | "responding" | "permission";

export default function App({ config, conversationManager, tools }: AppProps) {
  const { exit } = useApp();

  // Skills manager - created once per component instance
  const [skillManager] = useState(() => {
    const sm = new SkillManager(config.workingDirectory);
    sm.load();
    return sm;
  });

  const [mode, setMode] = useState<AppMode>("input");
  const [completed, setCompleted] = useState<MessageEntry[]>([
    {
      kind: "banner",
      title: "KCode v0.1.0",
      subtitle: "Kulvex Code by Astrolexis",
    },
  ]);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [tokenCount, setTokenCount] = useState(0);
  const [toolUseCount, setToolUseCount] = useState(0);

  // Permission dialog state
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [permissionResolver, setPermissionResolver] = useState<
    ((choice: PermissionChoice) => void) | null
  >(null);

  // Wire up the permission prompt callback so PermissionManager can ask the user
  useState(() => {
    conversationManager.getPermissions().setPromptFn(async (req) => {
      return new Promise<{ granted: boolean; alwaysAllow?: boolean }>((resolve) => {
        setPermissionRequest({
          toolName: req.toolName,
          description: req.summary,
        });
        setMode("permission");
        setPermissionResolver(() => (choice: PermissionChoice) => {
          resolve({
            granted: choice === "allow" || choice === "allow_always",
            alwaysAllow: choice === "allow_always",
          });
        });
      });
    });
  });

  // Global keybindings
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
  });

  const handleSubmit = useCallback(
    async (userInput: string) => {
      // Built-in exit commands
      const lower = userInput.toLowerCase().trim();
      if (
        lower === "/exit" || lower === "/quit" || lower === "/bye" ||
        lower === "exit" || lower === "quit" || lower === "bye"
      ) {
        exit();
        return;
      }

      if (userInput === "/status") {
        const state = conversationManager.getState();
        const usage = conversationManager.getUsage();
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: userInput },
          {
            kind: "text",
            role: "assistant",
            text: `  Messages: ${state.messages.length}\n  Tokens: ${usage.inputTokens + usage.outputTokens} (in: ${usage.inputTokens}, out: ${usage.outputTokens})\n  Tool uses: ${state.toolUseCount}`,
          },
        ]);
        return;
      }

      // Slash command handling via SkillManager
      if (userInput.startsWith("/")) {
        const skillMatch = skillManager.match(userInput);
        if (skillMatch) {
          const expanded = skillManager.expand(skillMatch);

          // Built-in help is handled locally (no LLM call)
          if (expanded.isHelp) {
            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "user", text: userInput },
              {
                kind: "text",
                role: "assistant",
                text: skillManager.formatHelp(tools.getToolNames()),
              },
            ]);
            return;
          }

          // Show the slash command as user message, then send expanded prompt to LLM
          setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
          setMode("responding");
          setStreamingText("");
          setLoadingMessage("Thinking...");

          try {
            const events = conversationManager.sendMessage(expanded.prompt);
            await processEvents(events);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "assistant", text: `\n  Error: ${msg}\n` },
            ]);
          }

          setMode("input");
          setStreamingText("");
          setStreamingThinking("");
          setIsThinking(false);
          setLoadingMessage("");
          const state = conversationManager.getState();
          setTokenCount(state.tokenCount);
          setToolUseCount(state.toolUseCount);
          return;
        }

        // Unknown slash command
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: userInput },
          {
            kind: "text",
            role: "assistant",
            text: `\n  Unknown command: ${userInput}. Type /help for available commands.\n`,
          },
        ]);
        return;
      }

      // Add user message to display
      setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);

      // Start response
      setMode("responding");
      setStreamingText("");
      setLoadingMessage("Thinking...");

      try {
        const events = conversationManager.sendMessage(userInput);
        await processEvents(events);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "assistant", text: `\n  Error: ${msg}\n` },
        ]);
      }

      setMode("input");
      setStreamingText("");
      setStreamingThinking("");
      setIsThinking(false);
      setLoadingMessage("");

      // Update stats
      const state = conversationManager.getState();
      setTokenCount(state.tokenCount);
      setToolUseCount(state.toolUseCount);
    },
    [conversationManager, tools, skillManager, exit],
  );

  const processEvents = useCallback(
    async (events: AsyncGenerator<StreamEvent>) => {
      let currentText = "";
      let currentThinking = "";

      for await (const event of events) {
        switch (event.type) {
          case "turn_start":
            setLoadingMessage("");
            break;

          case "text_delta":
            // Finalize any accumulated thinking when text starts
            if (currentThinking.length > 0) {
              const thinking = currentThinking;
              setIsThinking(false);
              setStreamingThinking("");
              setCompleted((prev) => [
                ...prev,
                { kind: "thinking", text: thinking },
              ]);
              currentThinking = "";
            }
            currentText += event.text;
            setStreamingText(currentText);
            break;

          case "thinking_delta":
            currentThinking += event.thinking;
            setIsThinking(true);
            setStreamingThinking(currentThinking);
            setLoadingMessage("");
            break;

          case "tool_use_start":
            // Finalize any accumulated thinking
            if (currentThinking.length > 0) {
              const thinking = currentThinking;
              setIsThinking(false);
              setStreamingThinking("");
              setCompleted((prev) => [
                ...prev,
                { kind: "thinking", text: thinking },
              ]);
              currentThinking = "";
            }
            // Finalize any accumulated text
            if (currentText.length > 0) {
              const text = currentText;
              setCompleted((prev) => [
                ...prev,
                { kind: "text", role: "assistant", text },
              ]);
              currentText = "";
              setStreamingText("");
            }
            break;

          case "tool_input_delta":
            // Tool input streaming - could show partial JSON; skip for now
            break;

          case "tool_executing": {
            const summary = summarizeInput(event.name, event.input);
            setCompleted((prev) => [
              ...prev,
              { kind: "tool_use", name: event.name, summary },
            ]);
            setLoadingMessage(`Running ${event.name}...`);
            break;
          }

          case "tool_result":
            setCompleted((prev) => [
              ...prev,
              {
                kind: "tool_result",
                name: event.name,
                result: event.result,
                isError: event.isError,
              },
            ]);
            setLoadingMessage("Thinking...");
            break;

          case "usage_update":
            setTokenCount(event.usage.inputTokens + event.usage.outputTokens);
            break;

          case "error":
            setCompleted((prev) => [
              ...prev,
              {
                kind: "text",
                role: "assistant",
                text: `\n  Error: ${event.error.message}${event.retryable ? " (retrying...)" : ""}\n`,
              },
            ]);
            break;

          case "turn_end":
            // Finalize any remaining thinking
            if (currentThinking.length > 0) {
              const thinking = currentThinking;
              setIsThinking(false);
              setStreamingThinking("");
              setCompleted((prev) => [
                ...prev,
                { kind: "thinking", text: thinking },
              ]);
              currentThinking = "";
            }
            // Finalize any remaining streamed text
            if (currentText.length > 0) {
              const text = currentText;
              setCompleted((prev) => [
                ...prev,
                { kind: "text", role: "assistant", text },
              ]);
              currentText = "";
              setStreamingText("");
            }
            break;
        }
      }
    },
    [],
  );

  const handlePermissionChoice = useCallback(
    (choice: PermissionChoice) => {
      if (permissionResolver) {
        permissionResolver(choice);
        setPermissionRequest(null);
        setPermissionResolver(null);
        setMode("responding");
      }
    },
    [permissionResolver],
  );

  return (
    <Box flexDirection="column">
      <MessageList
        completed={completed}
        streamingText={streamingText}
        isLoading={mode === "responding"}
        loadingMessage={loadingMessage}
        streamingThinking={streamingThinking}
        isThinking={isThinking}
      />

      {mode === "permission" && permissionRequest && (
        <PermissionDialog
          request={permissionRequest}
          onChoice={handlePermissionChoice}
          isActive={mode === "permission"}
        />
      )}

      <InputPrompt
        onSubmit={handleSubmit}
        isActive={mode === "input"}
        model={config.model}
        cwd={config.workingDirectory}
      />
    </Box>
  );
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return String(input.command ?? "").slice(0, 80);
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path ?? "");
    case "Glob":
      return String(input.pattern ?? "");
    case "Grep":
      return String(input.pattern ?? "");
    case "Agent":
      return String(input.description ?? "");
    case "WebFetch":
      return String(input.url ?? "").slice(0, 60);
    case "WebSearch":
      return String(input.query ?? "").slice(0, 60);
    default:
      return "";
  }
}
