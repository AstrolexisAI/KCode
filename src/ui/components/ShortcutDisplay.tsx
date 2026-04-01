// KCode - ShortcutDisplay component
// Renders a keybinding in platform-aware format (Cmd on macOS, Ctrl on Linux/Windows).

import { Text } from "ink";
import React from "react";
import { formatKeyChord } from "../../core/keybindings/parser.js";
import { useKeybindingContext } from "./KeybindingContext.js";

interface ShortcutDisplayProps {
  /** The action name to look up and display its shortcut */
  action: string;
}

/**
 * Renders the keyboard shortcut for a given action.
 * Shows platform-appropriate modifier symbols.
 *
 * Usage: <ShortcutDisplay action="toggle.theme" />
 * Renders: "Ctrl+K Ctrl+T" on Linux, "⌃K ⌃T" on macOS
 */
export default function ShortcutDisplay({ action }: ShortcutDisplayProps) {
  const { resolver } = useKeybindingContext();
  const platform = process.platform as "darwin" | "linux" | "win32";

  const binding = resolver.getBindingForAction(action);
  if (!binding) return null;

  return <Text dimColor>{formatKeyChord(binding.chord, platform)}</Text>;
}
