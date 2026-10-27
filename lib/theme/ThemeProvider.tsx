'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { resolveTheme, THEME_COOKIE, THEME_STORAGE_KEY, type ThemePreference } from './shared';

const ThemeContext = createContext<{ theme: ThemePreference; setTheme: (theme: ThemePreference) => void }>({
  theme: 'system', setTheme: () => undefined,
});

/** Cookie-backed SSR avoids a light flash; system appearance is resolved directly by CSS. */
export function ThemeProvider({ initialTheme, children }: { initialTheme: ThemePreference; children: ReactNode }) {
  const [theme, updateTheme] = useState(initialTheme);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = resolveTheme(event.newValue);
      document.documentElement.dataset.theme = next;
      updateTheme(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo(() => ({ theme, setTheme: (requested: ThemePreference) => {
    const next = resolveTheme(requested);
    document.documentElement.dataset.theme = next;
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* Cookie still preserves the preference. */ }
    updateTheme(next);
  } }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() { return useContext(ThemeContext); }
