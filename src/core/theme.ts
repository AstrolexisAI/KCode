// KCode - Theme System
// Customizable color themes for terminal output

import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";

// ─── Types ──────────────────────────────────────────────────────

export interface Theme {
  primary: string;
  secondary: string;
  accent: string;
  error: string;
  warning: string;
  success: string;
  dimmed: string;
  info?: string;
  userPrompt: string;
  assistantText: string;
  codeBlock: string;
  toolUse: string;
  toolResult: string;
}

// ─── Built-in Themes ────────────────────────────────────────────

const builtinThemes: Record<string, Theme> = {
  default: {
    primary: "#7aa2f7",
    secondary: "#9ece6a",
    accent: "#bb9af7",
    error: "#f7768e",
    warning: "#e0af68",
    success: "#9ece6a",
    dimmed: "#565f89",
    userPrompt: "#c0caf5",
    assistantText: "#a9b1d6",
    codeBlock: "#414868",
    toolUse: "#7dcfff",
    toolResult: "#73daca",
  },

  dark: {
    primary: "#82aaff",
    secondary: "#c3e88d",
    accent: "#c792ea",
    error: "#ff5370",
    warning: "#ffcb6b",
    success: "#c3e88d",
    dimmed: "#546e7a",
    userPrompt: "#eeffff",
    assistantText: "#b2ccd6",
    codeBlock: "#1a1a2e",
    toolUse: "#89ddff",
    toolResult: "#80cbc4",
  },

  light: {
    primary: "#4078f2",
    secondary: "#50a14f",
    accent: "#a626a4",
    error: "#e45649",
    warning: "#c18401",
    success: "#50a14f",
    dimmed: "#a0a1a7",
    userPrompt: "#383a42",
    assistantText: "#696c77",
    codeBlock: "#f0f0f0",
    toolUse: "#0184bc",
    toolResult: "#4db5bd",
  },

  cyberpunk: {
    primary: "#ff00ff",
    secondary: "#00ffff",
    accent: "#ffff00",
    error: "#ff0040",
    warning: "#ffaa00",
    success: "#00ff88",
    dimmed: "#444466",
    userPrompt: "#ff66ff",
    assistantText: "#ccccff",
    codeBlock: "#1a0033",
    toolUse: "#00ffff",
    toolResult: "#00ff88",
  },

  monokai: {
    primary: "#66d9ef",
    secondary: "#a6e22e",
    accent: "#ae81ff",
    error: "#f92672",
    warning: "#e6db74",
    success: "#a6e22e",
    dimmed: "#75715e",
    userPrompt: "#f8f8f2",
    assistantText: "#f8f8f2",
    codeBlock: "#3e3d32",
    toolUse: "#66d9ef",
    toolResult: "#a6e22e",
  },

  solarized: {
    primary: "#268bd2",
    secondary: "#859900",
    accent: "#6c71c4",
    error: "#dc322f",
    warning: "#b58900",
    success: "#859900",
    dimmed: "#586e75",
    userPrompt: "#93a1a1",
    assistantText: "#839496",
    codeBlock: "#073642",
    toolUse: "#2aa198",
    toolResult: "#859900",
  },

  dracula: {
    primary: "#bd93f9",
    secondary: "#50fa7b",
    accent: "#ff79c6",
    error: "#ff5555",
    warning: "#f1fa8c",
    success: "#50fa7b",
    dimmed: "#6272a4",
    userPrompt: "#f8f8f2",
    assistantText: "#f8f8f2",
    codeBlock: "#282a36",
    toolUse: "#8be9fd",
    toolResult: "#50fa7b",
  },

  gruvbox: {
    primary: "#83a598",
    secondary: "#b8bb26",
    accent: "#d3869b",
    error: "#fb4934",
    warning: "#fabd2f",
    success: "#b8bb26",
    dimmed: "#928374",
    userPrompt: "#ebdbb2",
    assistantText: "#d5c4a1",
    codeBlock: "#3c3836",
    toolUse: "#83a598",
    toolResult: "#b8bb26",
  },

  nord: {
    primary: "#88c0d0",
    secondary: "#a3be8c",
    accent: "#b48ead",
    error: "#bf616a",
    warning: "#ebcb8b",
    success: "#a3be8c",
    dimmed: "#4c566a",
    userPrompt: "#eceff4",
    assistantText: "#d8dee9",
    codeBlock: "#3b4252",
    toolUse: "#88c0d0",
    toolResult: "#a3be8c",
  },

  catppuccin: {
    primary: "#89b4fa",
    secondary: "#a6e3a1",
    accent: "#cba6f7",
    error: "#f38ba8",
    warning: "#f9e2af",
    success: "#a6e3a1",
    dimmed: "#585b70",
    userPrompt: "#cdd6f4",
    assistantText: "#bac2de",
    codeBlock: "#313244",
    toolUse: "#89dceb",
    toolResult: "#a6e3a1",
  },

  matrix: {
    primary: "#00ff00",
    secondary: "#00cc00",
    accent: "#00ff66",
    error: "#ff0000",
    warning: "#ccff00",
    success: "#00ff00",
    dimmed: "#005500",
    userPrompt: "#00ff00",
    assistantText: "#00cc00",
    codeBlock: "#001100",
    toolUse: "#00ff99",
    toolResult: "#00ff00",
  },
};

// ─── State ──────────────────────────────────────────────────────

const CUSTOM_THEME_PATH = join(homedir(), ".kcode", "theme.json");

let currentThemeName = "default";
let currentTheme: Theme = builtinThemes["default"]!;

// ─── Custom Theme Loading ───────────────────────────────────────

function loadCustomTheme(): Theme | null {
  try {
    if (!existsSync(CUSTOM_THEME_PATH)) return null;
    const raw = readFileSync(CUSTOM_THEME_PATH, "utf-8");
    const parsed = JSON.parse(raw);

    // Validate that all required keys are present and are strings
    const requiredKeys: (keyof Theme)[] = [
      "primary", "secondary", "accent", "error", "warning", "success",
      "dimmed", "userPrompt", "assistantText", "codeBlock", "toolUse", "toolResult",
    ];

    for (const key of requiredKeys) {
      if (typeof parsed[key] !== "string") return null;
    }

    return parsed as Theme;
  } catch {
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Get the current active theme.
 */
export function getTheme(): Theme {
  return currentTheme;
}

/**
 * Set the active theme by name.
 * Accepts "default", "dark", "light", or "custom" (loads from ~/.kcode/theme.json).
 */
export function setTheme(name: string): void {
  if (name === "custom") {
    const custom = loadCustomTheme();
    if (custom) {
      currentThemeName = "custom";
      currentTheme = custom;
      return;
    }
    // Fall back to default if custom theme is invalid or missing
    currentThemeName = "default";
    currentTheme = builtinThemes["default"]!;
    return;
  }

  const theme = builtinThemes[name];
  if (theme) {
    currentThemeName = name;
    currentTheme = theme;
  }
  // Silently ignore unknown theme names, keep current theme
}

/**
 * Get the name of the currently active theme.
 */
export function getCurrentThemeName(): string {
  return currentThemeName;
}

/**
 * Get a list of all available built-in theme names.
 */
export function getAvailableThemes(): string[] {
  const names = Object.keys(builtinThemes);
  if (existsSync(CUSTOM_THEME_PATH)) {
    names.push("custom");
  }
  return names;
}
