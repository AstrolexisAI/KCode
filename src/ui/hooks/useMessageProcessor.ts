// KCode - Message processing hook
// Extracted from App.tsx — handles slash commands, bash mode, file mentions,
// LLM message sending, multiline input, and message queue draining

import { useCallback, useRef } from "react";
import type { ConversationManager } from "../../core/conversation.js";
import type { SkillManager } from "../../core/skills.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type { KCodeConfig, StreamEvent } from "../../core/types.js";
import { handleBuiltinAction } from "../builtin-actions.js";
import type { KodiEvent } from "../components/Kodi.js";
import type { MessageEntry } from "../components/MessageList.js";
import type { TabInfo } from "../stream-handler.js";
import { processStreamEvents } from "../stream-handler.js";

export interface UseMessageProcessorParams {
  config: KCodeConfig;
  conversationManager: ConversationManager;
  tools: ToolRegistry;
  skillManager: SkillManager;
  mode: string;
  sessionStart: number;
  sessionNotes: Array<{ time: string; text: string }>;
  sessionName: string;
  sessionTags: string[];
  tabRemovalTimers: React.MutableRefObject<Set<ReturnType<typeof setTimeout>>>;
  switchTheme: (theme: string) => void;
  exit: () => void;
  setMode: (
    mode: "input" | "responding" | "permission" | "sudo-password" | "cloud" | "toggle",
  ) => void;
  setCompleted: (updater: (prev: MessageEntry[]) => MessageEntry[]) => void;
  setStreamingText: (text: string) => void;
  setStreamingThinking: (text: string) => void;
  setIsThinking: (v: boolean) => void;
  setLoadingMessage: (msg: string) => void;
  setTokenCount: (count: number) => void;
  setTurnTokens: (count: number) => void;
  setTurnStartTime: (time: number) => void;
  setSpinnerPhase: (phase: "thinking" | "streaming" | "tool") => void;
  setToolUseCount: (count: number) => void;
  setRunningAgentCount: (count: number) => void;
  setActiveTabs: (updater: (prev: TabInfo[]) => TabInfo[]) => void;
  setBashStreamOutput: (output: string | ((prev: string) => string)) => void;
  setSessionNotes: (
    updater: (prev: Array<{ time: string; text: string }>) => Array<{ time: string; text: string }>,
  ) => void;
  setSessionName: (name: string) => void;
  setSessionTags: (updater: (prev: string[]) => string[]) => void;
  setWatcherSuggestions: (updater: (prev: string[]) => string[]) => void;
  setShowContextGrid: (updater: (prev: boolean) => boolean) => void;
  setMessageQueue: (queue: string[]) => void;
  setLastKodiEvent: (event: KodiEvent | null) => void;
}

export interface UseMessageProcessorResult {
  handleSubmit: (userInput: string) => Promise<void>;
  lastUserPromptRef: React.MutableRefObject<string>;
  commandDepthRef: React.MutableRefObject<number>;
  telemetryPromptShownRef: React.MutableRefObject<boolean>;
  multilineBufferRef: React.MutableRefObject<string[]>;
  messageQueueRef: React.MutableRefObject<string[]>;
}

export function useMessageProcessor(params: UseMessageProcessorParams): UseMessageProcessorResult {
  const {
    config,
    conversationManager,
    tools,
    skillManager,
    mode,
    sessionStart,
    sessionNotes,
    sessionName,
    sessionTags,
    tabRemovalTimers,
    switchTheme,
    exit,
    setMode,
    setCompleted,
    setStreamingText,
    setStreamingThinking,
    setIsThinking,
    setLoadingMessage,
    setTokenCount,
    setTurnTokens,
    setTurnStartTime,
    setSpinnerPhase,
    setToolUseCount,
    setRunningAgentCount,
    setActiveTabs,
    setBashStreamOutput,
    setSessionNotes,
    setSessionName,
    setSessionTags,
    setWatcherSuggestions,
    setShowContextGrid,
    setMessageQueue,
    setLastKodiEvent,
  } = params;

  const lastUserPromptRef = useRef<string>("");
  const commandDepthRef = useRef<number>(0);
  const telemetryPromptShownRef = useRef<boolean>(false);
  const multilineBufferRef = useRef<string[]>([]);
  const messageQueueRef = useRef<string[]>([]);

  const processEvents = useCallback(async (events: AsyncGenerator<StreamEvent>) => {
    await processStreamEvents(events, {
      config,
      conversationManager,
      tabRemovalTimers,
      setLoadingMessage,
      setLastKodiEvent,
      setIsThinking,
      setStreamingThinking,
      setCompleted,
      setStreamingText,
      setToolUseCount,
      setBashStreamOutput,
      setActiveTabs,
      setTokenCount,
      setTurnTokens,
      setSpinnerPhase,
      setRunningAgentCount,
      setWatcherSuggestions,
    });
  }, []);

  // Process a single message (sends to LLM, handles events, resets state)
  const processMessage = useCallback(
    async (userInput: string) => {
      // Built-in exit commands
      const lower = userInput.toLowerCase().trim();
      if (
        lower === "/exit" ||
        lower === "/quit" ||
        lower === "/bye" ||
        lower === "exit" ||
        lower === "quit" ||
        lower === "bye"
      ) {
        exit();
        return;
      }

      // ! bash mode — execute command directly, bypass LLM
      if (userInput.startsWith("!") && userInput.length > 1) {
        const cmd = userInput.slice(1).trim();
        if (!cmd) {
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "user", text: userInput },
            { kind: "text", role: "assistant", text: "  Usage: !<command>" },
          ]);
          return;
        }
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        try {
          const { execSync } = await import("node:child_process");
          let output = execSync(cmd, {
            cwd: config.workingDirectory,
            encoding: "utf-8",
            timeout: 30000,
            stdio: ["pipe", "pipe", "pipe"],
          });
          // Strip potentially dangerous OSC terminal escape sequences (window title, clipboard, etc.)
          output = output
            .replace(/\x1b\][^\x07]*\x07/g, "") // OSC sequences with BEL terminator
            .replace(/\x1b\][^\x1b]*\x1b\\/g, ""); // OSC sequences with ST terminator
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "assistant", text: output.trimEnd() || "  (no output)" },
          ]);
        } catch (err: any) {
          const stderr = err.stderr ? String(err.stderr).trimEnd() : "";
          const stdout = err.stdout ? String(err.stdout).trimEnd() : "";
          const output = stderr || stdout || (err.message ?? "Command failed");
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "assistant", text: `  ${output}` },
          ]);
        }
        // Don't add to conversation history — just display result
        return;
      }

      if (lower === "/undo") {
        const result = conversationManager.getUndo().undo();
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: userInput },
          {
            kind: "text",
            role: "assistant",
            text: result ?? "  Nothing to undo.",
          },
        ]);
        return;
      }

      // Alias resolution — check user-defined aliases before anything else
      // Guard against infinite recursion (circular aliases, self-references, chain loops)
      if (commandDepthRef.current > 10) {
        commandDepthRef.current = 0;
        setCompleted((prev) => [
          ...prev,
          {
            kind: "text",
            role: "assistant",
            text: "  Error: Max command recursion depth (10) exceeded. Check for circular aliases.",
          },
        ]);
        return;
      }
      if (userInput.startsWith("/")) {
        const { resolveAlias } = await import("../../core/aliases.js");
        const resolved = resolveAlias(userInput);
        if (resolved) {
          commandDepthRef.current++;
          await processMessage(resolved);
          commandDepthRef.current = 0;
          return;
        }
      }

      // /retry — re-send last user prompt
      if (
        lower === "/retry" ||
        lower.startsWith("/retry ") ||
        lower === "/again" ||
        lower === "/redo"
      ) {
        const last = lastUserPromptRef.current;
        if (!last) {
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "user", text: userInput },
            { kind: "text", role: "assistant", text: "  No previous prompt to retry." },
          ]);
          return;
        }
        const replacement = userInput.replace(/^\/(retry|again|redo)\s*/i, "").trim();
        const toSend = replacement || last;
        setCompleted((prev) => [
          ...prev,
          {
            kind: "text",
            role: "assistant",
            text: `  Retrying: "${toSend.slice(0, 80)}${toSend.length > 80 ? "..." : ""}"`,
          },
        ]);
        commandDepthRef.current++;
        await processMessage(toSend);
        commandDepthRef.current = 0;
        return;
      }

      // /note — add timestamped annotation (not sent to LLM)
      if (lower.startsWith("/note ") || lower.startsWith("/annotate ")) {
        const noteText = userInput.replace(/^\/(note|annotate)\s+/i, "").trim();
        if (!noteText) {
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "user", text: userInput },
            { kind: "text", role: "assistant", text: "  Usage: /note <text>" },
          ]);
          return;
        }
        const time = new Date().toLocaleTimeString();
        setSessionNotes((prev) => [...prev, { time, text: noteText }]);
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: userInput },
          { kind: "text", role: "assistant", text: `  \u{1F4DD} [${time}] ${noteText}` },
        ]);
        return;
      }
      if (lower === "/note" || lower === "/annotate") {
        // Show all notes
        if (sessionNotes.length === 0) {
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "user", text: userInput },
            { kind: "text", role: "assistant", text: "  No notes yet. Usage: /note <text>" },
          ]);
        } else {
          const lines = [
            `  Session Notes (${sessionNotes.length}):\n`,
            ...sessionNotes.map((n) => `  [${n.time}] ${n.text}`),
          ];
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "user", text: userInput },
            { kind: "text", role: "assistant", text: lines.join("\n") },
          ]);
        }
        return;
      }

      // /agents — show live agent pool status
      if (lower === "/agents" || lower === "/agent-pool" || lower === "/pool") {
        const { getAgentPool } = await import("../../core/agents/pool.js");
        const { formatPoolStatus } = await import("../../core/agents/narrative.js");
        const pool = getAgentPool();
        const status = pool.getStatus();
        const text =
          status.active.length === 0 && status.done.length === 0 && status.queued.length === 0
            ? "  No agents spawned yet in this session.\n  Use /agent <role> <task> or ask in natural language."
            : formatPoolStatus(status);
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: userInput },
          { kind: "text", role: "assistant", text: "  " + text.split("\n").join("\n  ") },
        ]);
        return;
      }

      // /agent <role> <task> — spawn a single agent manually
      if (lower.startsWith("/agent ")) {
        const body = userInput.replace(/^\/agent\s+/i, "").trim();
        // Parse: first token is role, rest is task
        const spaceIdx = body.indexOf(" ");
        const role = (spaceIdx > 0 ? body.slice(0, spaceIdx) : body).toLowerCase();
        const task = spaceIdx > 0 ? body.slice(spaceIdx + 1).trim() : "";
        if (!task) {
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "user", text: userInput },
            {
              kind: "text",
              role: "assistant",
              text: "  Usage: /agent <role> <task>\n  Roles: auditor, fixer, tester, linter, reviewer, architect, security, optimizer, docs, migration, explorer, scribe, worker",
            },
          ]);
          return;
        }
        try {
          const { getAgentPool } = await import("../../core/agents/pool.js");
          const { ROLES } = await import("../../core/agents/roles.js");
          const { executorForRole } = await import("../../core/agents/executor.js");
          if (!(role in ROLES)) {
            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "user", text: userInput },
              {
                kind: "text",
                role: "assistant",
                text: `  Unknown role: ${role}\n  Valid: ${Object.keys(ROLES).join(", ")}`,
              },
            ]);
            return;
          }
          const pool = getAgentPool();
          const agent = pool.spawn(
            { role: role as any, task },
            executorForRole(role, config.workingDirectory),
          );
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "user", text: userInput },
            {
              kind: "text",
              role: "assistant",
              text: `  🚀 Spawned **${agent.name}** (${(ROLES as any)[role].displayName}): ${task}\n  Track with /agents or wait for completion.`,
            },
          ]);
        } catch (err) {
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "user", text: userInput },
            {
              kind: "text",
              role: "assistant",
              text: `  Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
            },
          ]);
        }
        return;
      }

      // /chain — run multiple slash commands in sequence
      if (lower.startsWith("/chain ") || lower.startsWith("/seq ") || lower.startsWith("/multi ")) {
        const chainBody = userInput.replace(/^\/(chain|seq|multi)\s+/i, "").trim();
        const commands = chainBody.split(/\s*;\s*/).filter(Boolean);
        if (commands.length === 0) {
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "user", text: userInput },
            { kind: "text", role: "assistant", text: "  Usage: /chain /cmd1 ; /cmd2 ; /cmd3" },
          ]);
          return;
        }
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: userInput },
          { kind: "text", role: "assistant", text: `  Running ${commands.length} commands...` },
        ]);
        try {
          commandDepthRef.current = 1; // mark as inside chain (not incrementing per iteration)
          for (const cmd of commands) {
            await processMessage(cmd.trim());
          }
        } finally {
          commandDepthRef.current = 0;
        }
        return;
      }

      // /workspace — switch working directory
      if (
        lower.startsWith("/workspace ") ||
        lower.startsWith("/cwd ") ||
        lower.startsWith("/cd ")
      ) {
        const dirArg = userInput.replace(/^\/(workspace|cwd|cd)\s+/i, "").trim();
        if (!dirArg) {
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "user", text: userInput },
            {
              kind: "text",
              role: "assistant",
              text: `  Current: ${config.workingDirectory}\n  Usage: /workspace <path>`,
            },
          ]);
          return;
        }
        const { resolve: resolvePath } = await import("node:path");
        const { existsSync, statSync: statSyncFn } = await import("node:fs");
        const newDir = resolvePath(config.workingDirectory, dirArg);
        if (!existsSync(newDir) || !statSyncFn(newDir).isDirectory()) {
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "user", text: userInput },
            { kind: "text", role: "assistant", text: `  Not a directory: ${newDir}` },
          ]);
          return;
        }
        config.workingDirectory = newDir;
        conversationManager.getConfig().workingDirectory = newDir;
        process.chdir(newDir);
        // Update tool workspace so Read/Glob/Grep resolve relative to the new dir
        const { setToolWorkspace } = await import("../../tools/workspace.js");
        setToolWorkspace(newDir);
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: userInput },
          { kind: "text", role: "assistant", text: `  Working directory changed to: ${newDir}` },
        ]);
        return;
      }
      if (lower === "/workspace" || lower === "/cwd" || lower === "/cd") {
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: userInput },
          {
            kind: "text",
            role: "assistant",
            text: `  Current: ${config.workingDirectory}\n  Usage: /workspace <path>`,
          },
        ]);
        return;
      }

      // /cloud — interactive cloud provider setup
      if (
        lower === "/cloud" ||
        lower === "/api-key" ||
        lower === "/apikey" ||
        lower === "/provider"
      ) {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        setMode("cloud");
        return;
      }

      // /login — OAuth PKCE flow against astrolexis.space.
      // Generates a state + code verifier, opens the browser to
      // astrolexis.space/oauth/authorize, starts a local callback
      // server, exchanges the returned code for tokens, saves to
      // keychain, invalidates the subscription cache so the next
      // isPro() call re-fetches.
      if (lower === "/login" || lower === "/login astrolexis") {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        try {
          const { loginProvider } = await import("../../core/auth/oauth-flow");
          setCompleted((prev) => [
            ...prev,
            {
              kind: "text",
              role: "system",
              text:
                "\n  \u26A1 Opening browser for Astrolexis login...\n  A tab will open at astrolexis.space. Authorize the request there and the TUI will pick up the session automatically.\n",
            },
          ]);
          const result = await loginProvider("astrolexis", {
            onAuthUrl: (url) => {
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "text",
                  role: "system",
                  text: `\n  If the browser didn't open, visit: ${url}\n`,
                },
              ]);
              // Best-effort: open the URL with the OS default handler
              try {
                const opener =
                  process.platform === "darwin"
                    ? ["open", url]
                    : process.platform === "win32"
                      ? ["cmd", "/c", "start", url]
                      : ["xdg-open", url];
                const proc = Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" });
                proc.unref();
              } catch {
                /* user will click the fallback URL */
              }
            },
          });

          // Fresh login → invalidate subscription cache so next
          // isPro() actually hits the server for the new token.
          try {
            const { invalidateSubscriptionCache, getSubscription, formatSubscription } =
              await import("../../core/subscription");
            invalidateSubscriptionCache();
            const sub = await getSubscription({ forceRefresh: true });
            setCompleted((prev) => [
              ...prev,
              {
                kind: "text",
                role: "system",
                text: `\n  \u2713 Logged in to ${result.provider}.\n  ${formatSubscription(sub)}\n`,
              },
            ]);
          } catch (err) {
            setCompleted((prev) => [
              ...prev,
              {
                kind: "text",
                role: "system",
                text: `\n  \u2713 Logged in to ${result.provider}, but subscription fetch failed: ${err instanceof Error ? err.message : err}\n`,
              },
            ]);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "system", text: `\n  \u2717 Login failed: ${msg}\n` },
          ]);
        }
        return;
      }

      // /logout — clear Astrolexis OAuth session + subscription cache
      if (lower === "/logout") {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        try {
          const { getAuthSessionManager } = await import("../../core/auth/session");
          const { invalidateSubscriptionCache } = await import(
            "../../core/subscription"
          );
          const manager = getAuthSessionManager();
          await manager.logout("astrolexis");
          invalidateSubscriptionCache();
          const { existsSync, unlinkSync } = await import("node:fs");
          const { kcodePath } = await import("../../core/paths");
          const cachePath = kcodePath("subscription-cache.json");
          if (existsSync(cachePath)) unlinkSync(cachePath);
          setCompleted((prev) => [
            ...prev,
            {
              kind: "text",
              role: "system",
              text: "\n  \u2713 Logged out of Astrolexis. Cached subscription cleared.\n",
            },
          ]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "system", text: `\n  \u2717 Logout failed: ${msg}\n` },
          ]);
        }
        return;
      }

      // /license — status | activate <path> | deactivate
      if (lower.startsWith("/license")) {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        const parts = userInput.trim().split(/\s+/);
        const subcmd = parts[1]?.toLowerCase() || "status";
        const arg = parts.slice(2).join(" ").trim();

        try {
          if (subcmd === "activate") {
            if (!arg) {
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "text",
                  role: "system",
                  text:
                    "\n  Usage:\n    /license activate <path>                — from a .jwt file\n    /license activate eyJhbGci...xyz        — paste the JWT directly\n",
                },
              ]);
              return;
            }
            const { existsSync, readFileSync, mkdirSync, writeFileSync } = await import(
              "node:fs"
            );
            const { resolve, dirname } = await import("node:path");
            const { kcodePath } = await import("../../core/paths");
            const { verifyLicenseJwt } = await import("../../core/license");

            // Autodetect: is this the JWT itself, or a path?
            // JWTs are 3 dot-separated base64url chunks, start with "eyJ",
            // contain no path separators or whitespace, and are long.
            const looksLikeJwt =
              arg.trim().length >= 50 &&
              arg.trim().startsWith("eyJ") &&
              arg.trim().split(".").length === 3 &&
              !arg.includes("/") &&
              !arg.includes("\\") &&
              !arg.includes(" ");

            let token: string;
            if (looksLikeJwt) {
              token = arg.trim();
            } else {
              // Expand ~ if present
              const home = process.env.HOME ?? "";
              const expanded = arg.startsWith("~/") ? home + arg.slice(1) : arg;
              const absPath = resolve(expanded);

              if (!existsSync(absPath)) {
                setCompleted((prev) => [
                  ...prev,
                  {
                    kind: "text",
                    role: "system",
                    text: `\n  \u2717 File not found: ${absPath}\n  (If you meant to paste the JWT directly, make sure it starts with \"eyJ\" and has no spaces.)\n`,
                  },
                ]);
                return;
              }
              token = readFileSync(absPath, "utf-8").trim();
            }
            const result = verifyLicenseJwt(token);
            if (!result.valid || !result.claims) {
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "text",
                  role: "system",
                  text: `\n  \u2717 License invalid: ${result.error}\n`,
                },
              ]);
              return;
            }

            const targetPath = kcodePath("license.jwt");
            mkdirSync(dirname(targetPath), { recursive: true });
            writeFileSync(targetPath, token, "utf-8");

            const c = result.claims;
            const daysLeft = Math.floor(
              (c.exp - Math.floor(Date.now() / 1000)) / 86400,
            );
            const lines = [
              "\n  \u2713 License activated.",
              `  Subject:  ${c.sub}`,
              `  Tier:     ${c.tier ?? "pro"}`,
              `  Seats:    ${c.seats}`,
              `  Features: ${c.features.join(", ")}`,
              `  Expires:  ${daysLeft} days (${new Date(c.exp * 1000).toISOString().slice(0, 10)})`,
            ];
            if (c.hardware) lines.push("  Hardware-bound to this machine");
            lines.push("");
            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "system", text: lines.join("\n") },
            ]);
            return;
          }

          if (subcmd === "deactivate") {
            const { existsSync, unlinkSync } = await import("node:fs");
            const { kcodePath } = await import("../../core/paths");
            const path = kcodePath("license.jwt");
            if (!existsSync(path)) {
              setCompleted((prev) => [
                ...prev,
                { kind: "text", role: "system", text: `\n  No license file found at ${path}\n` },
              ]);
              return;
            }
            unlinkSync(path);
            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "system", text: "\n  \u2713 License removed from this machine.\n" },
            ]);
            return;
          }

          // Default: status
          const { formatLicenseStatus } = await import("../../core/license");
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "system", text: "\n" + formatLicenseStatus() + "\n" },
          ]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "system", text: `\n  \u2717 License command failed: ${msg}\n` },
          ]);
        }
        return;
      }

      // /auth — OAuth login/status/logout for cloud providers
      if (lower.startsWith("/auth")) {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        const parts = userInput.trim().split(/\s+/);
        const subcmd = parts[1]?.toLowerCase() || "status";

        try {
          const {
            getOAuthProviderNames,
            getProviderAuthStatus,
            loginProvider,
            clearTokens,
            PROVIDER_CONFIGS,
          } = await import("../../core/auth/oauth-flow.js");

          if (subcmd === "status" || subcmd === "list") {
            const providers = getOAuthProviderNames();
            const lines = ["  OAuth Authentication Status\n"];
            for (const name of providers) {
              const status = await getProviderAuthStatus(name);
              const icon = status.authenticated ? "\u2713" : "\u2717";
              const methodLabel =
                status.method === "oauth"
                  ? "OAuth"
                  : status.method === "api_key"
                    ? "API Key"
                    : status.method === "env"
                      ? "Env var"
                      : "not configured";
              let expiry = "";
              if (status.method === "oauth" && status.expiresAt) {
                const remaining = status.expiresAt - Date.now();
                if (remaining > 0) {
                  const mins = Math.floor(remaining / 60_000);
                  expiry = mins > 60 ? ` (${Math.floor(mins / 60)}h)` : ` (${mins}m)`;
                } else {
                  expiry = " (expired)";
                }
              }
              lines.push(`  ${icon} ${status.label.padEnd(22)} ${methodLabel}${expiry}`);
            }
            lines.push("\n  Use: /auth login <provider> | /auth logout <provider>");
            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "assistant", text: lines.join("\n") },
            ]);
          } else if (subcmd === "login") {
            const provider = parts[2];
            if (!provider) {
              const providers = getOAuthProviderNames().filter((p) => p !== "kcode-cloud");
              const lines = ["  Usage: /auth login <provider>\n\n  Available providers:"];
              for (const p of providers) {
                const label = PROVIDER_CONFIGS[p]?.label ?? p;
                lines.push(`    - ${p} (${label})`);
              }
              setCompleted((prev) => [
                ...prev,
                { kind: "text", role: "assistant", text: lines.join("\n") },
              ]);
            } else {
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "text",
                  role: "assistant",
                  text: `  Starting OAuth login for ${provider}...`,
                },
              ]);
              const result = await loginProvider(provider, {
                onAuthUrl: (url) => {
                  setCompleted((prev) => [
                    ...prev,
                    {
                      kind: "text",
                      role: "assistant",
                      text: `  Open this URL if the browser didn't open:\n  ${url}`,
                    },
                  ]);
                },
              });
              const method =
                result.method === "api_key" ? "API key stored in keychain" : "OAuth tokens stored";
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "text",
                  role: "assistant",
                  text: `  \u2713 Authenticated with ${provider} (${method})`,
                },
              ]);
            }
          } else if (subcmd === "logout") {
            const provider = parts[2];
            if (!provider) {
              setCompleted((prev) => [
                ...prev,
                { kind: "text", role: "assistant", text: "  Usage: /auth logout <provider>" },
              ]);
            } else {
              await clearTokens(provider);
              try {
                const { deleteSecret } = await import("../../core/auth/keychain.js");
                await deleteSecret(`apikey-${provider}`);
              } catch {
                /* ok */
              }
              setCompleted((prev) => [
                ...prev,
                { kind: "text", role: "assistant", text: `  \u2713 Logged out from ${provider}` },
              ]);
            }
          } else {
            setCompleted((prev) => [
              ...prev,
              {
                kind: "text",
                role: "assistant",
                text: "  Usage: /auth [status | login <provider> | logout <provider>]",
              },
            ]);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "assistant", text: `  Auth error: ${msg}` },
          ]);
        }
        return;
      }

      // /toggle — switch between local and cloud models
      if (lower === "/toggle" || lower === "/model" || lower === "/switch") {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        setMode("toggle");
        return;
      }

      // /hookify — dynamic rule engine
      if (lower.startsWith("/hookify")) {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        (async () => {
          try {
            const {
              loadHookifyRules,
              saveHookifyRule,
              deleteHookifyRule,
              testHookifyRules,
              formatRuleList,
              formatRuleDetail,
            } = await import("../../core/hookify.js");
            type HookifyRule = Awaited<ReturnType<typeof loadHookifyRules>>[number];
            type HookifyCondition = HookifyRule["conditions"][number];
            const args = userInput.slice("/hookify".length).trim();
            const parts = args.split(/\s+/);
            const subcmd = parts[0]?.toLowerCase() || "list";

            if (subcmd === "list" || subcmd === "ls" || !args) {
              const rules = await loadHookifyRules();
              setCompleted((prev) => [
                ...prev,
                { kind: "text", role: "assistant", text: formatRuleList(rules) },
              ]);
            } else if (subcmd === "create" || subcmd === "add" || subcmd === "new") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [
                  ...prev,
                  {
                    kind: "text",
                    role: "assistant",
                    text: "  Usage: /hookify create <name> [event=bash|file|all] [action=block|warn] [tool=Bash|Edit] [field:operator:pattern]\n\n  Example: /hookify create no-force-push event=bash action=block tool=Bash command:regex_match:git\\\\s+push\\\\s+.*--force",
                  },
                ]);
                return;
              }
              const rule: HookifyRule = {
                name,
                enabled: true,
                event: "all" as const,
                conditions: [],
                action: "warn" as const,
                message: `Rule "${name}" triggered.`,
              };
              for (let i = 2; i < parts.length; i++) {
                const part = parts[i]!;
                if (part.startsWith("event=")) rule.event = part.slice(6) as HookifyRule["event"];
                else if (part.startsWith("action="))
                  rule.action = part.slice(7) as HookifyRule["action"];
                else if (part.startsWith("tool=")) rule.toolMatcher = part.slice(5);
                else if (part.startsWith("msg=")) rule.message = part.slice(4).replace(/_/g, " ");
                else if (part.includes(":")) {
                  const [field, operator, ...rest] = part.split(":");
                  if (field && operator) {
                    rule.conditions.push({
                      field,
                      operator: operator as HookifyCondition["operator"],
                      pattern: rest.join(":"),
                    });
                  }
                }
              }
              await saveHookifyRule(rule);
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "text",
                  role: "assistant",
                  text: `  Created hookify rule: ${name}\n${formatRuleDetail(rule)}`,
                },
              ]);
            } else if (subcmd === "toggle") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [
                  ...prev,
                  { kind: "text", role: "assistant", text: "  Usage: /hookify toggle <name>" },
                ]);
                return;
              }
              const rules = await loadHookifyRules();
              const rule = rules.find((r) => r.name === name);
              if (!rule) {
                setCompleted((prev) => [
                  ...prev,
                  { kind: "text", role: "assistant", text: `  Rule not found: ${name}` },
                ]);
                return;
              }
              rule.enabled = !rule.enabled;
              await saveHookifyRule(rule);
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "text",
                  role: "assistant",
                  text: `  Rule "${name}" is now ${rule.enabled ? "enabled" : "disabled"}`,
                },
              ]);
            } else if (subcmd === "delete" || subcmd === "rm" || subcmd === "remove") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [
                  ...prev,
                  { kind: "text", role: "assistant", text: "  Usage: /hookify delete <name>" },
                ]);
                return;
              }
              const deleted = await deleteHookifyRule(name);
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "text",
                  role: "assistant",
                  text: deleted ? `  Deleted rule: ${name}` : `  Rule not found: ${name}`,
                },
              ]);
            } else if (subcmd === "test") {
              const command = parts.slice(1).join(" ");
              if (!command) {
                setCompleted((prev) => [
                  ...prev,
                  { kind: "text", role: "assistant", text: "  Usage: /hookify test <command>" },
                ]);
                return;
              }
              const result = await testHookifyRules(command);
              const lines = [`  Test result for: ${command}\n`, `  Decision: ${result.decision}`];
              if (result.matchedRules.length > 0) {
                lines.push(`  Matched rules: ${result.matchedRules.join(", ")}`);
              }
              if (result.messages.length > 0) {
                lines.push(`  Messages:`);
                for (const msg of result.messages) lines.push(`    ${msg}`);
              }
              setCompleted((prev) => [
                ...prev,
                { kind: "text", role: "assistant", text: lines.join("\n") },
              ]);
            } else if (subcmd === "show" || subcmd === "info") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [
                  ...prev,
                  { kind: "text", role: "assistant", text: "  Usage: /hookify show <name>" },
                ]);
                return;
              }
              const rules = await loadHookifyRules();
              const rule = rules.find((r) => r.name === name);
              if (!rule) {
                setCompleted((prev) => [
                  ...prev,
                  { kind: "text", role: "assistant", text: `  Rule not found: ${name}` },
                ]);
                return;
              }
              setCompleted((prev) => [
                ...prev,
                { kind: "text", role: "assistant", text: formatRuleDetail(rule) },
              ]);
            } else {
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "text",
                  role: "assistant",
                  text: "  Usage: /hookify [list|create <name>|toggle <name>|delete <name>|test <command>|show <name>]",
                },
              ]);
            }
          } catch (err) {
            setCompleted((prev) => [
              ...prev,
              {
                kind: "text",
                role: "assistant",
                text: `  Hookify error: ${err instanceof Error ? err.message : err}`,
              },
            ]);
          }
        })();
        return;
      }

      // /marketplace — plugin marketplace
      if (lower.startsWith("/marketplace")) {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        (async () => {
          try {
            const {
              searchPlugins,
              getPluginDetails,
              installFromMarketplace,
              updatePlugin,
              listInstalled,
              checkUpdates,
              formatPluginInfo,
              formatPluginList,
            } = await import("../../core/marketplace.js");
            const args = userInput.slice("/marketplace".length).trim();
            const parts = args.split(/\s+/);
            const subcmd = parts[0]?.toLowerCase() || "list";

            if (subcmd === "search" || subcmd === "find") {
              const query = parts.slice(1).join(" ");
              const results = await searchPlugins(query);
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "text",
                  role: "assistant",
                  text: formatPluginList(
                    results,
                    query ? `Search results for "${query}"` : "All available plugins",
                  ),
                },
              ]);
            } else if (subcmd === "install" || subcmd === "add") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [
                  ...prev,
                  {
                    kind: "text",
                    role: "assistant",
                    text: "  Usage: /marketplace install <plugin-name>",
                  },
                ]);
                return;
              }
              const success = await installFromMarketplace(name);
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "text",
                  role: "assistant",
                  text: success
                    ? `  Installed "${name}" from marketplace`
                    : `  Failed to install "${name}". Check logs for details.`,
                },
              ]);
            } else if (subcmd === "update") {
              const name = parts[1];
              if (name) {
                const success = await updatePlugin(name);
                setCompleted((prev) => [
                  ...prev,
                  {
                    kind: "text",
                    role: "assistant",
                    text: success ? `  Updated "${name}"` : `  Failed to update "${name}"`,
                  },
                ]);
              } else {
                const updates = await checkUpdates();
                if (updates.length === 0) {
                  setCompleted((prev) => [
                    ...prev,
                    { kind: "text", role: "assistant", text: "  All plugins are up to date." },
                  ]);
                } else {
                  const lines = [`  Updates available (${updates.length}):\n`];
                  for (const u of updates) {
                    lines.push(`  ${u.name}: ${u.current} -> ${u.latest}`);
                  }
                  lines.push(`\n  Run /marketplace update <name> to update`);
                  setCompleted((prev) => [
                    ...prev,
                    { kind: "text", role: "assistant", text: lines.join("\n") },
                  ]);
                }
              }
            } else if (subcmd === "info" || subcmd === "details") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [
                  ...prev,
                  {
                    kind: "text",
                    role: "assistant",
                    text: "  Usage: /marketplace info <plugin-name>",
                  },
                ]);
                return;
              }
              const plugin = await getPluginDetails(name);
              if (!plugin) {
                setCompleted((prev) => [
                  ...prev,
                  { kind: "text", role: "assistant", text: `  Plugin not found: ${name}` },
                ]);
                return;
              }
              setCompleted((prev) => [
                ...prev,
                { kind: "text", role: "assistant", text: formatPluginInfo(plugin) },
              ]);
            } else if (subcmd === "list" || subcmd === "ls" || subcmd === "installed" || !args) {
              const installed = await listInstalled();
              if (installed.length === 0) {
                const available = await searchPlugins("");
                setCompleted((prev) => [
                  ...prev,
                  {
                    kind: "text",
                    role: "assistant",
                    text: `  No plugins installed from marketplace.\n\n${formatPluginList(available, "Available plugins")}`,
                  },
                ]);
              } else {
                setCompleted((prev) => [
                  ...prev,
                  {
                    kind: "text",
                    role: "assistant",
                    text: formatPluginList(installed, "Installed from marketplace"),
                  },
                ]);
              }
            } else {
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "text",
                  role: "assistant",
                  text: "  Usage: /marketplace [search <query>|install <name>|update [name]|info <name>|list]",
                },
              ]);
            }
          } catch (err) {
            setCompleted((prev) => [
              ...prev,
              {
                kind: "text",
                role: "assistant",
                text: `  Marketplace error: ${err instanceof Error ? err.message : err}`,
              },
            ]);
          }
        })();
        return;
      }

      // /plugin — plugin management
      if (lower.startsWith("/plugin")) {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        (async () => {
          try {
            const { PluginManager } = await import("../../core/plugin-manager.js");
            const pm = new PluginManager();
            const args = userInput.slice("/plugin".length).trim();
            const parts = args.split(/\s+/);
            const subcmd = parts[0]?.toLowerCase() || "list";

            if (subcmd === "list" || subcmd === "ls" || !args) {
              const plugins = await pm.list();
              if (plugins.length === 0) {
                setCompleted((prev) => [
                  ...prev,
                  {
                    kind: "text",
                    role: "assistant",
                    text: "  No plugins installed.\n  Usage: /plugin install <path-or-git-url>",
                  },
                ]);
              } else {
                const lines = plugins.map(
                  (p) => `  ${p.name} v${p.version} — ${p.description ?? "no description"}`,
                );
                setCompleted((prev) => [
                  ...prev,
                  {
                    kind: "text",
                    role: "assistant",
                    text: `  Installed plugins (${plugins.length}):\n${lines.join("\n")}`,
                  },
                ]);
              }
            } else if (subcmd === "install" || subcmd === "add") {
              const source = parts.slice(1).join(" ");
              if (!source) {
                setCompleted((prev) => [
                  ...prev,
                  {
                    kind: "text",
                    role: "assistant",
                    text: "  Usage: /plugin install <path-or-git-url>",
                  },
                ]);
              } else {
                const manifest = await pm.install(source);
                setCompleted((prev) => [
                  ...prev,
                  {
                    kind: "text",
                    role: "assistant",
                    text: `  Installed: ${manifest.name} v${manifest.version}\n  ${manifest.description ?? ""}`,
                  },
                ]);
              }
            } else if (subcmd === "remove" || subcmd === "rm" || subcmd === "uninstall") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [
                  ...prev,
                  { kind: "text", role: "assistant", text: "  Usage: /plugin remove <name>" },
                ]);
              } else {
                const ok = await pm.remove(name);
                setCompleted((prev) => [
                  ...prev,
                  {
                    kind: "text",
                    role: "assistant",
                    text: ok ? `  Removed: ${name}` : `  Plugin not found: ${name}`,
                  },
                ]);
              }
            } else {
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "text",
                  role: "assistant",
                  text: "  Usage: /plugin [list|install <source>|remove <name>]",
                },
              ]);
            }
          } catch (err) {
            setCompleted((prev) => [
              ...prev,
              {
                kind: "text",
                role: "assistant",
                text: `  Plugin error: ${err instanceof Error ? err.message : err}`,
              },
            ]);
          }
        })();
        return;
      }

      if (userInput === "/status") {
        const state = conversationManager.getState();
        const usage = conversationManager.getUsage();
        const sessionElapsed = Date.now() - sessionStart;
        const formatTime = (ms: number) => {
          const secs = Math.floor(ms / 1000);
          if (secs < 60) return `${secs}s`;
          const mins = Math.floor(secs / 60);
          if (mins < 60) return `${mins}m${(secs % 60).toString().padStart(2, "0")}s`;
          const hours = Math.floor(mins / 60);
          return `${hours}h${(mins % 60).toString().padStart(2, "0")}m`;
        };
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: userInput },
          {
            kind: "text",
            role: "assistant",
            text: `  Messages: ${state.messages.length}\n  Tokens: ${usage.inputTokens + usage.outputTokens} (in: ${usage.inputTokens}, out: ${usage.outputTokens})\n  Tool uses: ${state.toolUseCount}\n  Session: ${formatTime(sessionElapsed)}`,
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

          // Built-in template command — display result locally (no LLM call)
          if (expanded.isTemplate) {
            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "user", text: userInput },
              {
                kind: "text",
                role: "assistant",
                text: expanded.prompt,
              },
            ]);
            return;
          }

          // Built-in action commands (stats, doctor, models, clear, compact, rewind)
          if (expanded.builtinAction) {
            const result = await handleBuiltinAction(
              expanded.builtinAction,
              conversationManager,
              setCompleted,
              config,
              expanded.prompt,
              switchTheme,
            );

            // /context — toggle the context grid display
            if (expanded.builtinAction === "context") {
              setShowContextGrid((prev) => !prev);
            }

            // /rename — set session name (needs component state access)
            if (result.startsWith("__rename__")) {
              const name = result.slice("__rename__".length).trim();
              if (!name) {
                setCompleted((prev) => [
                  ...prev,
                  { kind: "text", role: "user", text: userInput },
                  {
                    kind: "text",
                    role: "assistant",
                    text: sessionName
                      ? `  Current session: "${sessionName}"\n  Usage: /rename <name>`
                      : "  Usage: /rename <name>",
                  },
                ]);
              } else {
                setSessionName(name);
                setCompleted((prev) => [
                  ...prev,
                  { kind: "text", role: "user", text: userInput },
                  { kind: "text", role: "assistant", text: `  Session renamed to: "${name}"` },
                ]);
              }
              return;
            }

            // /session-tags — manage session tags (needs component state access)
            if (result.startsWith("__session_tags__")) {
              const tagArgs = result.slice("__session_tags__".length).trim();
              const parts = tagArgs.split(/\s+/);
              const subCmd = parts[0] ?? "";
              const tagValue = parts.slice(1).join(" ");

              if (subCmd === "add" && tagValue) {
                setSessionTags((prev) => {
                  if (prev.includes(tagValue)) return prev;
                  return [...prev, tagValue];
                });
                setCompleted((prev) => [
                  ...prev,
                  { kind: "text", role: "user", text: userInput },
                  { kind: "text", role: "assistant", text: `  Tag added: "${tagValue}"` },
                ]);
              } else if (subCmd === "remove" && tagValue) {
                setSessionTags((prev) => prev.filter((t) => t !== tagValue));
                setCompleted((prev) => [
                  ...prev,
                  { kind: "text", role: "user", text: userInput },
                  { kind: "text", role: "assistant", text: `  Tag removed: "${tagValue}"` },
                ]);
              } else {
                // List tags
                const tagsDisplay =
                  sessionTags.length > 0
                    ? `  Session Tags: ${sessionTags.map((t) => `[${t}]`).join(" ")}`
                    : "  No tags set. Use /session-tags add <tag> to add one.";
                setCompleted((prev) => [
                  ...prev,
                  { kind: "text", role: "user", text: userInput },
                  { kind: "text", role: "assistant", text: tagsDisplay },
                ]);
              }
              return;
            }

            // Some builtin actions return a prompt to send to the LLM (dry-run, auto-fix)
            if (
              result.startsWith("__dry_run_prompt__") ||
              result.startsWith("__auto_fix_prompt__")
            ) {
              const llmPrompt = result.replace(/^__(?:dry_run|auto_fix)_prompt__/, "");
              setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
              setMode("responding");
              setStreamingText("");
              setTurnTokens(0);
              setTurnStartTime(Date.now());
              setSpinnerPhase("thinking");
              setLoadingMessage("Thinking...");
              try {
                const events = conversationManager.sendMessage(llmPrompt);
                await processEvents(events);
              } catch (err) {
                setCompleted((prev) => [
                  ...prev,
                  {
                    kind: "text",
                    role: "assistant",
                    text: `Error: ${err instanceof Error ? err.message : err}`,
                  },
                ]);
              } finally {
                setMode("input");
                setStreamingText("");
                setStreamingThinking("");
                setIsThinking(false);
                setLoadingMessage("");
              }
              return;
            }

            // Sentinel: __INLINE_DONE__ means the handler already pushed
            // its own messages to setCompleted (e.g. streaming actions
            // like /scan). Skip the default user+assistant push.
            if (result === "__INLINE_DONE__") {
              return;
            }

            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "user", text: userInput },
              { kind: "text", role: "assistant", text: result },
            ]);
            return;
          }

          // Show the slash command as user message, then send expanded prompt to LLM
          setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
          setMode("responding");
          setStreamingText("");
          setTurnTokens(0);
          setTurnStartTime(Date.now());
          setSpinnerPhase("thinking");
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

      // One-time telemetry opt-in banner on first prompt when not yet configured
      if (!telemetryPromptShownRef.current && config.telemetry === undefined) {
        telemetryPromptShownRef.current = true;
        // Show a non-blocking banner — the user can respond later via /telemetry
        setCompleted((prev) => [
          ...prev,
          {
            kind: "text",
            role: "assistant",
            text: "  KCode collects anonymous tool usage analytics locally (never sent externally).\n  Enable? Use /telemetry on or /telemetry off to decide.",
          },
        ]);
      }

      // Track last user prompt for /retry
      lastUserPromptRef.current = userInput;

      // @ file mentions — detect @path/to/file patterns and prepend file content
      let processedInput = userInput;
      const fileMentions = userInput.match(/@([\w./_~-]+[\w._/-]+)/g);
      if (fileMentions && fileMentions.length > 0) {
        const { resolve: resolvePath } = await import("node:path");
        const { readFileSync, existsSync } = await import("node:fs");
        const prefixes: string[] = [];
        let cleanedInput = userInput;
        for (const mention of fileMentions) {
          const filePath = mention.slice(1); // strip @
          const absPath = resolvePath(config.workingDirectory, filePath);
          if (existsSync(absPath)) {
            try {
              const content = readFileSync(absPath, "utf-8");
              const truncated =
                content.length > 50000 ? content.slice(0, 50000) + "\n... (truncated)" : content;
              prefixes.push(`[File: ${filePath}]\n${truncated}`);
            } catch {
              prefixes.push(`[File: ${filePath}] (could not read)`);
            }
          }
          cleanedInput = cleanedInput.replace(mention, filePath);
        }
        if (prefixes.length > 0) {
          processedInput = prefixes.join("\n\n") + "\n\n" + cleanedInput;
        }
      }

      // Image file path detection — detect paths to image files and annotate the message
      const pathPattern =
        /(?:^|\s)((?:\/|\.\/|~\/|\.\.\/)?[\w./_~-]*\.(png|jpg|jpeg|gif|webp|bmp))(?:\s|$)/gi;
      const imageMatches = [...processedInput.matchAll(pathPattern)];
      if (imageMatches.length > 0) {
        const annotations: string[] = [];
        for (const match of imageMatches) {
          const imagePath = match[1];
          annotations.push(`[Image attached: ${imagePath}]`);
        }
        // Check if mnemo:scanner model is available
        let scannerNote = "";
        try {
          const { loadModelsConfig } = await import("../../core/models.js");
          const modelsConfig = await loadModelsConfig();
          const hasScanner = modelsConfig.models?.some(
            (m: { name: string }) => m.name === "mnemo:scanner" || m.name.includes("scanner"),
          );
          if (hasScanner) {
            scannerNote = "\n(Note: The mnemo:scanner model is available for image analysis)";
          }
        } catch {
          /* ignore */
        }
        processedInput = processedInput + "\n\n" + annotations.join("\n") + scannerNote;
      }

      // Add user message to display
      setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);

      // Start response
      setMode("responding");
      setStreamingText("");
      setTurnTokens(0);
      setTurnStartTime(Date.now());
      setSpinnerPhase("thinking");
      setLoadingMessage("Thinking...");

      try {
        const events = conversationManager.sendMessage(processedInput);
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

      // Update stats — use API-reported tokens, or estimate from context if unavailable
      const state = conversationManager.getState();
      const usage = conversationManager.getUsage();
      const apiTokens = usage.inputTokens + usage.outputTokens;
      setTokenCount(apiTokens > 0 ? apiTokens : state.tokenCount);
      setToolUseCount(state.toolUseCount);
    },
    [conversationManager, tools, skillManager, exit],
  );

  // Drain the message queue — process queued messages one by one
  const drainQueue = useCallback(async () => {
    while (messageQueueRef.current.length > 0) {
      const next = messageQueueRef.current[0]!;
      messageQueueRef.current = messageQueueRef.current.slice(1);
      setMessageQueue([...messageQueueRef.current]);
      await processMessage(next);
    }
  }, [processMessage]);

  const handleSubmit = useCallback(
    async (userInput: string) => {
      // Multiline input support — if line ends with \, accumulate and wait for more
      if (userInput.endsWith("\\")) {
        const lineWithoutBackslash = userInput.slice(0, -1);
        multilineBufferRef.current.push(lineWithoutBackslash);
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: `... ${lineWithoutBackslash}` },
        ]);
        return;
      }

      // If we have buffered lines, join them with the final line
      let finalInput = userInput;
      if (multilineBufferRef.current.length > 0) {
        multilineBufferRef.current.push(userInput);
        finalInput = multilineBufferRef.current.join("\n");
        multilineBufferRef.current = [];
      }

      // Clear file watcher suggestions on new input
      setWatcherSuggestions(() => []);

      if (mode === "responding") {
        // Queue the message — show it as queued in the UI
        messageQueueRef.current = [...messageQueueRef.current, finalInput];
        setMessageQueue([...messageQueueRef.current]);
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: `${finalInput}  [queued]` },
        ]);
        return;
      }

      await processMessage(finalInput);
      // After processing, drain any queued messages
      await drainQueue();
    },
    [mode, processMessage, drainQueue],
  );

  return {
    handleSubmit,
    lastUserPromptRef,
    commandDepthRef,
    telemetryPromptShownRef,
    multilineBufferRef,
    messageQueueRef,
  };
}
