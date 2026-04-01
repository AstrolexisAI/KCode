// KCode - React context for keybinding resolver
// Provides the KeybindingResolver to all child components via React context.

import type React from "react";
import { createContext, useContext, useMemo } from "react";
import {
  DEFAULT_BINDINGS,
  KeybindingResolver,
  loadUserBindings,
} from "../../core/keybindings/index.js";

interface KeybindingContextValue {
  resolver: KeybindingResolver;
}

const KeybindingCtx = createContext<KeybindingContextValue>({
  resolver: new KeybindingResolver(DEFAULT_BINDINGS),
});

export function useKeybindingContext(): KeybindingContextValue {
  return useContext(KeybindingCtx);
}

interface KeybindingProviderProps {
  children: React.ReactNode;
  /** Optional pre-built resolver (useful for testing) */
  resolver?: KeybindingResolver;
}

export function KeybindingProvider({ children, resolver: injected }: KeybindingProviderProps) {
  const resolver = useMemo(() => {
    if (injected) return injected;
    const userBindings = loadUserBindings();
    return new KeybindingResolver(DEFAULT_BINDINGS, userBindings);
  }, [injected]);

  const value = useMemo(() => ({ resolver }), [resolver]);

  return <KeybindingCtx.Provider value={value}>{children}</KeybindingCtx.Provider>;
}
