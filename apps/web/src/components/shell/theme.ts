export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'autodev-theme';

/** Runs before the page paints (inlined in the root layout), so a saved choice never flashes. */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem('${KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export function readTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

/** "system" follows the OS setting; light/dark override it (see globals.css). */
export function applyTheme(t: ThemeChoice) {
  const el = document.documentElement;
  if (t === 'system') delete el.dataset.theme;
  else el.dataset.theme = t;
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    // Private windows: the choice lasts for this page only.
  }
}
