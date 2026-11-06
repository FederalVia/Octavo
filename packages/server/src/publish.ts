/**
 * Publish notes as a static website: plain HTML pages you can host anywhere (GitHub Pages, Netlify,
 * a USB stick). No server, no account, nothing paid.
 *
 * Which notes: those marked `publish: true` in their properties (the default), or a folder, a tag,
 * or everything. Locked notes and notes marked `publish: false` are never published. Links to notes
 * that aren't published become plain text, so nothing private leaks through a link.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Marked, type Tokens } from 'marked';
import markedFootnote from 'marked-footnote';
import markedKatex from 'marked-katex-extension';
import type { IndexedNote, QueryValue, Vault } from '@octavo/core';
import { VERSION } from './version.js';

export interface PublishOptions {
  /** Which notes: marked with `publish: true` (default), all, a folder or a tag. */
  scope?: 'marked' | 'all';
  folder?: string;
  tag?: string;
  /** Site title (default: the vault folder's name). */
  title?: string;
}

export interface PublishedSite {
  /** Site-relative path → content. */
  files: Map<string, string | Buffer>;
  pages: number;
  attachments: number;
  /** Notes skipped because they're locked. */
  skippedLocked: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

/** A URL-safe file name for a path segment. */
function slugSegment(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'note'
  );
}

/** Relative URL from one site file to another. */
function rel(from: string, to: string): string {
  const r = path.posix.relative(path.posix.dirname(from), to);
  return encodeURI(r || path.posix.basename(to)).replace(/#/g, '%23').replace(/\?/g, '%3F');
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

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|flac|webm)$/i;
const VIDEO_EXT = /\.(mp4|mov|mkv|ogv)$/i;
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|mp3|wav|m4a|ogg|flac|webm|mp4|mov|mkv|ogv|pdf)$/i;

function isPublishMarked(n: IndexedNote): boolean {
  const v = n.frontmatter.publish ?? n.frontmatter.Publish;
  return v === true || (typeof v === 'string' && /^(true|yes|on)$/i.test(v.trim()));
}

function isPublishBlocked(n: IndexedNote): boolean {
  const v = n.frontmatter.publish ?? n.frontmatter.Publish;
  return v === false || (typeof v === 'string' && /^(false|no|off)$/i.test(v.trim()));
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
}

function preprocess(body: string): string {
  const stash: string[] = [];
  const protect = (m: string) => `\u0000${stash.push(m) - 1}\u0000`;
  let text = body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, protect).replace(/`[^`\n]+`/g, protect);
  text = text.replace(/%%[\s\S]*?%%/g, '');
  text = text.replace(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/gm, (_m, id) => ` <span class="block-anchor" id="block-${id}"></span>`);
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)]);
}

function section(content: string, heading?: string): string {
  const body = stripFrontmatter(content);
  if (!heading) return body;
  const lines = body.split('\n');
  if (heading.startsWith('^')) {
    const i = lines.findIndex((l) => l.trimEnd().endsWith(` ${heading}`));
    if (i < 0) return '';
    let start = i;
    while (start > 0 && lines[start - 1].trim() !== '') start--;
    return lines.slice(start, i + 1).join('\n');
  }
  const want = slugify(heading);
  const i = lines.findIndex((l) => /^#{1,6}\s/.test(l) && slugify(l.replace(/^#+\s*/, '')) === want);
  if (i < 0) return '';
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

export async function buildSite(vault: Vault, opts: PublishOptions = {}): Promise<PublishedSite> {
  const all = vault.allNotes();
  const folder = opts.folder?.replace(/^\/+|\/+$/g, '');
  const tag = opts.tag?.replace(/^#/, '').toLowerCase();
  let skippedLocked = 0;
  const chosen = all.filter((n) => {
    if (n.path.startsWith('.') || isPublishBlocked(n)) return false;
    let pick: boolean;
    if (folder !== undefined) pick = folder === '' || n.folder === folder || n.folder.startsWith(folder + '/');
    else if (tag) pick = n.tags.some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(tag + '/'));
    else pick = isPublishMarked(n) || (opts.scope === 'all' && !/^templates(\/|$)/i.test(n.folder));
    if (pick && n.encrypted) {
      skippedLocked++;
      return false;
    }
    return pick;
  });

  // Page URLs: folders and names slugged, collisions numbered.
  const urlOf = new Map<string, string>();
  const used = new Set<string>(['index.html', 'search.html']);
  const homePath = vault.overview().home?.path;
  for (const n of [...chosen].sort((a, b) => a.path.localeCompare(b.path))) {
    if (n.path === homePath) {
      urlOf.set(n.path, 'index.html');
      continue;
    }
    const segs = n.path.replace(/\.md$/i, '').split('/').map(slugSegment);
    let base = segs.join('/');
    if (base === 'tags' || base.startsWith('tags/') || base === 'assets' || base.startsWith('assets/')) base = `notes/${base}`;
    let url = `${base}.html`;
    for (let i = 2; used.has(url); i++) url = `${base}-${i}.html`;
    used.add(url);
    urlOf.set(n.path, url);
  }

  const files = new Map<string, string | Buffer>();
  const attachmentUrl = new Map<string, string>();
  const attach = (ref: string, fromPath: string): string | null => {
    const vaultRel = vault.resolveAttachment(ref, fromPath);
    if (!vaultRel) return null;
    if (!attachmentUrl.has(vaultRel)) {
      const segs = vaultRel.split('/');
      const name = segs.pop()!;
      const ext = path.posix.extname(name);
      let url = `assets/${[...segs.map(slugSegment), slugSegment(name.slice(0, name.length - ext.length)) + ext.toLowerCase()].join('/')}`;
      for (let i = 2; [...attachmentUrl.values()].includes(url); i++) url = url.replace(/(\.[^.]+)$/, `-${i}$1`);
      attachmentUrl.set(vaultRel, url);
    }
    return attachmentUrl.get(vaultRel)!;
  };

  const tagUrl = (t: string) => `tags/${slugSegment(t.replace(/\//g, '-'))}.html`;
  const tagsUsed = new Map<string, Set<string>>();

  /** Render one note's Markdown for the page at `pageUrl`. */
  const render = (content: string, fromPath: string, pageUrl: string, depth = 0): string => {
    const linkTo = (target: string, heading?: string): string | null => {
      const p = target ? vault.resolveLink({ target }, fromPath) : fromPath;
      if (!p) return null;
      const u = urlOf.get(p);
      if (!u) return null;
      const anchor = heading ? `#${heading.startsWith('^') ? `block-${heading.slice(1)}` : slugify(heading)}` : '';
      return (p === fromPath && depth === 0 ? '' : rel(pageUrl, u)) + anchor;
    };
    const media = (ref: string, alt?: string): string => {
      const u = attach(ref, fromPath);
      if (!u) return `<span class="missing">${esc(ref)}</span>`;
      const src = rel(pageUrl, u);
      const a = esc(alt && !/^\d+(x\d+)?$/.test(alt) ? alt : '');
      const size = alt && /^\d+(x\d+)?$/.test(alt) ? ` width="${alt.split('x')[0]}"` : '';
      if (IMAGE_EXT.test(ref)) return `<img src="${src}" alt="${a}"${size} loading="lazy">`;
      if (AUDIO_EXT.test(ref)) return `<audio controls preload="metadata" src="${src}"></audio>`;
      if (VIDEO_EXT.test(ref)) return `<video controls preload="metadata" src="${src}"${size}></video>`;
      return `<a href="${src}">${esc(alt || path.posix.basename(ref))}</a>`;
    };

    const marked = new Marked({ gfm: true, breaks: false });
    const inner = new Marked({ gfm: true, breaks: false });
    marked.use(markedFootnote({ description: 'Footnotes', refMarkers: true }));
    const katex = markedKatex({ throwOnError: false, nonStandard: true, output: 'html' });
    marked.use(katex);
    inner.use(katex);
    const extensions: Parameters<typeof marked.use>[0]['extensions'] = [
      {
        name: 'wikilink',
        level: 'inline',
        start: (src: string) => {
          const i = src.search(/!?\[\[/);
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string) {
          const m = /^(!?)\[\[([^[\]\n]+?)\]\]/.exec(src);
          if (!m) return undefined;
          const [main, alias] = m[2].split('|');
          const hashAt = main.indexOf('#');
          const target = (hashAt < 0 ? main : main.slice(0, hashAt)).trim();
          const heading = hashAt < 0 ? undefined : main.slice(hashAt + 1).trim();
          return { type: 'wikilink', raw: m[0], embed: m[1] === '!', target, heading, alias: alias?.trim() };
        },
        renderer(token) {
          const t = token as Tokens.Generic & { target: string; heading?: string; alias?: string; embed: boolean };
          if (t.embed && MEDIA_EXT.test(t.target)) return media(t.target, t.alias);
          if (t.embed) {
            const p = vault.resolveLink({ target: t.target }, fromPath);
            const note = p ? all.find((n) => n.path === p) : undefined;
            if (!note || !urlOf.has(note.path) || depth >= 2) return '';
            const href = linkTo(t.target, t.heading);
            return `<div class="embed"><div class="embed-title"><a href="${href}">${esc(note.name)}${t.heading ? ` › ${esc(t.heading.replace(/^\^/, ''))}` : ''}</a></div>${render(section(note.content, t.heading), note.path, pageUrl, depth + 1)}</div>`;
          }
          const label = t.alias ?? (t.target ? t.target.split('/').pop()! : '') + (t.heading && !t.heading.startsWith('^') ? (t.target ? ' › ' : '') + t.heading : '');
          const href = linkTo(t.target, t.heading);
          return href === null ? `<span class="unpublished">${esc(label || t.target)}</span>` : `<a class="internal" href="${href || '#'}">${esc(label || t.target)}</a>`;
        },
      },
      {
        name: 'highlight',
        level: 'inline',
        start: (src: string) => {
          const i = src.indexOf('==');
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string) {
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
        start: (src: string) => {
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
          return `<a class="tag" href="${rel(pageUrl, tagUrl(t.tag))}">#${esc(t.tag)}</a>`;
        },
      },
    ];
    inner.use({ extensions });
    marked.use({
      extensions,
      renderer: {
        heading({ tokens, depth: d, text }) {
          return `<h${d} id="${slugify(text)}">${this.parser.parseInline(tokens)}</h${d}>\n`;
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
            const u = linkTo(target.replace(/\.md$/i, ''), h);
            return u === null ? `<span class="unpublished">${html}</span>` : `<a class="internal" href="${u || '#'}">${html}</a>`;
          }
          if (!external && !href.startsWith('#') && MEDIA_EXT.test(href)) {
            const u = attach(decodeURIComponent(href), fromPath);
            if (u) return `<a href="${rel(pageUrl, u)}">${html}</a>`;
          }
          return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${external ? ' rel="noopener"' : ''}>${html}</a>`;
        },
        image({ href, text }) {
          if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return `<img src="${esc(href)}" alt="${esc(text)}" loading="lazy">`;
          let ref = href;
          try {
            ref = decodeURI(href);
          } catch {
            /* keep */
          }
          return media(ref, text);
        },
        code({ text, lang }) {
          if (lang === 'mermaid') return `<pre class="mermaid">${esc(text)}</pre>\n`;
          if (lang === 'query' || lang === 'dataview' || lang === 'base') return queryHtml(text, lang === 'base' ? 'base' : 'dql', fromPath, pageUrl);
          if (lang === 'tasks') return '';
          return false;
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
          const done = status === 'x' || status === 'X' || status === '-';
          return `<li class="task${done ? ' done' : ''}"><span class="box" data-status="${esc(status)}">${status === 'x' || status === 'X' ? '✓' : status === ' ' ? '' : esc(status)}</span>${body}</li>\n`;
        },
        checkbox() {
          return '';
        },
        blockquote(token) {
          const m = /^\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/.exec(token.text.split('\n')[0]);
          if (!m) return `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`;
          const raw = m[1].toLowerCase();
          const type = CALLOUT_ALIASES[raw] ?? raw;
          const title = m[3] || raw.charAt(0).toUpperCase() + raw.slice(1);
          const body = token.text.split('\n').slice(1).join('\n');
          const content = body.trim() ? this.parser.parse(inner.lexer(body)) : '';
          const head = `<span class="callout-icon">${CALLOUT_ICONS[raw] ?? CALLOUT_ICONS[type] ?? '✎'}</span><span>${this.parser.parseInline(marked.Lexer.lexInline(title))}</span>`;
          if (m[2]) return `<details class="callout callout-${esc(type)}"${m[2] === '+' ? ' open' : ''}><summary class="callout-title">${head}</summary><div class="callout-content">${content}</div></details>\n`;
          return `<div class="callout callout-${esc(type)}"><div class="callout-title">${head}</div>${content ? `<div class="callout-content">${content}</div>` : ''}</div>\n`;
        },
        html({ text }) {
          // Raw HTML is kept, except scripts and inline event handlers.
          return text.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
        },
      },
    });
    return marked.parse(preprocess(content), { async: false }) as string;
  };

  /** A query block as a static table, linking only to published notes. */
  const queryHtml = (src: string, lang: 'base' | 'dql', fromPath: string, pageUrl: string): string => {
    const r = vault.query(src, { lang, thisPath: fromPath });
    const rows = r.rows.filter((row) => urlOf.has(row.path));
    if (r.errors.length || !rows.length) return '';
    const val = (v: QueryValue): string => {
      if (v == null || v === '') return '';
      if (Array.isArray(v)) return v.map(val).join(', ');
      if (typeof v === 'boolean') return v ? '✓' : '✗';
      return esc(String(v)).replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => {
        const p = vault.resolveLink({ target: t.trim() }, fromPath);
        const u = p && urlOf.get(p);
        return u ? `<a class="internal" href="${rel(pageUrl, u)}">${a ?? t}</a>` : (a ?? t);
      });
    };
    const name = (row: (typeof rows)[number]) => `<a class="internal" href="${rel(pageUrl, urlOf.get(row.path)!)}">${esc(row.name)}</a>`;
    if (r.view === 'cards') {
      return `<div class="cards">${rows
        .map((row) => `<div class="card">${r.showName ? `<div class="card-title">${name(row)}</div>` : ''}${r.columns.map((c, i) => (val(row.values[i]) ? `<div class="card-field"><span>${esc(c.label)}</span>${val(row.values[i])}</div>` : '')).join('')}</div>`)
        .join('')}</div>\n`;
    }
    if (r.view !== 'table' || !r.columns.length) {
      return `<ul class="query">${rows.map((row) => `<li>${r.showName ? name(row) : ''}${row.values.map(val).filter(Boolean).map((x) => ` · ${x}`).join('')}</li>`).join('')}</ul>\n`;
    }
    const head = `${r.showName ? '<th>Note</th>' : ''}${r.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}`;
    const body = rows.map((row) => `<tr>${r.showName ? `<td>${name(row)}</td>` : ''}${row.values.map((v) => `<td>${val(v)}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table class="query"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>\n`;
  };

  const title = opts.title?.trim() || path.basename(vault.root);
  const searchIndex: { t: string; u: string; f: string; x: string }[] = [];

  for (const n of chosen) {
    const url = urlOf.get(n.path)!;
    const h1 = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(stripFrontmatter(n.content).replace(/%%[\s\S]*?%%/g, '').trimStart().split('\n')[0] ?? '')?.[1];
    const fmTitle = typeof n.frontmatter.title === 'string' ? n.frontmatter.title : h1?.replace(/[*_`=]/g, '') ?? n.name;
    const description = typeof n.frontmatter.description === 'string' ? n.frontmatter.description : undefined;
    const bodyHtml = render(stripFrontmatter(n.content), n.path, url);
    const startsWithH1 = /^\s*#\s/.test(stripFrontmatter(n.content).replace(/%%[\s\S]*?%%/g, ''));
    for (const t of n.tags) {
      const set = tagsUsed.get(t.toLowerCase()) ?? new Set<string>();
      set.add(n.path);
      tagsUsed.set(t.toLowerCase(), set);
    }
    const backlinks = vault
      .backlinks(n.path)
      .filter((b) => urlOf.has(b.path))
      .map((b) => `<li><a class="internal" href="${rel(url, urlOf.get(b.path)!)}">${esc(b.name)}</a></li>`);
    const tags = n.tags.length ? `<div class="tags">${n.tags.map((t) => `<a class="tag" href="${rel(url, tagUrl(t.toLowerCase()))}">#${esc(t)}</a>`).join(' ')}</div>` : '';
    const crumbs = n.folder ? `<div class="crumbs">${esc(n.folder.split('/').join(' / '))}</div>` : '';
    const updated = new Date(n.mtime).toISOString().slice(0, 10);
    const main = `${crumbs}${startsWithH1 ? '' : `<h1>${esc(fmTitle)}</h1>`}${tags}<div class="content">${bodyHtml}</div>${
      backlinks.length ? `<section class="backlinks"><h2>Linked from</h2><ul>${backlinks.join('')}</ul></section>` : ''
    }<footer class="meta">Updated ${updated}</footer>`;
    files.set(url, page({ title: fmTitle, site: title, url, main, description }));
    searchIndex.push({
      t: fmTitle,
      u: url,
      f: n.folder,
      x: stripFrontmatter(n.content)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/%%[\s\S]*?%%/g, ' ')
        .replace(/\s\^[A-Za-z0-9-]+\s*$/gm, ' ')
        .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
        .replace(/[#>*_`=[\]|!-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000),
    });
  }

  // Home page: the vault's home note if published, otherwise a list of everything.
  if (!files.has('index.html')) {
    const byFolder = new Map<string, IndexedNote[]>();
    for (const n of chosen) {
      if (!byFolder.has(n.folder)) byFolder.set(n.folder, []);
      byFolder.get(n.folder)!.push(n);
    }
    const sections = [...byFolder]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([f, ns]) =>
          `<section class="folder"><h2>${esc(f || 'Notes')}</h2><ul>${ns
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((n) => `<li><a class="internal" href="${rel('index.html', urlOf.get(n.path)!)}">${esc(n.name)}</a></li>`)
            .join('')}</ul></section>`,
      )
      .join('');
    const empty = chosen.length ? '' : '<p class="muted">No notes are published yet. Add <code>publish: true</code> to a note\'s properties, or publish a folder or tag.</p>';
    files.set('index.html', page({ title, site: title, url: 'index.html', main: `<h1>${esc(title)}</h1>${empty}${sections}` }));
  }

  for (const [t, paths] of tagsUsed) {
    const url = tagUrl(t);
    const items = [...paths]
      .map((p) => chosen.find((n) => n.path === p)!)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((n) => `<li><a class="internal" href="${rel(url, urlOf.get(n.path)!)}">${esc(n.name)}</a></li>`)
      .join('');
    files.set(url, page({ title: `#${t}`, site: title, url, main: `<h1>#${esc(t)}</h1><ul>${items}</ul>` }));
  }

  files.set('search.html', page({ title: 'Search', site: title, url: 'search.html', main: '<h1>Search</h1><div id="results"></div>' }));
  files.set('assets/site.css', SITE_CSS);
  files.set('assets/site.js', SITE_JS);
  files.set('assets/search.json', JSON.stringify(searchIndex));
  files.set('.nojekyll', '');

  for (const [vaultRel, url] of attachmentUrl) {
    try {
      files.set(url, await fs.readFile(vault.filePath(vaultRel)));
    } catch {
      /* gone since it was linked */
    }
  }

  return { files, pages: chosen.length, attachments: attachmentUrl.size, skippedLocked };
}

function page(p: { title: string; site: string; url: string; main: string; description?: string }): string {
  const root = (to: string) => rel(p.url, to);
  const hasMath = p.main.includes('class="katex');
  const hasMermaid = p.main.includes('class="mermaid"');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title === p.site ? p.site : `${p.title} · ${p.site}`)}</title>
${p.description ? `<meta name="description" content="${esc(p.description)}">\n` : ''}<meta name="generator" content="Octavo ${VERSION}">
<link rel="stylesheet" href="${root('assets/site.css')}">
${hasMath ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.18.10/dist/katex.min.css">\n' : ''}</head>
<body data-root="${esc(root('index.html').replace(/index\.html$/, ''))}">
<header class="top">
  <a class="site" href="${root('index.html')}">${esc(p.site)}</a>
  <form class="search" action="${root('search.html')}"><input type="search" name="q" placeholder="Search" aria-label="Search"></form>
</header>
<main>${p.main}</main>
<script src="${root('assets/site.js')}" defer></script>
${hasMermaid ? '<script type="module">import m from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs"; m.initialize({ startOnLoad: true, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });</script>\n' : ''}</body>
</html>
`;
}

const SITE_CSS = `:root{--bg:#fbfaf7;--fg:#22211e;--muted:#6f6b63;--line:#e6e2d9;--accent:#b4570f;--soft:#f2eee6;--mark:#ffe58a}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#e8e6e1;--muted:#9a978f;--line:#2c2c33;--accent:#ffb35c;--soft:#202027;--mark:#6b5a12}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif}
.top{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:16px;justify-content:space-between;padding:10px 20px;background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.site{font-weight:700;color:var(--fg);text-decoration:none;letter-spacing:-.01em}
.search input{width:min(240px,45vw);padding:6px 12px;border:1px solid var(--line);border-radius:999px;background:var(--soft);color:var(--fg);font:inherit;font-size:14px}
main{max-width:740px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:2em;line-height:1.2;letter-spacing:-.02em;margin:.2em 0 .5em}h2{margin-top:1.8em}h1,h2,h3,h4{line-height:1.25}
a{color:var(--accent)}a.internal{text-decoration-thickness:1px;text-underline-offset:3px}
.unpublished{color:var(--muted)}.missing{color:var(--muted);font-style:italic}
.crumbs,.meta,.muted{color:var(--muted);font-size:14px}.meta{margin-top:48px}
.tags{margin:-.2em 0 1.2em;display:flex;flex-wrap:wrap;gap:6px}
.tag{font-size:14px;text-decoration:none;background:var(--soft);border:1px solid var(--line);border-radius:999px;padding:1px 9px}
img,video{max-width:100%;height:auto;border-radius:8px}audio{width:100%}
pre{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto;font-size:14px;line-height:1.5}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}:not(pre)>code{background:var(--soft);padding:.1em .35em;border-radius:4px}
blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid var(--line);color:var(--muted)}
mark{background:var(--mark);color:inherit;border-radius:3px;padding:0 2px}
mark.hl-red{background:#ff7a7a55}mark.hl-orange{background:#ffa64d55}mark.hl-green{background:#5ed38a55}mark.hl-blue{background:#5aa2ff55}mark.hl-purple{background:#b79bff55}
.table-wrap{overflow-x:auto}table{border-collapse:collapse;margin:1em 0;font-size:15px}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--soft)}
table.query{width:100%}
li.task{list-style:none;margin-left:-1.4em}li.task .box{display:inline-flex;align-items:center;justify-content:center;width:1em;height:1em;margin-right:.45em;border:1.5px solid var(--muted);border-radius:4px;font-size:.8em;vertical-align:-.1em}
li.task.done>.box{background:var(--accent);border-color:var(--accent);color:var(--bg)}li.task.done{color:var(--muted)}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
.callout{--c:96,165,250;border-left:3px solid rgb(var(--c));background:rgba(var(--c),.09);border-radius:6px;padding:8px 14px;margin:1em 0}
.callout-title{display:flex;gap:8px;font-weight:600;color:rgb(var(--c))}details.callout>summary{cursor:pointer;list-style:none}
.callout-content>:first-child{margin-top:.4em}.callout-content>:last-child{margin-bottom:.2em}
.callout-abstract{--c:45,212,191}.callout-tip{--c:52,211,153}.callout-success{--c:74,222,128}.callout-question{--c:251,191,36}.callout-warning{--c:251,146,60}.callout-failure,.callout-danger,.callout-bug{--c:248,113,113}.callout-example{--c:192,132,252}.callout-quote{--c:156,163,175}
.embed{border-left:3px solid var(--line);padding:2px 0 2px 14px;margin:1em 0}.embed-title{font-size:14px;margin-bottom:4px}
.backlinks{margin-top:56px;padding-top:12px;border-top:1px solid var(--line)}.backlinks h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 6px}
.folder h2{font-size:1.1em}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin:1em 0}.card{border:1px solid var(--line);border-radius:10px;padding:10px 14px;background:var(--soft)}.card-title{font-weight:600}.card-field{font-size:14px;display:flex;flex-direction:column}.card-field span{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
#results .hit{margin:14px 0}#results .hit p{margin:2px 0;color:var(--muted);font-size:15px}
.footnotes{font-size:15px;color:var(--muted)}
@media (max-width:600px){body{font-size:16px}main{padding:20px 16px 64px}h1{font-size:1.7em}}
`;

const SITE_JS = `(function(){
var root=document.body.getAttribute('data-root')||'';
var input=document.querySelector('.search input');
var params=new URLSearchParams(location.search);
var out=document.getElementById('results');
if(input&&params.get('q'))input.value=params.get('q');
if(!out)return;
var q=(params.get('q')||'').trim().toLowerCase();
if(!q){out.innerHTML='<p class="muted">Type in the search box above.</p>';return;}
fetch(root+'assets/search.json').then(function(r){return r.json()}).then(function(pages){
  var words=q.split(/\\s+/);
  var hits=pages.map(function(p){
    var t=p.t.toLowerCase(),x=p.x.toLowerCase(),score=0;
    for(var i=0;i<words.length;i++){var w=words[i];if(t.indexOf(w)>=0)score+=10;else if(x.indexOf(w)>=0)score+=1;else return null;}
    var at=x.indexOf(words[0]);var st=Math.max(0,at-60);if(st>0){var sp=p.x.indexOf(' ',st);if(sp>=0&&sp<at)st=sp+1;}var snip=at<0?p.x.slice(0,160):(st>0?'…':'')+p.x.slice(st,at+120);
    return {p:p,score:score,snip:snip};
  }).filter(Boolean).sort(function(a,b){return b.score-a.score}).slice(0,50);
  var esc=function(s){return s.replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};
  out.innerHTML=hits.length?hits.map(function(h){return '<div class="hit"><a class="internal" href="'+root+encodeURI(h.p.u)+'">'+esc(h.p.t)+'</a>'+(h.p.f?' <span class="muted">'+esc(h.p.f)+'</span>':'')+'<p>'+esc(h.snip)+'…</p></div>'}).join(''):'<p class="muted">Nothing found.</p>';
}).catch(function(){out.innerHTML='<p class="muted">Search needs the site to be served over http(s), not opened as a file.</p>'});
})();
`;

/** Write a built site to a folder (created if needed). */
export async function writeSite(site: PublishedSite, outDir: string): Promise<void> {
  for (const [rel, content] of site.files) {
    const target = path.join(outDir, ...rel.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

// --- A tiny zip writer (stored, no compression), so the app can download a site in one file. ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipFiles(files: Map<string, string | Buffer>, prefix = ''): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, content] of files) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const fname = Buffer.from(prefix + name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fname.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, fname, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(fname.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, fname);
    offset += local.length + fname.length + data.length;
  }
  const cenSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
