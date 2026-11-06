import { useCallback, useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { api, ApiError, type NoteSummary } from '../api';

interface Readable {
  url: string;
  title: string;
  siteName?: string;
  byline?: string;
  html: string;
}

const normalize = (raw: string) => {
  const t = raw.trim();
  if (!t) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
};

/**
 * Read web pages without leaving Octavo. Reader mode (the default) fetches the article through
 * your Octavo server and shows it cleanly; Live shows the real page where the site allows it
 * (the desktop app allows almost all). Save to vault clips the article into a note.
 */
export function WebViewer({ url: initial, onClose, onSaved }: { url: string; onClose: () => void; onSaved: (note: NoteSummary) => void }) {
  const [history, setHistory] = useState<string[]>([normalize(initial)]);
  const [index, setIndex] = useState(0);
  const url = history[index];
  const [input, setInput] = useState(url);
  const [mode, setMode] = useState<'reader' | 'live'>(() => {
    try {
      return (localStorage.getItem('octavo.webMode') as 'reader' | 'live') || 'reader';
    } catch {
      return 'reader';
    }
  });
  const [page, setPage] = useState<Readable | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const body = useRef<HTMLDivElement>(null);

  const go = useCallback(
    (next: string) => {
      const u = normalize(next);
      if (!u || u === url) return;
      setHistory((h) => [...h.slice(0, index + 1), u]);
      setIndex((i) => i + 1);
    },
    [url, index],
  );

  useEffect(() => {
    setInput(url);
    setSaved('');
    if (mode !== 'reader') return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setPage(null);
    api
      .webRead(url)
      .then((p) => {
        if (cancelled) return;
        setPage(p);
        body.current?.scrollTo(0, 0);
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : `Couldn’t load the page: ${(err as Error).message}`))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [url, mode]);

  useEffect(() => {
    try {
      localStorage.setItem('octavo.webMode', mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  const save = async () => {
    setSaving(true);
    try {
      const note = await api.webClip(page?.url ?? url);
      setSaved(note.path);
      onSaved(note);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const html = page ? DOMPurify.sanitize(page.html, { FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style'] }) : '';

  return (
    <div
      className="web-viewer"
      role="dialog"
      aria-label="Web viewer"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="wv-bar">
        <button onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} aria-label="Back" title="Back">
          ←
        </button>
        <button onClick={() => setIndex((i) => Math.min(history.length - 1, i + 1))} disabled={index >= history.length - 1} aria-label="Forward" title="Forward">
          →
        </button>
        <form
          className="wv-url"
          onSubmit={(e) => {
            e.preventDefault();
            go(input);
          }}
        >
          <input value={input} onChange={(e) => setInput(e.target.value)} aria-label="Web address" spellCheck={false} inputMode="url" />
        </form>
        <div className="wv-modes" role="group" aria-label="View">
          <button className={mode === 'reader' ? 'active' : ''} onClick={() => setMode('reader')} title="Just the article, fetched by Octavo">
            Reader
          </button>
          <button className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')} title="The real page (some sites refuse to be shown inside other apps)">
            Live
          </button>
        </div>
        <button onClick={save} disabled={saving || !!saved} title="Save the article as a note in Clippings/">
          {saved ? 'Saved ✓' : saving ? 'Saving…' : (
            <>
              Save<span className="wv-wide">{"\u00a0"}to vault</span>
            </>
          )}
        </button>
        <a className="wv-external" href={url} target="_blank" rel="noopener noreferrer" title="Open in your browser" aria-label="Open in your browser">
          ↗
        </a>
        <button className="wv-close" onClick={onClose} aria-label="Close web viewer" title="Close">
          ✕
        </button>
      </div>
      {mode === 'live' ? (
        <iframe key={url} className="wv-frame" src={url} title="Web page" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />
      ) : (
        <div
          className="wv-reader"
          ref={body}
          onClick={(e) => {
            const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
            if (!a) return;
            e.preventDefault();
            const href = a.getAttribute('href') ?? '';
            if (/^https?:/i.test(href)) {
              if (e.metaKey || e.ctrlKey) window.open(href, '_blank', 'noopener');
              else go(href);
            } else if (href.startsWith('mailto:')) window.open(href);
          }}
        >
          {loading && <div className="muted wv-status">Loading…</div>}
          {error && (
            <div className="wv-status">
              <p>{error}</p>
              <p className="muted small">
                Try <button className="link" onClick={() => setMode('live')}>Live</button> or{' '}
                <a href={url} target="_blank" rel="noopener noreferrer">
                  open it in your browser
                </a>
                .
              </p>
            </div>
          )}
          {page && (
            <article className="markdown wv-article">
              <div className="wv-meta">{[page.siteName ?? new URL(page.url).hostname, page.byline].filter(Boolean).join(' · ')}</div>
              {!/^\s*<h1[\s>]/i.test(html) && <h1>{page.title}</h1>}
              <div dangerouslySetInnerHTML={{ __html: html }} />
            </article>
          )}
        </div>
      )}
      {saved && <div className="wv-toast">Saved to {saved}</div>}
    </div>
  );
}
