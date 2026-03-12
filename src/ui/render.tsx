// KCode - Ink render entry point
// Initializes and renders the Ink application

import React from "react";
import { render } from "ink";
import App from "./App.js";
import type { ConversationManager } from "../core/conversation.js";
import type { KCodeConfig } from "../core/types.js";
import type { ToolRegistry } from "../core/tool-registry.js";

interface StartUIOptions {
  config: KCodeConfig;
  conversationManager: ConversationManager;
  tools: ToolRegistry;
}

export function startUI({ config, conversationManager, tools }: StartUIOptions) {
  const instance = render(
    <App config={config} conversationManager={conversationManager} tools={tools} />,
    {
      exitOnCtrlC: true,
    },
  );

  return instance;
}
