// KCode - App lifecycle effects hook
// Extracted from App.tsx — wires up permission prompts, sudo prompts, trust callbacks,
// file watcher, and tab removal timer cleanup

import { useEffect } from "react";
import type { ConversationManager } from "../../core/conversation.js";
import { getFileChangeSuggester } from "../../core/file-watcher.js";
import { setTrustPromptCallback } from "../../core/hooks.js";
import type { MessageEntry } from "../components/MessageList.js";
import type { PermissionChoice } from "../components/PermissionDialog.js";

export interface UseAppEffectsParams {
  conversationManager: ConversationManager;
  workingDirectory: string;
  tabRemovalTimers: React.MutableRefObject<Set<ReturnType<typeof setTimeout>>>;
  setMode: (mode: "input" | "responding" | "permission" | "sudo-password" | "cloud" | "toggle") => void;
  setCompleted: (updater: (prev: MessageEntry[]) => MessageEntry[]) => void;
  setPermissionRequest: (req: { toolName: string; description: string } | null) => void;
  setPermissionResolver: (resolver: ((choice: PermissionChoice) => void) | null) => void;
  setSudoPasswordResolver: (resolver: ((password: string | null) => void) | null) => void;
  setWatcherSuggestions: (updater: (prev: string[]) => string[]) => void;
}

export function useAppEffects({
  conversationManager,
  workingDirectory,
  tabRemovalTimers,
  setMode,
  setCompleted,
  setPermissionRequest,
  setPermissionResolver,
  setSudoPasswordResolver,
  setWatcherSuggestions,
}: UseAppEffectsParams): void {
  // Wire up the permission prompt callback so PermissionManager can ask the user
  useEffect(() => {
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
    return () => { conversationManager.getPermissions().setPromptFn(undefined); };
  }, [conversationManager]);

  // Wire up sudo password prompt callback so Bash tool can ask for password
  useEffect(() => {
    conversationManager.setSudoPasswordPromptFn(async () => {
      return new Promise<string | null>((resolve) => {
        setMode("sudo-password");
        setSudoPasswordResolver(() => (password: string | null) => {
          resolve(password);
        });
      });
    });
    return () => { conversationManager.setSudoPasswordPromptFn(undefined); };
  }, [conversationManager]);

  // Wire up trust prompt callback so project hooks auto-trust with logging
  useEffect(() => {
    setTrustPromptCallback(async (workspacePath, _command) => {
      setCompleted((prev) => [
        ...prev,
        { kind: "system" as const, text: `Trusting workspace: ${workspacePath}` },
      ]);
      return true;
    });
  }, []);

  // Cleanup tab removal timers on unmount
  useEffect(() => {
    return () => {
      for (const t of tabRemovalTimers.current) clearTimeout(t);
      tabRemovalTimers.current.clear();
    };
  }, []);

  // Wire file change suggester for real-time notifications
  useEffect(() => {
    const suggester = getFileChangeSuggester(workingDirectory);
    suggester.onSuggestion = (newSuggestions) => {
      setWatcherSuggestions((prev) => [...prev, ...newSuggestions]);
    };
    return () => {
      suggester.onSuggestion = null;
    };
  }, [workingDirectory]);
}
