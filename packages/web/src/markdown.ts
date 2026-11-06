import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import YAML from 'yaml';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function splitFrontmatter(content: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return { frontmatter: null, body: content };
  let fm: Record<string, unknown> | null = null;
  try {
    const v = YAML.parse(m[1]);
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

interface WikiToken extends Tokens.Generic {
  type: 'wikilink';
  target: string;
  heading?: string;
  alias?: string;
  embed: boolean;
}

interface TagToken extends Tokens.Generic {
  type: 'hashtag';
  tag: string;
}

/**
 * Build a Markdown renderer. `exists(name)` tells whether a wikilink target
 * exists, so unresolved links can be styled differently.
 */
export function createRenderer(exists: (target: string) => boolean) {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    extensions: [
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
          const inner = parseWikiInner(m[2]);
          return { type: 'wikilink', raw: m[0], embed: m[1] === '!', ...inner } as WikiToken;
        },
        renderer(token) {
          const t = token as WikiToken;
          const label = t.alias ?? (t.target ? t.target.split('/').pop()! : '') + (t.heading ? (t.target ? ' › ' : '') + t.heading : '');
          const resolved = !t.target || exists(t.target);
          const cls = `wikilink${resolved ? '' : ' unresolved'}${t.embed ? ' embed' : ''}`;
          return `<a class="${cls}" href="#" data-target="${escapeHtml(t.target)}" data-heading="${escapeHtml(t.heading ?? '')}">${escapeHtml(label)}</a>`;
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
          return { type: 'hashtag', raw: m[0], tag: m[1].toLowerCase() } as TagToken;
        },
        renderer(token) {
          const t = token as TagToken;
          return `<a class="tag" href="#" data-tag="${escapeHtml(t.tag)}">#${escapeHtml(t.tag)}</a>`;
        },
      },
    ],
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
    },
  });

  return (content: string): string => {
    const { body } = splitFrontmatter(content);
    const html = marked.parse(body, { async: false }) as string;
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  };
}

export function wordCount(content: string): number {
  const { body } = splitFrontmatter(content);
  const words = body
    .replace(/```[\s\S]*?```/g, ' ')
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}
