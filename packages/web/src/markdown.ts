import { Marked, Renderer, type Tokens } from 'marked';
import markedFootnote from 'marked-footnote';
import markedKatex from 'marked-katex-extension';
import DOMPurify from 'dompurify';
import YAML from 'yaml';
import { getToken } from './api';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function splitFrontmatter(content: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return { frontmatter: null, body: content };
  let fm: Record<string, unknown> | null = null;
  try {
    const v = YAML.parse(m[1], { logLevel: 'error' });
    if (v && typeof v === 'object' && !Array.isArray(v)) fm = v;
  } catch {
    fm = null;
  }
  return { frontmatter: fm, body: content.slice(m[0].length) };
}

export function parseWikiInner(inner: string): { target: string; heading?: string; alias?: string } {
  let rest = inner;
  let alias: string | undefined;
  const pipe = rest.indexOf('|');
  if (pipe !== -1) {
    alias = rest.slice(pipe + 1).trim() || undefined;
    rest = rest.slice(0, pipe);
  }
  let heading: string | undefined;
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    heading = rest.slice(hash + 1).trim() || undefined;
    rest = rest.slice(0, hash);
  }
  return { target: rest.trim(), heading, alias };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|flac|webm)$/i;
const VIDEO_EXT = /\.(mp4|mov|mkv|ogv)$/i;
const PDF_EXT = /\.pdf$/i;
export const isMediaRef = (t: string) => IMAGE_EXT.test(t) || AUDIO_EXT.test(t) || VIDEO_EXT.test(t) || PDF_EXT.test(t);

/** URL for a vault attachment (by path or bare name), carrying the auth token for <img>/<video> tags. */
export function fileUrl(ref: string, fromPath?: string): string {
  const params = new URLSearchParams();
  if (fromPath) params.set('from', fromPath);
  const token = getToken();
  if (token) params.set('token', token);
  const q = params.toString();
  return `api/files/${ref.split('/').map(encodeURIComponent).join('/')}${q ? `?${q}` : ''}`;
}

function mediaHtml(ref: string, label: string | undefined, fromPath?: string): string {
  const src = escapeHtml(fileUrl(ref, fromPath));
  // ![[pic.png|300]] or ![[pic.png|300x200]] sets the size.
  const size = label && /^(\d+)(?:x(\d+))?$/.exec(label);
  const dims = size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ''}` : '';
  const alt = escapeHtml(size ? ref : label ?? ref);
  if (IMAGE_EXT.test(ref)) return `<img class="embed-media" src="${src}" alt="${alt}"${dims} loading="lazy">`;
  if (AUDIO_EXT.test(ref)) return `<audio class="embed-media" controls preload="metadata" src="${src}"></audio>`;
  if (VIDEO_EXT.test(ref)) return `<video class="embed-media" controls preload="metadata" src="${src}"${dims}></video>`;
  return `<iframe class="embed-pdf" src="${src}" title="${alt}"${dims}></iframe>`;
}

const CALLOUT_ICONS: Record<string, string> = {
  note: '✎', abstract: '☰', summary: '☰', tldr: '☰', info: 'ℹ', todo: '☑', tip: '✦', hint: '✦', important: '✦',
  success: '✓', check: '✓', done: '✓', question: '?', help: '?', faq: '?', warning: '⚠', caution: '⚠', attention: '⚠',
  failure: '✕', fail: '✕', missing: '✕', danger: '⚡', error: '⚡', bug: '🐞', example: '▤', quote: '❝', cite: '❝',
};
const CALLOUT_ALIASES: Record<string, string> = {
  summary: 'abstract', tldr: 'abstract', hint: 'tip', important: 'tip', check: 'success', done: 'success',
  help: 'question', faq: 'question', caution: 'warning', attention: 'warning', fail: 'failure', missing: 'failure',
  error: 'danger', cite: 'quote',
};

/**
 * Pre-process Obsidian syntax that marked doesn't know about. Code blocks and
 * inline code are protected first so their contents stay literal.
 */
function preprocess(body: string): string {
  const stash: string[] = [];
  const protect = (m: string) => `\u0000${stash.push(m) - 1}\u0000`;
  let text = body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, protect).replace(/`[^`\n]+`/g, protect);
  // %% comments %% are hidden in reading view.
  text = text.replace(/%%[\s\S]*?%%/g, '');
  // Block ids at the end of a line: "Some text ^my-block" -> invisible anchor.
  text = text.replace(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/gm, (_m, id) => ` <span class="block-anchor" id="block-${id}"></span>`);
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)]);
}

export interface RenderContext {
  /** Does a wikilink target exist? */
  exists: (target: string) => boolean;
  /** Path of the note being rendered (for resolving relative attachments). */
  fromPath?: string;
  /** Interactive renders get clickable task checkboxes; embeds don't. */
  interactive?: boolean;
}

/** Build a Markdown -> sanitized HTML renderer with all Octavo/Obsidian extensions. */
export function createRenderer(ctxBase: RenderContext) {
  let ctx = ctxBase;
  let taskIndex = 0;
  const marked = new Marked({ gfm: true, breaks: false });
  // Callout bodies are lexed by a second instance without the footnote plugin: that plugin keeps
  // per-document state, and lexing nested content with it would corrupt the next render.
  const inner = new Marked({ gfm: true, breaks: false });

  marked.use(markedFootnote({ description: 'Footnotes', refMarkers: true }));
  const katex = markedKatex({ throwOnError: false, nonStandard: true, output: 'html' });
  marked.use(katex);
  inner.use(katex);

  const extensions: Parameters<typeof marked.use>[0]['extensions'] = [
      {
        name: 'wikilink',
        level: 'inline',
        start(src: string) {
          const i = src.search(/!?\[\[/);
          return i === -1 ? undefined : i;
        },
        tokenizer(src: string) {
          const m = /^(!?)\[\[([^\[\]\n]+?)\]\]/.exec(src);
          if (!m) return undefined;
          return { type: 'wikilink', raw: m[0], embed: m[1] === '!', ...parseWikiInner(m[2]) };
        },
        renderer(token) {
          const t = token as Tokens.Generic & { target: string; heading?: string; alias?: string; embed: boolean };
          if (t.embed && isMediaRef(t.target)) return mediaHtml(t.target, t.alias, ctx.fromPath);
          if (t.embed && /\.excalidraw$/i.test(t.target)) {
            return `<div class="embed-drawing" data-target="${escapeHtml(t.target)}" role="button" tabindex="0" title="Open drawing"><div class="embed-loading">✎ ${escapeHtml(t.target.split('/').pop()!.replace(/\.excalidraw$/i, ''))}</div></div>`;
          }
          if (t.embed && t.target) {
            return `<div class="embed-note" data-target="${escapeHtml(t.target)}" data-heading="${escapeHtml(t.heading ?? '')}"><div class="embed-loading">${escapeHtml(t.target)}</div></div>`;
          }
          const headingLabel = t.heading?.startsWith('^') ? '' : t.heading;
          const label =
            t.alias ?? (t.target ? t.target.split('/').pop()! : '') + (headingLabel ? (t.target ? ' › ' : '') + headingLabel : '');
          const resolved = !t.target || ctx.exists(t.target);
          return `<a class="wikilink${resolved ? '' : ' unresolved'}" href="#" data-target="${escapeHtml(t.target)}" data-heading="${escapeHtml(t.heading ?? '')}">${escapeHtml(label || t.target)}</a>`;
        },
      },
      {
        name: 'highlight',
        level: 'inline',
        start(src: string) {
          const i = src.indexOf('==');
          return i === -1 ? undefined : i;
        },
        tokenizer(src: string) {
          // ==text== or =={red}text==
          const m = /^==(?:\{(red|orange|yellow|green|blue|purple)\}\s*)?(?=\S)([^\n]*?\S)==(?!=)/.exec(src);
          if (!m) return undefined;
          return { type: 'highlight', raw: m[0], color: m[1] ?? 'yellow', tokens: this.lexer.inlineTokens(m[2]) };
        },
        renderer(token) {
          const t = token as Tokens.Generic & { color: string; tokens: Tokens.Generic[] };
          return `<mark class="hl-${t.color}">${this.parser.parseInline(t.tokens)}</mark>`;
        },
      },
      {
        name: 'hashtag',
        level: 'inline',
        start(src: string) {
          const m = /(^|[\s(])#[\p{L}\p{N}_\-/]*[\p{L}_\-][\p{L}\p{N}_\-/]*/u.exec(src);
          return m ? m.index + m[1].length : undefined;
        },
        tokenizer(src: string) {
          const m = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-][\p{L}\p{N}_\-/]*)/u.exec(src);
          if (!m) return undefined;
          return { type: 'hashtag', raw: m[0], tag: m[1].toLowerCase() };
        },
        renderer(token) {
          const t = token as Tokens.Generic & { tag: string };
          return `<a class="tag" href="#" data-tag="${escapeHtml(t.tag)}">#${escapeHtml(t.tag)}</a>`;
        },
      },
  ];
  inner.use({ extensions });
  marked.use({
    extensions,
    renderer: {
      heading({ tokens, depth, text }) {
        const html = this.parser.parseInline(tokens);
        return `<h${depth} id="${slugify(text)}">${html}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const html = this.parser.parseInline(tokens);
        const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
        if (!external && /\.md(#.*)?$/i.test(href)) {
          const [p, h] = href.split('#');
          let target = p;
          try {
            target = decodeURI(p);
          } catch {
            /* keep */
          }
          return `<a class="wikilink md" href="#" data-target="${escapeHtml(target.replace(/\.md$/i, ''))}" data-heading="${escapeHtml(h ?? '')}" data-md="1">${html}</a>`;
        }
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(href)}"${t}${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${html}</a>`;
      },
      image({ href, title, text }) {
        const external = /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
        if (!external && isMediaRef(href)) {
          let ref = href;
          try {
            ref = decodeURI(href);
          } catch {
            /* keep */
          }
          return mediaHtml(ref, text || undefined, ctx.fromPath);
        }
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
      },
      code({ text, lang }) {
        // URI-encoded: the sanitizer strips attributes containing "-->", which Mermaid arrows use.
        if (lang === 'tasks') return `<div class="tasks-query" data-q="${encodeURIComponent(text)}"><div class="muted small">Loading tasks…</div></div>`;
        if (lang === 'query' || lang === 'dataview' || lang === 'base')
          return `<div class="notes-query" data-q="${encodeURIComponent(text)}" data-lang="${lang === 'base' ? 'base' : 'dql'}"><div class="muted small">Loading…</div></div>`;
        if (lang === 'mermaid') return `<div class="mermaid-block" data-src="${encodeURIComponent(text)}"><pre>${escapeHtml(text)}</pre></div>`;
        return false; // default rendering
      },
      table(token) {
        // Wrapped so the reading view can offer sort / insert / delete on it; data-table is the Markdown source.
        const html = Renderer.prototype.table.call(this, token);
        return `<div class="table-wrap" data-table="${encodeURIComponent(token.raw)}">${html}</div>`;
      },
      checkbox() {
        return ''; // drawn by listitem so custom statuses work too
      },
      listitem(item) {
        let status: string | null = null;
        if (item.task) status = item.checked ? 'x' : ' ';
        else {
          const m = /^\[(.)\][ \t]/.exec(item.text);
          if (m) status = m[1];
        }
        let body = this.parser.parse(item.tokens);
        if (status === null) return `<li>${body}</li>\n`;
        if (!item.task) body = body.replace(/\[.\][ \t]/, '');
        const idx = taskIndex++;
        const done = status === 'x' || status === 'X' || status === '-';
        // Due dates (📅 2026-11-10) as a small badge; red when overdue.
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        body = body.replace(
          /(📅|🗓️?)\s*(\d{4}-\d{2}-\d{2})\b(?![^<]*>)/gu,
          (_m, icon: string, date: string) => `<span class="task-due-inline${!done && date < today ? ' overdue' : ''}">${icon} ${date}</span>`,
        );
        const box = `<span class="task-box${ctx.interactive ? ' interactive' : ''}" data-status="${escapeHtml(status)}"${ctx.interactive ? ` data-task="${idx}" role="checkbox" aria-checked="${done}" tabindex="0"` : ''}>${status === ' ' || status === 'x' || status === 'X' ? '' : escapeHtml(status)}</span>`;
        return `<li class="task${done ? ' done' : ''}" data-status="${escapeHtml(status)}">${box}${body}</li>\n`;
      },
      blockquote(token) {
        // Callouts: > [!type]+/- Optional title
        const m = /^\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/.exec(token.text.split('\n')[0]);
        if (!m) return `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`;
        const raw = m[1].toLowerCase();
        const type = CALLOUT_ALIASES[raw] ?? raw;
        const title = m[3] || raw.charAt(0).toUpperCase() + raw.slice(1);
        // Lexer.lex (not marked.lexer) so plugin hooks, e.g. footnote collection, aren't reset mid-document.
        const body = token.text.split('\n').slice(1).join('\n');
        const content = body.trim() ? this.parser.parse(inner.lexer(body)) : '';
        const icon = CALLOUT_ICONS[raw] ?? CALLOUT_ICONS[type] ?? '✎';
        const head = `<span class="callout-icon">${icon}</span><span class="callout-title-text">${this.parser.parseInline(marked.Lexer.lexInline(title))}</span>`;
        if (m[2]) {
          return `<details class="callout callout-${escapeHtml(type)}"${m[2] === '+' ? ' open' : ''}><summary class="callout-title">${head}</summary><div class="callout-content">${content}</div></details>\n`;
        }
        return `<div class="callout callout-${escapeHtml(type)}"><div class="callout-title">${head}</div>${content ? `<div class="callout-content">${content}</div>` : ''}</div>\n`;
      },
    },
  });

  return (content: string, override?: Partial<RenderContext>): string => {
    const prev = ctx;
    ctx = { ...ctxBase, ...override };
    taskIndex = 0;
    try {
      const { body } = splitFrontmatter(content);
      const html = marked.parse(preprocess(body), { async: false }) as string;
      return DOMPurify.sanitize(html, {
        ADD_ATTR: ['target', 'open', 'role', 'data-task', 'data-status', 'data-src', 'aria-checked', 'tabindex', 'controls', 'preload', 'loading'],
        ADD_TAGS: ['iframe', 'audio', 'video', 'details', 'summary'],
      });
    } finally {
      ctx = prev;
    }
  };
}

/** Extract the part of a note an embed points at: a heading's section or a ^block. */
export function extractSection(content: string, heading?: string): string {
  const { body } = splitFrontmatter(content);
  if (!heading) return body;
  const lines = body.split('\n');
  if (heading.startsWith('^')) {
    const id = heading.slice(1);
    const i = lines.findIndex((l) => new RegExp(`\\s\\^${id.replace(/[-]/g, '\\-')}\\s*$`).test(l));
    if (i === -1) return `*Block ^${id} not found*`;
    // A block is the paragraph / list item containing the marker.
    let start = i;
    while (start > 0 && lines[start - 1].trim() !== '' && !/^\s*([-*+]|\d+\.)\s/.test(lines[start])) start--;
    return lines.slice(start, i + 1).join('\n');
  }
  const want = slugify(heading);
  const i = lines.findIndex((l) => /^#{1,6}\s/.test(l) && slugify(l.replace(/^#+\s*/, '')) === want);
  if (i === -1) return `*Heading “${heading}” not found*`;
  const level = /^(#+)/.exec(lines[i])![1].length;
  let end = lines.length;
  for (let j = i + 1; j < lines.length; j++) {
    const h = /^(#{1,6})\s/.exec(lines[j]);
    if (h && h[1].length <= level) {
      end = j;
      break;
    }
  }
  return lines.slice(i, end).join('\n');
}

/** Line numbers (1-based) of every task item, in document order, skipping code blocks. */
export function taskLines(content: string): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  content.split('\n').forEach((line, i) => {
    const f = /^(```|~~~)/.exec(line.trim());
    if (f) {
      if (!fence) fence = f[1];
      else if (line.trim().startsWith(fence)) fence = null;
      return;
    }
    if (!fence && /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[.\]\s/.test(line)) out.push(i + 1);
  });
  return out;
}

export function wordCount(content: string): { words: number; chars: number } {
  const { body } = splitFrontmatter(content);
  const words = body.replace(/```[\s\S]*?```/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return { words: words ? words.length : 0, chars: body.length };
}
