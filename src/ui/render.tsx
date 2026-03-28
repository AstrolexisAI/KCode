// KCode - Ink render entry point
// Initializes and renders the Ink application with bracketed paste support

import React from "react";
import { render } from "ink";
import App from "./App.js";
import { ThemeProvider } from "./ThemeContext.js";
import { enableBracketedPaste } from "./paste-stream.js";
import type { ConversationManager } from "../core/conversation.js";
import type { KCodeConfig } from "../core/types.js";
import type { ToolRegistry } from "../core/tool-registry.js";

interface StartUIOptions {
  config: KCodeConfig;
  conversationManager: ConversationManager;
  tools: ToolRegistry;
}

export function startUI({ config, conversationManager, tools }: StartUIOptions) {
  // Enable bracketed paste mode: intercepts paste sequences from the terminal
  // so that pasted text arrives as a single atomic event instead of being
  // broken into individual character/key events by Ink's useInput.
  const { stream: pasteStream, cleanup: cleanupPaste } = enableBracketedPaste();
  process.stdin.pipe(pasteStream);

  const instance = render(
    <ThemeProvider>
      <App
        config={config}
        conversationManager={conversationManager}
        tools={tools}
        initialSessionName={config.sessionName}
        pasteStream={pasteStream}
      />
    </ThemeProvider>,
    {
      exitOnCtrlC: true,
      stdin: pasteStream as unknown as NodeJS.ReadStream,
    },
  );

  // Cleanup bracketed paste mode on exit
  const originalWaitUntilExit = instance.waitUntilExit.bind(instance);
  instance.waitUntilExit = async () => {
    try {
      await originalWaitUntilExit();
    } finally {
      cleanupPaste();
      process.stdin.unpipe(pasteStream);
    }
  };

  return instance;
}
