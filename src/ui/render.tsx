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
    }
  };

  return instance;
}
