import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { createRenderer, extractSection, slugify, splitFrontmatter } from '../markdown';

interface Props {
  content: string;
  path: string;
  exists: (target: string) => boolean;
  /** Changes whenever the set of note names changes, to restyle unresolved links. */
  namesKey: string;
  onOpenLink: (target: string, heading?: string, opts?: { markdown?: boolean }) => void;
  onTag: (tag: string) => void;
  onToggleTask?: (index: number) => void;
  scrollToHeading?: string | null;
  onScrolled?: () => void;
}

function renderValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(renderValue).join(', ');
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v ?? '');
}

/** Scroll to a heading (by text) or a block (^id) inside a container. */
export function scrollToAnchor(root: HTMLElement | null, heading: string, smooth = false) {
  if (!root) return;
  const id = heading.startsWith('^') ? `block-${heading.slice(1)}` : slugify(heading);
  const el = root.querySelector(`#${CSS.escape(id)}`);
  const target = (el?.closest('li, p, h1, h2, h3, h4, h5, h6') as HTMLElement | null) ?? (el as HTMLElement | null);
  target?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  if (target && heading.startsWith('^')) {
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1500);
  }
}

let mermaidLoader: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid() {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then((m) => {
      m.default.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict', fontFamily: 'inherit' });
      return m.default;
    });
  }
  return mermaidLoader;
}

let mermaidCounter = 0;

/** Fill in embeds and diagrams inside freshly rendered HTML. */
async function hydrate(
  root: HTMLElement,
  render: ReturnType<typeof createRenderer>,
  fromPath: string,
  depth: number,
  isStale: () => boolean,
) {
  // Mermaid diagrams (library loaded only when a note has one).
  const diagrams = [...root.querySelectorAll<HTMLElement>('.mermaid-block:not([data-done])')];
  if (diagrams.length) {
    const mermaid = await loadMermaid();
    for (const el of diagrams) {
      if (isStale()) return;
      el.dataset.done = '1';
      try {
        const { svg } = await mermaid.render(`mmd-${++mermaidCounter}`, decodeURIComponent(el.dataset.src ?? ''));
        el.innerHTML = svg;
      } catch (err) {
        el.innerHTML = `<pre class="mermaid-error">Diagram error: ${String((err as Error).message ?? err).replace(/</g, '&lt;')}</pre>`;
      }
    }
  }

  // ![[Note]] / ![[Note#Heading]] / ![[Note#^block]] transclusions.
  const embeds = [...root.querySelectorAll<HTMLElement>('.embed-note:not([data-done])')];
  for (const el of embeds) {
    if (isStale()) return;
    el.dataset.done = '1';
    const target = el.dataset.target ?? '';
    const heading = el.dataset.heading || undefined;
    if (depth >= 3) {
      el.innerHTML = `<div class="embed-loading">Embed depth limit reached (${target})</div>`;
      continue;
    }
    try {
      const resolved = await api.resolve(target, fromPath);
      if (!resolved.path) {
        el.innerHTML = `<div class="embed-missing">“${target.replace(/</g, '&lt;')}” doesn’t exist yet</div>`;
        continue;
      }
      if (resolved.path === fromPath && !heading) {
        el.innerHTML = '<div class="embed-loading">A note can’t embed itself</div>';
        continue;
      }
      const note = await api.note(resolved.path);
      if (isStale()) return;
      if (note.encrypted) {
        el.innerHTML = `<div class="embed-missing">🔒 ${note.name.replace(/</g, '&lt;')} is locked</div>`;
        continue;
      }
      const section = extractSection(note.content, heading);
      el.innerHTML = `<div class="embed-head"><a class="wikilink" href="#" data-target="${resolved.path.replace(/"/g, '&quot;')}" data-heading="${(heading ?? '').replace(/"/g, '&quot;')}">${note.name.replace(/</g, '&lt;')}${heading ? ` › ${heading.replace(/</g, '&lt;')}` : ''}</a></div><div class="embed-body markdown">${render(section, { fromPath: resolved.path, interactive: false })}</div>`;
      await hydrate(el, render, resolved.path, depth + 1, isStale);
    } catch {
      el.innerHTML = `<div class="embed-missing">Could not load “${target.replace(/</g, '&lt;')}”</div>`;
    }
  }
}

interface Hover {
  x: number;
  y: number;
  html: string;
  title: string;
}

export function Preview({ content, path, exists, namesKey, onOpenLink, onTag, onToggleTask, scrollToHeading, onScrolled }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const render = useMemo(() => createRenderer({ exists, fromPath: path, interactive: true }), [namesKey, path]);
  const html = useMemo(() => render(content), [render, content]);
  const fm = useMemo(() => splitFrontmatter(content).frontmatter, [content]);
  const [hover, setHover] = useState<Hover | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderGen = useRef(0);

  // Set HTML imperatively so hydrated embeds/diagrams aren't wiped by React on unrelated re-renders.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.innerHTML = html;
    const gen = ++renderGen.current;
    hydrate(el, render, path, 0, () => gen !== renderGen.current).catch(() => {});
  }, [html, render, path]);

  useEffect(() => {
    if (!scrollToHeading || !ref.current) return;
    scrollToAnchor(ref.current, scrollToHeading);
    onScrolled?.();
  }, [scrollToHeading, html, onScrolled]);

  const showHover = (link: HTMLAnchorElement) => {
    const target = link.dataset.target ?? '';
    if (!target) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(async () => {
      try {
        const r = await api.resolve(target, path);
        const rect = link.getBoundingClientRect();
        if (!r.path) {
          setHover({ x: rect.left, y: rect.bottom + 6, title: target, html: '<p class="muted">This note doesn’t exist yet. Click to create it.</p>' });
          return;
        }
        const note = await api.note(r.path);
        if (note.encrypted) {
          setHover({ x: rect.left, y: rect.bottom + 6, title: `🔒 ${note.name}`, html: '<p class="muted">This note is locked. Open it and enter its password to read it.</p>' });
          return;
        }
        const heading = link.dataset.heading || undefined;
        const section = extractSection(note.content, heading);
        setHover({
          x: Math.min(rect.left, window.innerWidth - 440),
          y: rect.bottom + 380 > window.innerHeight ? Math.max(8, rect.top - 370) : rect.bottom + 6,
          title: note.name + (heading ? ` › ${heading}` : ''),
          html: render(section.length > 4000 ? section.slice(0, 4000) + '\n\n…' : section, { fromPath: r.path, interactive: false }),
        });
      } catch {
        /* ignore */
      }
    }, 350);
  };
  const hideHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHover(null), 250);
  };

  return (
    <div className="preview-scroll">
      <article
        className="preview markdown"
        ref={ref}
        onMouseOver={(e) => {
          const link = (e.target as HTMLElement).closest('a.wikilink') as HTMLAnchorElement | null;
          if (link && !link.closest('.hover-card')) showHover(link);
        }}
        onMouseOut={(e) => {
          if ((e.target as HTMLElement).closest('a.wikilink')) hideHover();
        }}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          const box = target.closest('.task-box.interactive') as HTMLElement | null;
          if (box && onToggleTask) {
            e.preventDefault();
            onToggleTask(Number(box.dataset.task));
            return;
          }
          const link = target.closest('a.wikilink') as HTMLAnchorElement | null;
          if (link) {
            e.preventDefault();
            setHover(null);
            const t = link.dataset.target ?? '';
            const h = link.dataset.heading || undefined;
            if (!t && h) {
              scrollToAnchor(ref.current, h, true);
              return;
            }
            onOpenLink(t, h, { markdown: link.dataset.md === '1' });
            return;
          }
          const tag = target.closest('a.tag') as HTMLAnchorElement | null;
          if (tag) {
            e.preventDefault();
            onTag(tag.dataset.tag ?? '');
            return;
          }
          // Footnote links (#footnote-1) scroll within the note.
          const anchor = target.closest('a[href^="#"]') as HTMLAnchorElement | null;
          if (anchor && anchor.getAttribute('href')!.length > 1) {
            e.preventDefault();
            ref.current?.querySelector(`#${CSS.escape(anchor.getAttribute('href')!.slice(1))}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }}
        onKeyDown={(e) => {
          const box = (e.target as HTMLElement).closest('.task-box.interactive') as HTMLElement | null;
          if (box && onToggleTask && (e.key === ' ' || e.key === 'Enter')) {
            e.preventDefault();
            onToggleTask(Number(box.dataset.task));
          }
        }}
      >
        {fm && Object.keys(fm).length > 0 && (
          <table className="properties">
            <tbody>
              {Object.entries(fm).map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td>{renderValue(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div ref={bodyRef} />
      </article>
      {hover && (
        <div
          className="hover-card"
          style={{ left: Math.max(8, hover.x), top: hover.y }}
          onMouseEnter={() => hideTimer.current && clearTimeout(hideTimer.current)}
          onMouseLeave={hideHover}
        >
          <div className="hover-title">{hover.title}</div>
          <div className="hover-body markdown" dangerouslySetInnerHTML={{ __html: hover.html }} />
        </div>
      )}
    </div>
  );
}
