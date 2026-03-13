// KCode - Theme React Context
// Provides theme colors to all UI components via React context

import React, { createContext, useContext, useState, useCallback } from "react";
import type { Theme } from "../core/theme.js";
import { getTheme, setTheme as setCoreTheme, getCurrentThemeName } from "../core/theme.js";

interface ThemeContextValue {
  theme: Theme;
  themeName: string;
  switchTheme: (name: string) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: getTheme(),
  themeName: getCurrentThemeName(),
  switchTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [themeName, setThemeName] = useState<string>(getCurrentThemeName());

  const switchTheme = useCallback((name: string) => {
    setCoreTheme(name);
    setThemeState(getTheme());
    setThemeName(getCurrentThemeName());
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, themeName, switchTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
