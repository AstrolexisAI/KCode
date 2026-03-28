// KCode - Ink render entry point
// Initializes and renders the Ink application with paste interception

import React from "react";
import { render } from "ink";
import App from "./App.js";
import { ThemeProvider } from "./ThemeContext.js";
import { installPasteInterceptor } from "./paste-stream.js";
import { invokePasteHandler } from "./paste-handler.js";
import type { ConversationManager } from "../core/conversation.js";
import type { KCodeConfig } from "../core/types.js";
import type { ToolRegistry } from "../core/tool-registry.js";

interface StartUIOptions {
  config: KCodeConfig;
  conversationManager: ConversationManager;
  tools: ToolRegistry;
}

export function startUI({ config, conversationManager, tools }: StartUIOptions) {
  // Install paste interceptor on stdin BEFORE Ink sets up its input handler.
  // This monkey-patches stdin.emit to detect paste content at the byte level
  // and prevent Ink from seeing it (avoiding character-by-character corruption).
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

  // Cleanup paste interceptor on exit
  const originalWaitUntilExit = instance.waitUntilExit.bind(instance);
  instance.waitUntilExit = async () => {
    try {
      await originalWaitUntilExit();
    } finally {
      cleanupPaste();
    }
  };

  return instance;
}
