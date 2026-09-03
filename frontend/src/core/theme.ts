import { useEffect, useState } from 'react';

// Which theme is active. The palettes themselves live in theme.css, keyed by the id below on
// <html data-theme>; this module only picks one and remembers the choice.

export interface ThemeSpec {
  id: string;
  label: string;
  hint: string;
}

export const THEMES: ThemeSpec[] = [
  { id: 'charcoal', label: 'Charcoal', hint: 'Neutral dark grey (default)' },
  { id: 'carbon', label: 'Carbon', hint: 'Near-black, highest contrast' },
  { id: 'midnight', label: 'Midnight', hint: 'Cool blue-black' },
  { id: 'mocha', label: 'Mocha', hint: 'Warm dark, amber accent' },
];

export const DEFAULT_THEME = THEMES[0].id;

const KEY = 'webcip.theme';

export function applyTheme(id: string): void {
  const theme = THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode / quota — the choice just doesn't persist */
  }
}

export function storedTheme(): string {
  try {
    const id = localStorage.getItem(KEY);
    if (id && THEMES.some((t) => t.id === id)) return id;
  } catch {
    /* unavailable storage */
  }
  return DEFAULT_THEME;
}

/** Active theme id plus a setter that applies and persists it. */
export function useTheme(): [string, (id: string) => void] {
  const [theme, setTheme] = useState(storedTheme);
  useEffect(() => applyTheme(theme), [theme]);
  return [theme, setTheme];
}
