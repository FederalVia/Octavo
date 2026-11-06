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
