import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type NoteDetail, type SearchResult, type TagCount, type GraphData } from '../api';
import { GraphView } from './GraphView';

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
}: {
  query: string;
  setQuery: (q: string) => void;
  onOpen: (path: string, line?: number) => void;
  focusKey: number;
  refreshKey: number;
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
        {results.length > 0 && <div className="muted small result-count">{results.length} result{results.length === 1 ? '' : 's'}</div>}
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

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="section">
      <div className="section-title" onClick={() => setOpen(!open)}>
        <span className={`chevron${open ? ' open' : ''}`}>›</span>
        {title}
        {count != null && <span className="badge">{count}</span>}
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

export function RightPanel({
  note,
  graph,
  onOpen,
  onOpenLink,
  onTag,
  onHeading,
}: {
  note: NoteDetail | null;
  graph: GraphData | null;
  onOpen: (path: string, line?: number) => void;
  onOpenLink: (target: string) => void;
  onTag: (tag: string) => void;
  onHeading: (line: number, text: string) => void;
}) {
  if (!note) return <div className="right-panel empty muted">No note open</div>;
  const outgoing = note.links.filter((l, i, arr) => arr.findIndex((x) => (x.path ?? x.target) === (l.path ?? l.target)) === i);
  return (
    <div className="right-panel">
      <Section title="Local graph">
        <div className="local-graph">
          <GraphView
            data={graph}
            currentPath={note.path}
            compact
            onOpen={(p, unresolved) => (unresolved ? onOpenLink(unresolved) : onOpen(p))}
          />
        </div>
      </Section>
      <Section title="Backlinks" count={note.backlinks.length}>
        {note.backlinks.length === 0 && <div className="muted small">No backlinks</div>}
        {note.backlinks.map((b) => (
          <div key={b.path} className="backlink">
            <div className="backlink-title" onClick={() => onOpen(b.path)}>
              {b.name}
            </div>
            {b.context.map((c) => (
              <div key={c.line} className="backlink-context" onClick={() => onOpen(b.path, c.line)}>
                {c.text}
              </div>
            ))}
          </div>
        ))}
      </Section>
      <Section title="Outgoing links" count={outgoing.length}>
        {outgoing.length === 0 && <div className="muted small">No links</div>}
        {outgoing.map((l) => (
          <div
            key={l.path ?? l.target}
            className={`link-row${l.path ? '' : ' unresolved'}`}
            onClick={() => (l.path ? onOpen(l.path) : onOpenLink(l.target))}
            title={l.path ? l.path : 'Not created yet. Click to create'}
          >
            {l.path ? l.path.replace(/\.md$/, '').split('/').pop() : l.target}
          </div>
        ))}
      </Section>
      {note.tags.length > 0 && (
        <Section title="Tags" count={note.tags.length}>
          <div className="tag-list">
            {note.tags.map((t) => (
              <span key={t} className="tag" onClick={() => onTag(t)}>
                #{t}
              </span>
            ))}
          </div>
        </Section>
      )}
      {note.headings.length > 0 && (
        <Section title="Outline">
          {note.headings.map((h) => (
            <div
              key={`${h.line}`}
              className="outline-item"
              style={{ paddingLeft: (h.level - 1) * 12 }}
              onClick={() => onHeading(h.line, h.text)}
            >
              {h.text}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
