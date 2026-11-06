/**
 * The web viewer's reader mode and clipper: fetch a page, keep the article, and give it back as clean
 * HTML (for reading) and Markdown (for saving as a note).
 *
 * Only public http(s) addresses are fetched: anything resolving to a private, loopback or link-local
 * address is refused, at every redirect, so the viewer can't be used to poke at the local network.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import domino from '@mixmark-io/domino';
import TurndownService from 'turndown';

export interface ReadablePage {
  url: string;
  title: string;
  siteName?: string;
  byline?: string;
  excerpt?: string;
  html: string;
  markdown: string;
}

export class WebReadError extends Error {}

function privateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

async function assertPublic(u: URL, allowPrivate = false): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new WebReadError('Only http and https pages can be opened');
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new WebReadError('Local addresses can’t be opened in the web viewer');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => {
    throw new WebReadError(`Couldn’t find ${host}`);
  });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new WebReadError('Local network addresses can’t be opened in the web viewer');
}

const MAX_BYTES = 5 * 1024 * 1024;

async function fetchPage(start: string, allowPrivate = false): Promise<{ url: string; html: string }> {
  let url: URL;
  try {
    url = new URL(start);
  } catch {
    throw new WebReadError('That isn’t a web address');
  }
  for (let hop = 0; hop < 6; hop++) {
    await assertPublic(url, allowPrivate);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OctavoReader/1.0)', Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      });
    } catch (err) {
      clearTimeout(timer);
      throw new WebReadError(ctrl.signal.aborted ? 'The page took too long to load' : `Couldn’t load the page: ${(err as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer);
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    try {
      if (!res.ok) throw new WebReadError(`The site answered ${res.status} ${res.statusText}`);
      const type = res.headers.get('content-type') ?? '';
      if (type && !/html|xml|text\/plain/i.test(type)) throw new WebReadError('That address isn’t a web page (it’s a file). Open it in your browser instead.');
      const reader = res.body?.getReader();
      if (!reader) return { url: url.toString(), html: '' };
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
      const buf = Buffer.concat(chunks);
      const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1'))?.[1] ?? 'utf-8';
      let html: string;
      try {
        html = new TextDecoder(charset).decode(buf);
      } catch {
        html = buf.toString('utf8');
      }
      if (/text\/plain/i.test(type)) html = `<pre>${html.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`;
      return { url: url.toString(), html };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new WebReadError('Too many redirects');
}

const DROP = 'script,style,noscript,iframe,object,embed,form,button,input,select,textarea,svg,canvas,nav,footer,aside,dialog,template,[hidden],[aria-hidden="true"],[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="dialog"]';
const NOISE = /(^|[-_ ])(comment|share|social|related|promo|advert|ad|ads|sponsor|newsletter|subscribe|cookie|banner|sidebar|popup|modal|breadcrumb|footer|header|nav|menu|widget|toolbar)s?([-_ ]|$)/i;

type El = { tagName: string; textContent: string | null; querySelectorAll(s: string): ArrayLike<El>; getAttribute(n: string): string | null; setAttribute(n: string, v: string): void; removeAttribute(n: string): void; remove(): void; attributes: ArrayLike<{ name: string }>; innerHTML: string; parentNode: unknown; children: ArrayLike<El> };

function textLen(el: El): number {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

function linkDensity(el: El): number {
  const total = textLen(el) || 1;
  let links = 0;
  for (const a of Array.from(el.querySelectorAll('a'))) links += textLen(a);
  return links / total;
}

/** Pick the element that holds the article: the one with the most paragraph text and few links. */
function pickContent(doc: { body: El; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> }): El {
  const explicit = doc.querySelector('article') ?? doc.querySelector('[itemprop="articleBody"]') ?? doc.querySelector('main') ?? doc.querySelector('[role="main"]');
  if (explicit && textLen(explicit) > 400) return explicit;
  const scores = new Map<El, number>();
  for (const p of Array.from(doc.querySelectorAll('p, pre, li, blockquote'))) {
    const len = textLen(p);
    if (len < 40) continue;
    const parent = p.parentNode as El | null;
    if (!parent || !(parent as El).tagName) continue;
    const add = Math.min(len / 100, 3) + 1;
    scores.set(parent, (scores.get(parent) ?? 0) + add);
    const grand = (parent as unknown as { parentNode: El | null }).parentNode;
    if (grand && grand.tagName) scores.set(grand, (scores.get(grand) ?? 0) + add / 2);
  }
  let best: El | null = null;
  let bestScore = 0;
  for (const [el, s] of scores) {
    const score = s * (1 - linkDensity(el));
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best ?? explicit ?? doc.body;
}

/** `allowPrivate` is for tests only: the app never passes it. */
export async function readPage(target: string, opts: { allowPrivate?: boolean } = {}): Promise<ReadablePage> {
  const { url, html } = await fetchPage(target, opts.allowPrivate);
  const doc = domino.createDocument(html) as unknown as {
    title: string;
    body: El;
    querySelector(s: string): El | null;
    querySelectorAll(s: string): ArrayLike<El>;
  };
  const meta = (name: string) =>
    doc.querySelector(`meta[property="${name}"]`)?.getAttribute('content') ?? doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? undefined;
  const title = (meta('og:title') ?? doc.title ?? '').trim() || new URL(url).hostname;
  for (const el of Array.from(doc.querySelectorAll(DROP))) el.remove();
  for (const el of Array.from(doc.querySelectorAll('[class],[id]'))) {
    const key = `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`;
    if (NOISE.test(key) && !/article|content|post|entry|story|body|main/i.test(key) && el.tagName !== 'BODY' && el.tagName !== 'HTML') el.remove();
  }
  const content = pickContent(doc);
  // Absolute links and images; lazy-loaded images; no attributes beyond the useful ones.
  const abs = (v: string | null) => {
    if (!v) return null;
    try {
      return new URL(v, url).toString();
    } catch {
      return null;
    }
  };
  for (const img of Array.from(content.querySelectorAll('img'))) {
    const src = img.getAttribute('data-src') ?? img.getAttribute('data-lazy-src') ?? img.getAttribute('src') ?? img.getAttribute('srcset')?.split(/\s+/)[0] ?? null;
    const a = abs(src);
    if (a && /^https?:/.test(a)) img.setAttribute('src', a);
    else img.remove();
  }
  const KEEP = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan']);
  for (const el of Array.from(content.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes).map((x) => x.name)) if (!KEEP.has(attr.toLowerCase())) el.removeAttribute(attr);
    if (el.tagName === 'A') {
      const h = abs(el.getAttribute('href'));
      if (h && /^(https?|mailto):/.test(h)) el.setAttribute('href', h);
      else el.removeAttribute('href');
    }
  }
  const cleanHtml = content.innerHTML.replace(/<(p|div|span)>\s*<\/\1>/g, '').trim();
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  td.remove(['script', 'style']);
  const markdown = td
    .turndown(cleanHtml)
    .replace(/^(\s*)([-*+]|\d+\.)\s{2,}/gm, '$1$2 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    url,
    title,
    siteName: meta('og:site_name'),
    byline: meta('author'),
    excerpt: meta('og:description') ?? meta('description'),
    html: cleanHtml,
    markdown,
  };
}

/** A note for a clipped page: properties with the source, then the article. */
export function clipNote(page: ReadablePage, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  const q = (s: string) => JSON.stringify(s);
  const fm = [`source: ${q(page.url)}`, `clipped: ${day}`, ...(page.byline ? [`author: ${q(page.byline)}`] : []), ...(page.siteName ? [`site: ${q(page.siteName)}`] : []), 'tags: [clipping]'];
  return `---\n${fm.join('\n')}\n---\n# ${page.title.replace(/\n/g, ' ')}\n\n${page.excerpt ? `> ${page.excerpt.replace(/\n/g, ' ')}\n\n` : ''}${page.markdown}\n`;
}
