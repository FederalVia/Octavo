import { useEffect, useMemo, useRef, useState } from 'react';
import { Overlay } from './Modal';

export interface PaletteItem {
  id: string;
  label: string;
  /** Right-aligned hint (shortcut, folder…). */
  hint?: string;
  /** Extra words to match on. */
  keywords?: string;
  run: () => void;
}

interface Props {
  items: PaletteItem[];
  placeholder: string;
  onClose: () => void;
  emptyText?: string;
}

function score(q: string, item: PaletteItem): number {
  const text = `${item.label} ${item.keywords ?? ''}`.toLowerCase();
  if (!q) return 1;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const w of words) {
    const i = text.indexOf(w);
    if (i === -1) return -1;
    s += 100 - Math.min(90, i) + (i === 0 || text[i - 1] === ' ' ? 30 : 0);
  }
  return s;
}

/** A filterable list of actions (command palette, template picker, …). */
export function CommandPalette({ items, placeholder, onClose, emptyText }: Props) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus(), []);

  const results = useMemo(
    () =>
      items
        .map((it) => ({ it, s: score(query.trim(), it) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((r) => r.it),
    [items, query],
  );
  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    list.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const choose = (i: number) => {
    const it = results[i];
    if (!it) return;
    onClose();
    it.run();
  };

  return (
    <Overlay onClose={onClose}>
      <div className="switcher">
        <input
          ref={input}
          className="input switcher-input"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => (results.length ? (s + 1) % results.length : 0));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => (results.length ? (s - 1 + results.length) % results.length : 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(sel);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="switcher-list" ref={list}>
          {results.map((it, i) => (
            <div
              key={it.id}
              className={`switcher-item${i === sel ? ' selected' : ''}`}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
            >
              <span className="switcher-name">{it.label}</span>
              {it.hint && <span className="switcher-path">{it.hint}</span>}
            </div>
          ))}
          {results.length === 0 && <div className="switcher-empty muted">{emptyText ?? 'No matches'}</div>}
        </div>
      </div>
    </Overlay>
  );
}
