import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteSummary } from '../api';
import { Overlay } from './Modal';

interface Props {
  notes: NoteSummary[];
  onOpen: (path: string) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}

/** Subsequence fuzzy score; higher is better, -1 = no match. */
function fuzzy(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx !== -1) return 1000 - idx * 2 - (t.length - q.length) * 0.5 + (idx === 0 || t[idx - 1] === '/' ? 200 : 0);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score;
}

export function QuickSwitcher({ notes, onOpen, onCreate, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);

  const results = useMemo(() => {
    if (!query.trim()) return [...notes].sort((a, b) => b.mtime - a.mtime).slice(0, 50);
    return notes
      .map((n) => ({ n, s: Math.max(fuzzy(query, n.name) + 50, fuzzy(query, n.path)) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((r) => r.n);
  }, [notes, query]);

  const exact = notes.some((n) => n.name.toLowerCase() === query.trim().toLowerCase() || n.path.toLowerCase() === query.trim().toLowerCase());
  const canCreate = query.trim() !== '' && !exact;
  const total = results.length + (canCreate ? 1 : 0);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    list.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const choose = (i: number) => {
    if (i < results.length) onOpen(results[i].path);
    else if (canCreate) onCreate(query.trim());
    onClose();
  };

  return (
    <Overlay onClose={onClose}>
      <div className="switcher">
        <input
          ref={input}
          className="input switcher-input"
          placeholder="Find or create a note…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => (total ? (s + 1) % total : 0));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => (total ? (s - 1 + total) % total : 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey && canCreate) {
                onCreate(query.trim());
                onClose();
              } else if (total) choose(sel);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="switcher-list" ref={list}>
          {results.map((n, i) => (
            <div
              key={n.path}
              className={`switcher-item${i === sel ? ' selected' : ''}`}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
            >
              <span className="switcher-name">{n.name}</span>
              {n.folder && <span className="switcher-path">{n.folder}</span>}
            </div>
          ))}
          {canCreate && (
            <div
              className={`switcher-item create${sel === results.length ? ' selected' : ''}`}
              onMouseEnter={() => setSel(results.length)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(results.length);
              }}
            >
              <span className="switcher-name">Create “{query.trim()}”</span>
              <span className="switcher-path">Shift+Enter</span>
            </div>
          )}
          {total === 0 && <div className="switcher-empty muted">No notes yet</div>}
        </div>
      </div>
    </Overlay>
  );
}
