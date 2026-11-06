/** Keyboard shortcuts as strings like "Mod+Shift+K" (Mod = Ctrl, or ⌘ on a Mac). */
export type Hotkeys = Record<string, string>;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The combo for a key press, or null for a lone modifier key. */
export function comboFromEvent(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const key = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(key)) return null;
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  // Use the physical key for letters and digits so Alt/Shift combos are stable across layouts.
  let name = key.length === 1 ? key.toUpperCase() : key;
  if (/^Key[A-Z]$/.test(e.code)) name = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) name = e.code.slice(5);
  if (name === ' ') name = 'Space';
  parts.push(name);
  return parts.join('+');
}

/** "Mod+Shift+K" → "Ctrl+Shift+K" (or "⌘⇧K" on a Mac). */
export function formatCombo(combo: string): string {
  if (!isMac) return combo.replace(/\bMod\b/g, 'Ctrl');
  return combo
    .split('+')
    .map((p) => ({ Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' })[p] ?? p)
    .join('');
}

/** A shortcut needs a modifier (or is a function key), so plain typing never triggers it. */
export function isUsableCombo(combo: string): boolean {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  return parts.length > 1 || /^F\d{1,2}$/.test(key);
}
