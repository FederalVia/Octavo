/** Theme and accent colour (per device) and CSS snippets (per vault). */
export type ThemeChoice = 'dark' | 'light' | 'system';

export const ACCENTS: { key: string; label: string; color: string }[] = [
  { key: 'gold', label: 'Gold', color: '#dcca9f' },
  { key: 'blue', label: 'Blue', color: '#8fb4e6' },
  { key: 'green', label: 'Green', color: '#9fd0a8' },
  { key: 'purple', label: 'Purple', color: '#c3a6e8' },
  { key: 'rose', label: 'Rose', color: '#e8a6b4' },
  { key: 'orange', label: 'Orange', color: '#e8b98f' },
];
/** Darker versions for the light theme, so the accent stays readable on white. */
const LIGHT_ACCENTS: Record<string, string> = { gold: '#9a7b2f', blue: '#2f6db5', green: '#2f8a4a', purple: '#7a4fb5', rose: '#b5455f', orange: '#b5652f' };

const read = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

export const getTheme = () => read('octavo.theme', 'dark') as ThemeChoice;
export const getAccent = () => read('octavo.accent', 'gold');

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

let systemQuery: MediaQueryList | null = null;

/** Apply the saved theme and accent to the page. */
export function applyAppearance(theme = getTheme(), accent = getAccent()) {
  write('octavo.theme', theme);
  write('octavo.accent', accent);
  const dark = theme === 'dark' || (theme === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  const base = ACCENTS.find((a) => a.key === accent) ?? ACCENTS[0];
  const color = dark ? base.color : LIGHT_ACCENTS[base.key] ?? base.color;
  const [r, g, b] = hexToRgb(color);
  root.style.setProperty('--accent', color);
  root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.4)`);
  root.style.setProperty('--selection', `rgba(${r}, ${g}, ${b}, 0.25)`);
  // The brain views always use the dark palette, with the dark accent.
  const [dr, dg, db] = hexToRgb(base.color);
  root.style.setProperty('--space-accent', base.color);
  root.style.setProperty('--space-accent-soft', `rgba(${dr}, ${dg}, ${db}, 0.4)`);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#141317' : '#f6f4ef');
  if (theme === 'system' && !systemQuery) {
    systemQuery = matchMedia('(prefers-color-scheme: light)');
    systemQuery.addEventListener('change', () => getTheme() === 'system' && applyAppearance());
  }
}

/** Replace the page's CSS snippets. */
export function applySnippets(css: { name: string; css: string }[]) {
  document.querySelectorAll('style[data-octavo-snippet]').forEach((el) => el.remove());
  for (const s of css) {
    const el = document.createElement('style');
    el.dataset.octavoSnippet = s.name;
    el.textContent = s.css;
    document.head.append(el);
  }
}
