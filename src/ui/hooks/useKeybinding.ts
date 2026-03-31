// KCode - useKeybinding React hook
// Subscribes to a specific action from the KeybindingResolver and invokes a callback.

import { useEffect } from "react";
import { useKeybindingContext } from "../components/KeybindingContext.js";

/**
 * React hook that listens for a keybinding action and calls the callback when triggered.
 *
 * Usage:
 *   useKeybinding('toggle.theme', () => cycleTheme());
 *   useKeybinding('search.messages', () => setSearchOpen(true));
 */
export function useKeybinding(
  action: string,
  callback: () => void,
  deps: unknown[] = [],
): void {
  const { resolver } = useKeybindingContext();

  useEffect(() => {
    const handler = (resolvedAction: string) => {
      if (resolvedAction === action) callback();
    };
    resolver.on("action", handler);
    return () => {
      resolver.off("action", handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, resolver, ...deps]);
}
