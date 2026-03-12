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
