import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { createRenderer, extractSection, slugify, splitFrontmatter } from '../markdown';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { parseTaskQuery, runTaskQuery } from '../taskQuery';
import { dueLabel } from './Panels';
import { editTableInContent, type TableAction } from '../tables';
import { Properties } from './Properties';
import { renderNoteQuery } from './noteQuery';

interface TableMenu {
  x: number;
  y: number;
  raw: string;
  /** Body row index; -1 for the header row. */
  row: number;
  col: number;
  colName: string;
  error?: string;
}

const escapeText = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const DUE_IN_TEXT = /\s*(?:📅|🗓️?|\bdue::?)\s*\d{4}-\d{2}-\d{2}\b/giu;

/** Fill a ```tasks block with the matching tasks from the whole vault. */
export async function renderTaskQuery(el: HTMLElement) {
  const q = parseTaskQuery(decodeURIComponent(el.dataset.q ?? ''));
  let tasks;
  try {
    tasks = runTaskQuery(q, (await api.tasks(true)).tasks);
  } catch {
    el.innerHTML = '<div class="muted small">Couldn’t load tasks.</div>';
    return;
  }
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const item = (t: (typeof tasks)[number]) => {
    const done = t.status === 'x' || t.status === 'X' || t.status === '-';
    const overdue = !done && !!t.due && t.due < today;
    const due = t.due ? `<span class="task-due${overdue ? ' overdue' : t.due === today ? ' today' : ''}" title="${t.due}">📅 ${escapeText(dueLabel(t.due, today))}</span>` : '';
    const box = `<span class="task-box interactive tq-box" data-status="${escapeText(t.status)}" data-path="${escapeText(t.path)}" data-line="${t.line}" role="checkbox" aria-checked="${done}" tabindex="0">${t.status === ' ' || t.status === 'x' || t.status === 'X' ? '' : escapeText(t.status)}</span>`;
    const text = escapeText(t.text.replace(DUE_IN_TEXT, '').trim() || t.text);
    return `<li class="task${done ? ' done' : ''}">${box}<span>${text}</span>${due} <a class="wikilink tq-source" href="#" data-target="${escapeText(t.path)}">${escapeText(t.name)}</a></li>`;
  };
  let body: string;
  if (!tasks.length) body = '<div class="muted small">No matching tasks.</div>';
  else if (q.group) {
    const groups = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const key = q.group === 'note' ? t.name : t.due ? dueLabel(t.due, today) : 'No date';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }
    body = [...groups].map(([k, list]) => `<div class="tq-group">${escapeText(k)}</div><ul class="tq-list">${list.map(item).join('')}</ul>`).join('');
  } else body = `<ul class="tq-list">${tasks.map(item).join('')}</ul>`;
  const errors = q.errors.length ? `<div class="tq-errors">${q.errors.map(escapeText).join('<br>')}</div>` : '';
  el.innerHTML = errors + body;
}


/** Draw an embedded `.excalidraw` drawing as a picture. */
async function renderDrawingEmbed(el: HTMLElement) {
  const target = el.dataset.target ?? '';
  const name = target.split('/').pop()!.replace(/\.excalidraw$/i, '');
  try {
    const d = (await api.drawing(target)).data as { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };
    const live = (d.elements ?? []).filter((x) => !(x as { isDeleted?: boolean }).isDeleted);
    if (!live.length) {
      el.innerHTML = `<div class="embed-loading">✎ ${escapeText(name)}: empty drawing, click to draw</div>`;
      return;
    }
    const lib = await import('@excalidraw/excalidraw');
    const svg = await lib.exportToSvg({
      elements: live as never,
      appState: { ...(d.appState ?? {}), exportBackground: false, exportWithDarkMode: document.documentElement.dataset.theme !== 'light' } as never,
      files: (d.files ?? {}) as never,
      exportPadding: 12,
    });
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    const cap = document.createElement('div');
    cap.className = 'embed-drawing-caption';
    cap.textContent = `✎ ${name}`;
    el.replaceChildren(svg, cap);
  } catch {
    el.innerHTML = `<div class="embed-missing">“${escapeText(target)}” doesn’t exist yet</div>`;
  }
}

// A drawing was saved: redraw its pictures in open notes.
if (typeof window !== 'undefined') {
  window.addEventListener('octavo:drawing-saved', (e) => {
    const p = ((e as CustomEvent<string>).detail ?? '').toLowerCase();
    const file = p.split('/').pop();
    for (const el of document.querySelectorAll<HTMLElement>('.embed-drawing')) {
      const t = (el.dataset.target ?? '').toLowerCase();
      if (t === p || t === file || t.endsWith('/' + file)) void renderDrawingEmbed(el);
    }
  });
}

/** Syntax-highlight fenced code blocks with the same language parsers the editor uses. */
async function highlightCode(root: HTMLElement, isStale: () => boolean) {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]:not([data-hl])')];
  for (const el of blocks) {
    if (isStale()) return;
    el.dataset.hl = '1';
    const name = /(?:^|\s)language-([^\s]+)/.exec(el.className)?.[1];
    const desc = name ? LanguageDescription.matchLanguageName(languages, name, true) : null;
    if (!desc) continue;
    let support;
    try {
      support = desc.support ?? (await desc.load());
    } catch {
      continue;
    }
    if (isStale()) return;
    const code = el.textContent ?? '';
    const frag = document.createDocumentFragment();
    let pos = 0;
    const push = (text: string, cls?: string) => {
      if (!text) return;
      if (!cls) return void frag.append(text);
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      frag.append(span);
    };
    highlightTree(support.language.parser.parse(code), classHighlighter, (from, to, cls) => {
      push(code.slice(pos, from));
      push(code.slice(from, to), cls);
      pos = to;
    });
    push(code.slice(pos));
    el.replaceChildren(frag);
  }
}

interface Props {
  content: string;
  path: string;
  exists: (target: string) => boolean;
  /** Changes whenever the set of note names changes, to restyle unresolved links. */
  namesKey: string;
  onOpenLink: (target: string, heading?: string, opts?: { markdown?: boolean; newTab?: boolean }) => void;
  onTag: (tag: string) => void;
  onToggleTask?: (index: number) => void;
  scrollToHeading?: string | null;
  onScrolled?: () => void;
  /** Headings of this note that are bookmarked (shown with a filled star). */
  bookmarkedHeadings?: string[];
  /** Shows a star next to each heading that bookmarks (or un-bookmarks) it. */
  onBookmarkHeading?: (heading: string) => void;
  /** Lets the reading view change the note (table menu, properties). */
  onEditContent?: (content: string) => void;
  /** Changes to open the properties editor. */
  editPropertiesSignal?: number;
  /** A web link was clicked; return true if it was handled (e.g. opened in the web viewer). */
  onOpenUrl?: (url: string, e: { altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => boolean;
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

  await highlightCode(root, isStale);

  // ![[sketch.excalidraw]]: a picture of the drawing (the drawing library loads only when a note has one).
  for (const el of root.querySelectorAll<HTMLElement>('.embed-drawing:not([data-done])')) {
    if (isStale()) return;
    el.dataset.done = '1';
    await renderDrawingEmbed(el);
  }

  for (const el of root.querySelectorAll<HTMLElement>('.notes-query:not([data-done])')) {
    if (isStale()) return;
    el.dataset.done = '1';
    await renderNoteQuery(el, fromPath);
  }

  for (const el of root.querySelectorAll<HTMLElement>('.tasks-query:not([data-done])')) {
    if (isStale()) return;
    el.dataset.done = '1';
    await renderTaskQuery(el);
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

export function Preview({ content, path, exists, namesKey, onOpenLink, onTag, onToggleTask, scrollToHeading, onScrolled, bookmarkedHeadings, onBookmarkHeading, onEditContent, editPropertiesSignal, onOpenUrl }: Props) {
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
  const existsRef = useRef(exists);
  existsRef.current = exists;

  // Set HTML imperatively so hydrated embeds/diagrams aren't wiped by React on unrelated re-renders.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.innerHTML = html;
    const gen = ++renderGen.current;
    hydrate(el, render, path, 0, () => gen !== renderGen.current)
      .then(() => {
        // Diagram boxes whose label is a note's name open that note.
        if (gen !== renderGen.current) return;
        for (const node of el.querySelectorAll<SVGGElement>('.mermaid-block g.node')) {
          const label = (node.textContent ?? '').trim();
          if (label && existsRef.current(label)) {
            node.classList.add('note-link');
            node.dataset.note = label;
          }
        }
      })
      .catch(() => {});
  }, [html, render, path]);

  const [tableMenu, setTableMenu] = useState<TableMenu | null>(null);
  const canEditTables = !!onEditContent;
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !canEditTables) return;
    for (const wrap of el.querySelectorAll<HTMLElement>(':scope > .table-wrap')) {
      if (wrap.querySelector(':scope > .table-menu-btn')) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'table-menu-btn';
      btn.title = 'Table options (or right-click a cell)';
      btn.textContent = '⋯';
      wrap.append(btn);
    }
  }, [html, render, path, canEditTables]);
  useEffect(() => {
    if (!tableMenu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'mousedown' && (e.target as HTMLElement).closest('.table-menu')) return;
      setTableMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('resize', close);
    };
  }, [tableMenu]);
  const openTableMenu = (cell: HTMLTableCellElement | null, wrap: HTMLElement, x: number, y: number) => {
    const raw = decodeURIComponent(wrap.dataset.table ?? '');
    const table = wrap.querySelector('table');
    const c = cell ?? wrap.querySelector<HTMLTableCellElement>('td.cell-selected, th.cell-selected');
    const col = c ? c.cellIndex : 0;
    const tr = c?.parentElement as HTMLTableRowElement | undefined;
    const row = !c || tr?.parentElement?.tagName === 'THEAD' ? -1 : tr!.sectionRowIndex;
    const colName = table?.querySelectorAll('thead th')[col]?.textContent?.trim() || `Column ${col + 1}`;
    setTableMenu({ x: Math.min(x, window.innerWidth - 230), y: Math.min(y, window.innerHeight - 380), raw, row, col, colName });
  };
  const runTable = (action: TableAction) => {
    if (!tableMenu || !onEditContent) return;
    const next = editTableInContent(content, tableMenu.raw, action);
    if (next == null) {
      setTableMenu({ ...tableMenu, error: 'This table is inside a quote or list. Change it in Edit mode instead.' });
      return;
    }
    setTableMenu(null);
    onEditContent(next);
  };

  // A star on each of this note's own headings (not embedded ones) to bookmark it.
  const bookmarkedKey = (bookmarkedHeadings ?? []).join('\n');
  const canBookmark = !!onBookmarkHeading;
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !canBookmark) return;
    const marked = new Set(bookmarkedKey ? bookmarkedKey.split('\n') : []);
    for (const h of el.querySelectorAll<HTMLElement>(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6')) {
      let btn = h.querySelector<HTMLButtonElement>(':scope > .heading-bookmark');
      if (!btn) {
        const text = (h.textContent ?? '').trim();
        if (!text) continue;
        btn = document.createElement('button');
        btn.className = 'heading-bookmark';
        btn.type = 'button';
        btn.dataset.heading = text;
        h.append(btn);
      }
      const on = marked.has(btn.dataset.heading ?? '');
      btn.textContent = on ? '★' : '☆';
      btn.classList.toggle('on', on);
      btn.title = on ? 'Remove bookmark' : 'Bookmark this heading';
    }
    // render and path too: the HTML is re-set when they change even if the string is identical.
  }, [html, render, path, bookmarkedKey, canBookmark]);

  useEffect(() => {
    if (!scrollToHeading || !ref.current) return;
    scrollToAnchor(ref.current, scrollToHeading);
    onScrolled?.();
  }, [scrollToHeading, html, onScrolled]);

  useEffect(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHover(null);
  }, [path]);

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
        // Link previews on hover are for a real mouse only: phones send a fake hover on every tap,
        // which used to pop a preview of the note you just opened on top of it.
        onPointerOver={(e) => {
          if (e.pointerType !== 'mouse') return;
          const link = (e.target as HTMLElement).closest('a.wikilink') as HTMLAnchorElement | null;
          if (link && !link.closest('.hover-card')) showHover(link);
        }}
        onPointerOut={(e) => {
          if (e.pointerType !== 'mouse') return;
          if ((e.target as HTMLElement).closest('a.wikilink')) hideHover();
        }}
        onAuxClick={(e) => {
          // Middle-click a link: open it in a new tab.
          if (e.button !== 1) return;
          const link = (e.target as HTMLElement).closest('a.wikilink') as HTMLAnchorElement | null;
          if (!link || !link.dataset.target) return;
          e.preventDefault();
          onOpenLink(link.dataset.target, link.dataset.heading || undefined, { markdown: link.dataset.md === '1', newTab: true });
        }}
        onContextMenu={(e) => {
          const cell = (e.target as HTMLElement).closest('.table-wrap td, .table-wrap th') as HTMLTableCellElement | null;
          if (!cell || !canEditTables) return;
          e.preventDefault();
          openTableMenu(cell, cell.closest('.table-wrap') as HTMLElement, e.clientX, e.clientY);
        }}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          const diagramNode = target.closest('.mermaid-block g.note-link') as SVGGElement | null;
          if (diagramNode) {
            e.preventDefault();
            onOpenLink(diagramNode.dataset.note ?? '');
            return;
          }
          const menuBtn = target.closest('.table-menu-btn') as HTMLElement | null;
          if (menuBtn && canEditTables) {
            e.preventDefault();
            const r = menuBtn.getBoundingClientRect();
            openTableMenu(null, menuBtn.closest('.table-wrap') as HTMLElement, r.left - 190, r.bottom + 4);
            return;
          }
          const cell = target.closest('.table-wrap td, .table-wrap th') as HTMLTableCellElement | null;
          if (cell && canEditTables && !target.closest('a')) {
            // Remember the cell so the ⋯ button (e.g. on a phone) acts on it.
            cell.closest('table')?.querySelectorAll('.cell-selected').forEach((x) => x.classList.remove('cell-selected'));
            cell.classList.add('cell-selected');
          }
          const qbox = target.closest('.tq-box') as HTMLElement | null;
          if (qbox) {
            e.preventDefault();
            const block = qbox.closest('.tasks-query') as HTMLElement | null;
            api
              .setTask(qbox.dataset.path ?? '', Number(qbox.dataset.line))
              .then(() => block && renderTaskQuery(block))
              .catch(() => {});
            return;
          }
          const star = target.closest('.heading-bookmark') as HTMLElement | null;
          if (star && onBookmarkHeading) {
            e.preventDefault();
            onBookmarkHeading(star.dataset.heading ?? '');
            return;
          }
          const box = target.closest('.task-box.interactive') as HTMLElement | null;
          if (box && onToggleTask) {
            e.preventDefault();
            onToggleTask(Number(box.dataset.task));
            return;
          }
          const sketch = target.closest('.embed-drawing') as HTMLElement | null;
          if (sketch) {
            e.preventDefault();
            onOpenLink(sketch.dataset.target ?? '');
            return;
          }
          const web = target.closest('a[href^="http://"], a[href^="https://"]') as HTMLAnchorElement | null;
          if (web && !web.classList.contains('wikilink') && onOpenUrl?.(web.href, e)) {
            e.preventDefault();
            return;
          }
          const link = target.closest('a.wikilink') as HTMLAnchorElement | null;
          if (link) {
            e.preventDefault();
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
            setHover(null);
            const t = link.dataset.target ?? '';
            const h = link.dataset.heading || undefined;
            if (!t && h) {
              scrollToAnchor(ref.current, h, true);
              return;
            }
            onOpenLink(t, h, { markdown: link.dataset.md === '1', newTab: e.ctrlKey || e.metaKey });
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
        <Properties frontmatter={fm} content={content} onEditContent={onEditContent} openSignal={editPropertiesSignal} />
        <div ref={bodyRef} />
      </article>
      {tableMenu && (
        <div className="table-menu" role="menu" style={{ left: Math.max(8, tableMenu.x), top: Math.max(8, tableMenu.y) }}>
          {tableMenu.error ? (
            <div className="table-menu-error">{tableMenu.error}</div>
          ) : (
            <>
              <div className="table-menu-head">Column “{tableMenu.colName}”</div>
              <button onClick={() => runTable({ type: 'sort', col: tableMenu.col, desc: false })}>Sort A → Z</button>
              <button onClick={() => runTable({ type: 'sort', col: tableMenu.col, desc: true })}>Sort Z → A</button>
              <button onClick={() => runTable({ type: 'insertCol', col: tableMenu.col, side: 'left' })}>Insert column left</button>
              <button onClick={() => runTable({ type: 'insertCol', col: tableMenu.col, side: 'right' })}>Insert column right</button>
              <button onClick={() => runTable({ type: 'moveCol', col: tableMenu.col, by: -1 })}>Move column left</button>
              <button onClick={() => runTable({ type: 'moveCol', col: tableMenu.col, by: 1 })}>Move column right</button>
              <div className="table-menu-row">
                Align
                <button onClick={() => runTable({ type: 'align', col: tableMenu.col, align: 'left' })} title="Align left">⇤</button>
                <button onClick={() => runTable({ type: 'align', col: tableMenu.col, align: 'center' })} title="Center">↔</button>
                <button onClick={() => runTable({ type: 'align', col: tableMenu.col, align: 'right' })} title="Align right">⇥</button>
              </div>
              <button className="danger" onClick={() => runTable({ type: 'deleteCol', col: tableMenu.col })}>Delete column</button>
              <div className="table-menu-head">{tableMenu.row < 0 ? 'Header row' : `Row ${tableMenu.row + 1}`}</div>
              {tableMenu.row >= 0 && <button onClick={() => runTable({ type: 'insertRow', row: tableMenu.row, side: 'above' })}>Insert row above</button>}
              <button onClick={() => runTable({ type: 'insertRow', row: tableMenu.row, side: 'below' })}>Insert row below</button>
              {tableMenu.row >= 0 && (
                <>
                  <button onClick={() => runTable({ type: 'moveRow', row: tableMenu.row, by: -1 })}>Move row up</button>
                  <button onClick={() => runTable({ type: 'moveRow', row: tableMenu.row, by: 1 })}>Move row down</button>
                  <button className="danger" onClick={() => runTable({ type: 'deleteRow', row: tableMenu.row })}>Delete row</button>
                </>
              )}
            </>
          )}
        </div>
      )}
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
