import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type SearchResult, type TagCount } from '../api';

function highlight(text: string, query: string): ReactNode {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/^"|"$/g, ''))
    .filter((t) => t && !t.includes(':') && !t.startsWith('#'));
  if (!terms.length) return text;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

export function SearchPanel({
  query,
  setQuery,
  onOpen,
  focusKey,
  refreshKey,
  onBookmark,
}: {
  query: string;
  setQuery: (q: string) => void;
  onOpen: (path: string, line?: number) => void;
  focusKey: number;
  refreshKey: number;
  onBookmark?: (query: string) => void;
}) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      api
        .search(query)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 150);
    return () => clearTimeout(t);
  }, [query, refreshKey]);

  return (
    <div className="panel search-panel">
      <input
        ref={input}
        className="input"
        placeholder='Search… (tag:x, path:y, "phrase")'
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="panel-scroll">
        {query.trim() && !loading && results.length === 0 && <div className="empty muted">No results</div>}
        {results.length > 0 && (
          <div className="muted small result-count">
            {results.length} result{results.length === 1 ? '' : 's'}
            {onBookmark && (
              <button className="link-btn" onClick={() => onBookmark(query)}>
                ☆ Bookmark this search
              </button>
            )}
          </div>
        )}
        {results.map((r) => (
          <div key={r.path} className="search-result">
            <div className="search-title" onClick={() => onOpen(r.path)}>
              {r.name}
              {r.path.includes('/') && <span className="muted small"> {r.path.slice(0, r.path.lastIndexOf('/'))}</span>}
            </div>
            {r.snippets.map((s) => (
              <div key={s.line} className="search-snippet" onClick={() => onOpen(r.path, s.line)}>
                {highlight(s.text, query)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TagsPanel({ onSelect, refreshKey }: { onSelect: (tag: string) => void; refreshKey: number }) {
  const [tags, setTags] = useState<TagCount[]>([]);
  useEffect(() => {
    api
      .tags()
      .then((r) => setTags(r.tags))
      .catch(() => setTags([]));
  }, [refreshKey]);
  return (
    <div className="panel">
      <div className="panel-scroll">
        {tags.length === 0 && <div className="empty muted">No tags yet. Add #tags to notes.</div>}
        {tags.map((t) => (
          <div key={t.tag} className="tag-row" onClick={() => onSelect(t.tag)}>
            <span className="tag">#{t.tag}</span>
            <span className="muted small">{t.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- bookmarks

export function BookmarksPanel({
  bookmarks,
  onOpenNote,
  onSearch,
  onRemove,
  onAddUrl,
}: {
  bookmarks: import('../api').Bookmark[];
  onOpenNote: (path: string, heading?: string) => void;
  onSearch: (query: string) => void;
  onRemove: (index: number) => void;
  onAddUrl: () => void;
}) {
  return (
    <div className="panel">
      <div className="panel-scroll">
        {bookmarks.length === 0 && (
          <div className="empty muted">
            No bookmarks yet. Use ☆ on a note, “Bookmark this search” in Search, or add a link below.
          </div>
        )}
        {bookmarks.map((b, i) => (
          <div key={i} className="bookmark-row">
            <span className="bookmark-icon">{b.type === 'note' ? '☰' : b.type === 'search' ? '⌕' : '↗'}</span>
            <button
              className="bookmark-label"
              onClick={() => {
                if (b.type === 'note') onOpenNote(b.path, b.heading);
                else if (b.type === 'search') onSearch(b.query);
                else window.open(b.url, '_blank', 'noopener,noreferrer');
              }}
              title={b.type === 'note' ? b.path : b.type === 'search' ? b.query : b.url}
            >
              {b.title ??
                (b.type === 'note'
                  ? b.path.replace(/\.md$/, '').split('/').pop() + (b.heading ? ` › ${b.heading}` : '')
                  : b.type === 'search'
                    ? b.query
                    : b.url.replace(/^https?:\/\//, ''))}
            </button>
            <button className="icon-btn small-btn" title="Remove bookmark" onClick={() => onRemove(i)}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <button className="btn" onClick={onAddUrl}>
        ＋ Bookmark a web link
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- tasks

const DUE_TOKEN = /\s*(?:📅|🗓️?|\bdue::?)\s*\d{4}-\d{2}-\d{2}\b/giu;

function localIso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Today", "Tomorrow", "Mon 10 Nov", "3 days ago"… */
export function dueLabel(due: string, today = localIso(new Date())): string {
  const [y, m, d] = due.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const days = Math.round((new Date(y, m - 1, d).getTime() - new Date(ty, tm - 1, td).getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  const date = new Date(y, m - 1, d);
  if (days < 0 && days >= -14) return `${-days} days ago`;
  return date.toLocaleDateString(undefined, { weekday: days > 0 && days < 7 ? 'long' : 'short', day: 'numeric', month: 'short', ...(y !== ty ? { year: 'numeric' } : {}) });
}

type TaskT = import('../api').Task;

export function TasksPanel({
  refreshKey,
  onOpen,
}: {
  refreshKey: number;
  onOpen: (path: string, line: number) => void;
}) {
  const [tasks, setTasks] = useState<TaskT[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [byDate, setByDate] = useState(() => {
    try {
      return localStorage.getItem('octavo.tasksByDate') === '1';
    } catch {
      return false;
    }
  });
  const load = () => api.tasks(showDone).then((r) => setTasks(r.tasks)).catch(() => setTasks([]));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, showDone]);
  const setMode = (v: boolean) => {
    setByDate(v);
    try {
      localStorage.setItem('octavo.tasksByDate', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const today = localIso(new Date());
  const groups: { key: string; title: string; path?: string; className?: string; list: TaskT[] }[] = [];
  if (byDate) {
    const week = localIso(new Date(Date.now() + 7 * 86400000));
    const buckets: [string, string, (t: TaskT) => boolean][] = [
      ['Overdue', 'overdue', (t) => !!t.due && t.due < today],
      ['Today', 'today', (t) => t.due === today],
      ['Next 7 days', '', (t) => !!t.due && t.due > today && t.due <= week],
      ['Later', '', (t) => !!t.due && t.due > week],
      ['No date', '', (t) => !t.due],
    ];
    for (const [title, className, test] of buckets) {
      const list = tasks.filter(test).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? '') || a.path.localeCompare(b.path) || a.line - b.line);
      if (list.length) groups.push({ key: title, title, className, list });
    }
  } else {
    const byPath = new Map<string, TaskT[]>();
    for (const t of tasks) {
      if (!byPath.has(t.path)) byPath.set(t.path, []);
      byPath.get(t.path)!.push(t);
    }
    for (const [path, list] of byPath) groups.push({ key: path, title: list[0].name, path, list });
  }

  return (
    <div className="panel">
      <div className="panel-toggle task-toolbar">
        <div className="seg" role="group" aria-label="Group tasks">
          <button className={`seg-btn${byDate ? '' : ' active'}`} onClick={() => setMode(false)}>
            By note
          </button>
          <button className={`seg-btn${byDate ? ' active' : ''}`} onClick={() => setMode(true)}>
            By date
          </button>
        </div>
        <label className="muted small">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show completed
        </label>
      </div>
      <div className="panel-scroll">
        {tasks.length === 0 && <div className="empty muted">No {showDone ? '' : 'open '}tasks. Write `- [ ] something` in any note.</div>}
        {byDate && tasks.length > 0 && !tasks.some((t) => t.due) && (
          <div className="empty muted small">Add a due date to a task with 📅 and a date, e.g. `📅 2026-11-10`, or type /due in the editor.</div>
        )}
        {groups.map((g) => (
          <div key={g.key} className={`task-group${g.className ? ` ${g.className}` : ''}`}>
            <div className={`search-title${g.path ? '' : ' static'}`} onClick={() => g.path && onOpen(g.path, g.list[0].line)}>
              {g.title}
              {!g.path && <span className="muted small"> · {g.list.length}</span>}
            </div>
            {g.list.map((t) => {
              const done = t.status === 'x' || t.status === 'X' || t.status === '-';
              const overdue = !done && !!t.due && t.due < today;
              return (
                <div key={`${t.path}:${t.line}`} className={`task-row${done ? ' done' : ''}`}>
                  <span
                    className="task-box interactive"
                    data-status={t.status}
                    role="checkbox"
                    aria-checked={done}
                    tabIndex={0}
                    onClick={() => api.setTask(t.path, t.line).then(load)}
                  >
                    {t.status === ' ' || t.status === 'x' || t.status === 'X' ? '' : t.status}
                  </span>
                  <span className="task-text" onClick={() => onOpen(t.path, t.line)}>
                    {t.text.replace(DUE_TOKEN, '').trim() || t.text}
                    {t.due && (
                      <span className={`task-due${overdue ? ' overdue' : t.due === today ? ' today' : ''}`} title={t.due}>
                        📅 {dueLabel(t.due, today)}
                      </span>
                    )}
                    {byDate && <span className="task-note muted"> · {t.name}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- insights

export function InsightsPanel({
  refreshKey,
  onOpen,
  onCreate,
}: {
  refreshKey: number;
  onOpen: (path: string) => void;
  onCreate: (name: string) => void;
}) {
  const [data, setData] = useState<import('../api').Insights | null>(null);
  useEffect(() => {
    api.insights().then(setData).catch(() => setData(null));
  }, [refreshKey]);
  if (!data) return <div className="panel empty muted">Loading…</div>;
  return (
    <div className="panel">
      <div className="panel-scroll">
        <Section title="Orphans" count={data.orphans.length} hint="No other note links to these">
          {data.orphans.map((n) => (
            <div key={n.path} className="link-row" onClick={() => onOpen(n.path)} title={n.path}>
              {n.name}
            </div>
          ))}
        </Section>
        <Section title="Dead ends" count={data.deadEnds.length} hint="These don't link to anything">
          {data.deadEnds.map((n) => (
            <div key={n.path} className="link-row" onClick={() => onOpen(n.path)} title={n.path}>
              {n.name}
            </div>
          ))}
        </Section>
        <Section title="Not written yet" count={data.unresolved.length} hint="Linked to, but the note doesn't exist">
          {data.unresolved.map((u) => (
            <div key={u.target} className="link-row unresolved" onClick={() => onCreate(u.target)} title={`Linked from ${u.from.join(', ')}`}>
              {u.target} <span className="muted small">×{u.from.length}</span>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, count, hint, children }: { title: string; count: number; hint: string; children: ReactNode }) {
  const [open, setOpen] = useState(count > 0 && count < 40);
  return (
    <div className="section">
      <div className="section-title" onClick={() => setOpen(!open)} title={hint}>
        <span className={`chevron${open ? ' open' : ''}`}>›</span>
        {title}
        <span className="badge">{count}</span>
      </div>
      {open && <div className="section-body">{count === 0 ? <div className="muted small">None 🎉</div> : children}</div>}
    </div>
  );
}
