/**
 * Importers: bring notes from other apps into a vault.
 *
 * - Notion: an unzipped "Markdown & CSV" export. Notion adds a 32-character ID to
 *   every file and folder name ("Page 1a2b….md"); those are removed, and links
 *   between pages are rewritten to match.
 * - Evernote: a .enex export. Each note becomes Markdown, with its images and
 *   attachments saved next to it and its tags and dates kept in the properties.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import TurndownService from 'turndown';
import type { Vault } from '@octavo/core';

export interface ImportResult {
  notes: number;
  attachments: number;
  folder: string;
  skipped: string[];
}

const NOTION_ID = /\s+[0-9a-f]{32}(?=\.[^./]+$|$)/i;
const cleanSegment = (s: string) => s.replace(NOTION_ID, '').trim() || 'Untitled';
const safeSegment = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim() || 'Untitled';

async function exists(p: string) {
  return !!(await fsp.stat(p).catch(() => null));
}

/** A vault-relative path that doesn't exist yet: "Folder/Name.md", "Folder/Name 2.md", … */
async function freePath(vault: Vault, rel: string): Promise<string> {
  const ext = path.posix.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  let candidate = rel;
  for (let i = 2; await exists(path.join(vault.root, candidate)); i++) candidate = `${stem} ${i}${ext}`;
  return candidate;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

const encodeHref = (rel: string) => rel.split('/').map(encodeURIComponent).join('/');

export async function importNotion(vault: Vault, sourceDir: string, into = 'Imported/Notion'): Promise<ImportResult> {
  const src = path.resolve(sourceDir);
  if (!(await fsp.stat(src).catch(() => null))?.isDirectory()) throw new Error(`${sourceDir} is not a folder. Unzip the Notion export first.`);
  const files = await walk(src);
  const base = into.replace(/^\/+|\/+$/g, '');
  // Old relative path (posix) → new vault-relative path.
  const map = new Map<string, string>();
  const result: ImportResult = { notes: 0, attachments: 0, folder: base, skipped: [] };
  for (const f of files) {
    const rel = path.relative(src, f).split(path.sep).join('/');
    const cleaned = rel.split('/').map((s) => safeSegment(cleanSegment(s))).join('/');
    const target = await freePath(vault, base ? `${base}/${cleaned}` : cleaned);
    map.set(rel, target);
  }
  for (const f of files) {
    const rel = path.relative(src, f).split(path.sep).join('/');
    const target = map.get(rel)!;
    await fsp.mkdir(path.dirname(path.join(vault.root, target)), { recursive: true });
    if (/\.md$/i.test(f)) {
      let text = await fsp.readFile(f, 'utf8');
      // Rewrite relative links: [Text](Other%20Page%20<id>.md) and ![](Page%20<id>/image.png)
      text = text.replace(/(!?\[[^\]\n]*\]\()([^)\s]+)(\))/g, (m, open: string, href: string, close: string) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return m;
        const [p, hash = ''] = decodeHref(href).split('#');
        const from = path.posix.normalize(path.posix.join(path.posix.dirname(rel), p));
        const to = map.get(from);
        if (!to) return m;
        const relTo = path.posix.relative(path.posix.dirname(target), to);
        return `${open}${encodeHref(relTo)}${hash ? '#' + hash : ''}${close}`;
      });
      await fsp.writeFile(path.join(vault.root, target), text, 'utf8');
      result.notes++;
    } else {
      await fsp.copyFile(f, path.join(vault.root, target));
      result.attachments++;
    }
  }
  await vault.rescan();
  return result;
}

// ---------------------------------------------------------------- Evernote

function xmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

const tagOf = (xml: string, name: string) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? xmlText(m[1]).trim() : undefined;
};

/** Evernote dates look like 20261106T153000Z. */
function enexDate(s?: string): string | undefined {
  const m = s && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : undefined;
}

function turndown(): TurndownService {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  td.remove(['script', 'style']);
  return td;
}

export async function importEnex(vault: Vault, file: string, into = 'Imported/Evernote'): Promise<ImportResult> {
  const xml = await fsp.readFile(file, 'utf8');
  const base = into.replace(/^\/+|\/+$/g, '');
  const attachDir = base ? `${base}/attachments` : 'attachments';
  const result: ImportResult = { notes: 0, attachments: 0, folder: base, skipped: [] };
  const td = turndown();
  const notes = xml.match(/<note>[\s\S]*?<\/note>/g) ?? [];
  for (const noteXml of notes) {
    const title = safeSegment(tagOf(noteXml, 'title') || 'Untitled');
    try {
      // Resources (images, PDFs…) are referenced from the content by the MD5 of their data.
      const media = new Map<string, string>();
      for (const res of noteXml.match(/<resource>[\s\S]*?<\/resource>/g) ?? []) {
        const data = /<data[^>]*>([\s\S]*?)<\/data>/.exec(res)?.[1]?.replace(/\s+/g, '');
        if (!data) continue;
        const buf = Buffer.from(data, 'base64');
        const hash = crypto.createHash('md5').update(buf).digest('hex');
        const mime = tagOf(res, 'mime') ?? 'application/octet-stream';
        const ext = mime.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'bin';
        const name = tagOf(res, 'file-name') || `${title} ${media.size + 1}.${ext}`;
        const saved = await vault.saveAttachment(name, buf, attachDir);
        media.set(hash, saved);
        result.attachments++;
      }
      const enml = tagOf(noteXml, 'content') ?? '';
      const html = enml
        .replace(/<\?xml[\s\S]*?\?>/, '')
        .replace(/<!DOCTYPE[\s\S]*?>/, '')
        // Empty Evernote elements become text markers (HTML converters drop empty elements).
        .replace(/<en-todo([^>]*?)\/?>(?:<\/en-todo>)?/g, (_m, attrs: string) => (/checked\s*=\s*"true"/.test(attrs) ? '\u0001x\u0001' : '\u0001 \u0001'))
        .replace(/<en-media([^>]*?)\/?>(?:<\/en-media>)?/g, (_m, attrs: string) => `\u0002${/hash\s*=\s*"([0-9a-f]+)"/.exec(attrs)?.[1] ?? ''}\u0002`);
      let md = td.turndown(html.replace(/<\/?en-note[^>]*>/g, (t) => (t.startsWith('</') ? '</div>' : '<div>')));
      md = md.replace(/\u0002([0-9a-f]*)\u0002/g, (_m, hash: string) => {
        const p = media.get(hash);
        return p ? `![[${path.posix.basename(p)}]]` : '';
      });
      // Checkboxes: "\u0001x\u0001 text" at the start of a line (or list item) becomes a task.
      md = md.replace(/^(\s*)(?:[-*]\s+)?\u0001(x| )\u0001\s*/gm, '$1- [$2] ').replace(/\u0001(x| )\u0001\s*/g, '[$1] ');
      const tags = [...noteXml.matchAll(/<tag>([\s\S]*?)<\/tag>/g)].map((m) => xmlText(m[1]).trim().replace(/\s+/g, '-')).filter(Boolean);
      const created = enexDate(tagOf(noteXml, 'created'));
      const updated = enexDate(tagOf(noteXml, 'updated'));
      const source = tagOf(noteXml, 'source-url');
      const fm: string[] = [];
      if (tags.length) fm.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`);
      if (created) fm.push(`created: ${created}`);
      if (updated) fm.push(`updated: ${updated}`);
      if (source) fm.push(`source: ${JSON.stringify(source)}`);
      const content = `${fm.length ? `---\n${fm.join('\n')}\n---\n` : ''}# ${title}\n\n${md.trim()}\n`;
      const target = await freePath(vault, `${base ? base + '/' : ''}${title}.md`);
      await fsp.mkdir(path.dirname(path.join(vault.root, target)), { recursive: true });
      await fsp.writeFile(path.join(vault.root, target), content, 'utf8');
      result.notes++;
    } catch (err) {
      result.skipped.push(`${title}: ${(err as Error).message}`);
    }
  }
  await vault.rescan();
  return result;
}
