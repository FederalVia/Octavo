/**
 * The web viewer's reader mode and clipper: fetch a page, keep the article, and give it back as clean
 * HTML (for reading) and Markdown (for saving as a note).
 *
 * Only public http(s) addresses are fetched: anything resolving to a private, loopback or link-local
 * address is refused, at every redirect, so the viewer can't be used to poke at the local network.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
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

// ---------------------------------------------------------------------------------------------
// Which addresses count as "not the public internet"

// Separate lists per family: a BlockList matches IPv4 addresses against IPv6 rules too (as ::ffff:a.b.c.d),
// so one combined list with ::ffff:0:0/96 in it would block every IPv4 address.
const BLOCKED_V4 = new net.BlockList();
const BLOCKED_V6 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], // "this network", unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (also Tailscale)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) BLOCKED_V4.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::', 96], // IPv4-compatible (deprecated): no public site resolves to these
  ['::ffff:0:0', 96], // IPv4-mapped: likewise
  ['64:ff9b::', 96], // NAT64 well-known prefix
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // old site-local
  ['ff00::', 8], // multicast
] as const) BLOCKED_V6.addSubnet(addr, prefix, 'ipv6');

/** The 16 bytes of an IPv6 address (handles "::" and a dotted IPv4 tail), or null if it isn't one. */
function ipv6Bytes(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let s = ip.replace(/%.*$/, '').toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 255];
  });
}

/** IPv4 addresses hidden inside IPv6 ones: mapped, compatible, NAT64 and 6to4. */
function embeddedIPv4(ip: string): string | null {
  const b = ipv6Bytes(ip);
  if (!b) return null;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const tail = () => b.slice(12, 16).join('.');
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return tail(); // ::ffff:a.b.c.d (mapped)
  if (zero(0, 12) && !zero(12, 16)) return tail(); // ::a.b.c.d (compatible), but not :: or ::1 (blocked anyway)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return tail(); // 64:ff9b::a.b.c.d
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6).join('.'); // 2002:aabb:ccdd:: (6to4)
  return null;
}

/** Is this address anywhere other than the public internet? Exported for tests. */
export function privateAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(addr)) return BLOCKED_V4.check(addr, 'ipv4');
  if (!net.isIPv6(addr)) return true; // not an IP address at all: refuse rather than guess
  if (BLOCKED_V6.check(addr, 'ipv6')) return true;
  // Backstop for IPv4 wrapped in IPv6 (catches 6to4, 2002::/16, carrying a private address).
  const v4 = embeddedIPv4(addr);
  return v4 !== null && BLOCKED_V4.check(v4, 'ipv4');
}

const LOCAL_NAME = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;
const BLOCKED_MESSAGE = 'Local network addresses can’t be opened in the web viewer';

type Resolved = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<Resolved[]>;
const systemResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/** Marks a refusal from inside the connection's lookup, so it can be reported as a refusal. */
class BlockedAddressError extends Error {
  readonly code = 'OCTAVO_BLOCKED_ADDRESS';
}

/**
 * A `lookup` for the connection itself: resolve once, refuse if any answer is private, and hand the
 * socket exactly the answers that were checked. There's no second resolution between "checked" and
 * "connected", so a name can't pass the check and then point somewhere else (DNS rebinding).
 * Exported for tests.
 */
export function checkedLookup(resolve: Resolver, allowPrivate = false, isPrivate: (ip: string) => boolean = privateAddress) {
  return (
    hostname: string,
    options: { family?: number | string; all?: boolean } | number | undefined,
    callback: (err: NodeJS.ErrnoException | null, address?: string | Resolved[], family?: number) => void,
  ): void => {
    const opts = typeof options === 'object' && options ? options : {};
    const want = opts.family === 4 || opts.family === 'IPv4' ? 4 : opts.family === 6 || opts.family === 'IPv6' ? 6 : 0;
    const host = hostname.replace(/^\[|\]$/g, '');
    const finish = (list: Resolved[]) => {
      const usable = want ? list.filter((a) => a.family === want) : list;
      if (!usable.length) return callback(Object.assign(new Error(`Couldn’t find ${host}`), { code: 'ENOTFOUND' }));
      if (opts.all) callback(null, usable);
      else callback(null, usable[0].address, usable[0].family);
    };
    if (!allowPrivate && LOCAL_NAME.test(host)) return callback(new BlockedAddressError(BLOCKED_MESSAGE));
    if (net.isIP(host)) {
      if (!allowPrivate && isPrivate(host)) return callback(new BlockedAddressError(BLOCKED_MESSAGE));
      return finish([{ address: host, family: net.isIP(host) }]);
    }
    resolve(host).then(
      (list) => {
        if (!allowPrivate && (!list.length || list.some((a) => isPrivate(a.address)))) return callback(new BlockedAddressError(BLOCKED_MESSAGE));
        finish(list);
      },
      () => callback(Object.assign(new Error(`Couldn’t find ${host}`), { code: 'ENOTFOUND' })),
    );
  };
}

/** Quick refusals before connecting (scheme, local names, IP literals: those never reach `lookup`). */
function assertPublic(u: URL, allowPrivate: boolean, isPrivate: (ip: string) => boolean): void {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new WebReadError('Only http and https pages can be opened');
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (LOCAL_NAME.test(host)) throw new WebReadError('Local addresses can’t be opened in the web viewer');
  if (net.isIP(host) && isPrivate(host)) throw new WebReadError(BLOCKED_MESSAGE);
}

/** Find the refusal or DNS failure behind a fetch error (undici wraps them in `cause`). */
function causeOf(err: unknown): { blocked: boolean; notFound?: string } {
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i++) {
    const c = e as { code?: string; message?: string; cause?: unknown };
    if (c.code === 'OCTAVO_BLOCKED_ADDRESS') return { blocked: true };
    if (c.code === 'ENOTFOUND') return { blocked: false, notFound: c.message };
    e = c.cause;
  }
  return { blocked: false };
}

const MAX_BYTES = 5 * 1024 * 1024;

async function fetchPage(start: string, opts: ReadOptions = {}): Promise<{ url: string; html: string }> {
  const allowPrivate = !!opts.allowPrivate;
  const isPrivate = opts.isPrivate ?? privateAddress;
  let url: URL;
  try {
    url = new URL(start);
  } catch {
    throw new WebReadError('That isn’t a web address');
  }
  // Every connection, on every redirect hop, resolves through the checked lookup.
  const agent = new Agent({ connect: { lookup: checkedLookup(opts.resolve ?? systemResolver, allowPrivate, isPrivate) as never }, connections: 4 });
  try {
    for (let hop = 0; hop < 6; hop++) {
      assertPublic(url, allowPrivate, isPrivate);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let res: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        res = await undiciFetch(url, {
          redirect: 'manual',
          signal: ctrl.signal,
          dispatcher: agent,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OctavoReader/1.0)', Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
        });
      } catch (err) {
        clearTimeout(timer);
        const cause = causeOf(err);
        if (cause.blocked) throw new WebReadError(BLOCKED_MESSAGE);
        if (cause.notFound) throw new WebReadError(cause.notFound);
        throw new WebReadError(ctrl.signal.aborted ? 'The page took too long to load' : `Couldn’t load the page: ${(err as Error).message}`);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        clearTimeout(timer);
        await res.body?.cancel().catch(() => {});
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
  } finally {
    void agent.close().catch(() => {});
  }
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

/** Test seams: the app never passes any of these. */
export interface ReadOptions {
  /** Skip every address check. */
  allowPrivate?: boolean;
  /** Replace DNS. */
  resolve?: Resolver;
  /** Replace the private-address rule (lets tests treat a loopback server as "public"). */
  isPrivate?: (ip: string) => boolean;
}

export async function readPage(target: string, opts: ReadOptions = {}): Promise<ReadablePage> {
  const { url, html } = await fetchPage(target, opts);
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
