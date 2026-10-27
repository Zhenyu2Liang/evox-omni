export const THEME_COOKIE = 'banking_theme';
export const THEME_STORAGE_KEY = 'banking-agent:theme';
export type ThemePreference = 'system' | 'light' | 'dark';

export function resolveTheme(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}
