// KCode - Ink render entry point
// Initializes and renders the Ink application with paste interception

import { render } from "ink";
import React from "react";
import type { ConversationManager } from "../core/conversation.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import type { KCodeConfig } from "../core/types.js";
import App from "./App.js";
import { invokePasteHandler } from "./paste-handler.js";
import { installPasteInterceptor } from "./paste-stream.js";
import { ThemeProvider } from "./ThemeContext.js";

interface StartUIOptions {
  config: KCodeConfig;
  conversationManager: ConversationManager;
  tools: ToolRegistry;
}

export function startUI({ config, conversationManager, tools }: StartUIOptions) {
  // Install paste interceptor BEFORE Ink sets up its listeners.
  // Uses prependListener so our handler fires first on stdin data events.
  const cleanupPaste = installPasteInterceptor((text) => {
    invokePasteHandler(text);
  });

  const instance = render(
    <ThemeProvider>
      <App
        config={config}
        conversationManager={conversationManager}
        tools={tools}
        initialSessionName={config.sessionName}
      />
    </ThemeProvider>,
    {
      exitOnCtrlC: true,
    },
  );

  const originalWaitUntilExit = instance.waitUntilExit.bind(instance);
  instance.waitUntilExit = async () => {
    try {
      await originalWaitUntilExit();
    } finally {
      cleanupPaste();
      // TUI is shutting down (any path: /quit, Ctrl+D, Esc-Esc, etc.)
      // — release the local model server. Wired-pin persistence is
      // for invisible CLI exits between `kcode --print` calls, not
      // for the user explicitly closing the TUI. Verified 2026-05-10:
      // /quit was leaving 30+ GB Gemma resident.
      try {
        const { stopServer } = await import("../core/llama-server.js");
        await Promise.race([
          stopServer(),
          new Promise<void>((r) => setTimeout(r, 5000)),
        ]);
      } catch {
        /* non-fatal — process.on("exit") sync killer is the backstop */
      }
    }
  };

  return instance;
}
