import YAML from 'yaml';

export interface ParsedLink {
  /** Link target as written, without heading/alias (e.g. "Projects/Octavo"). */
  target: string;
  /** Heading or block reference after `#`, if any. */
  heading?: string;
  /** Display alias after `|`, if any. */
  alias?: string;
  /** `![[...]]` embeds. */
  embed: boolean;
  /** `wiki` for [[...]], `markdown` for [text](note.md). */
  kind: 'wiki' | 'markdown';
  /** 1-based line number the link appears on (in the full file). */
  line: number;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
  tags: string[];
  aliases: string[];
  links: ParsedLink[];
  headings: Heading[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  /** Number of lines taken by the frontmatter block (0 if none). */
  lineOffset: number;
} {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return { frontmatter: {}, body: content, lineOffset: 0 };
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(m[1], { logLevel: 'error' });
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid YAML: treat as no frontmatter data but still strip the block.
  }
  const lineOffset = m[0].split('\n').length - (m[0].endsWith('\n') ? 1 : 0);
  return { frontmatter, body: content.slice(m[0].length), lineOffset };
}

/** Replace code blocks and inline code with spaces so offsets/lines stay intact. */
export function maskCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, blank)
    .replace(/`[^`\n]+`/g, blank);
}

function toStringList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(toStringList);
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof value === 'number') return [String(value)];
  return [];
}

export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, '').trim().toLowerCase();
}

const TAG_RE = /(^|[\s(\[,;])#([\p{L}\p{N}_\-/]+)/gu;
const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const MDLINK_RE = /(!?)\[([^\]\n]*)\]\(<?([^)\s>]+?\.md)(#[^)\s>]*)?>?\)/g;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;

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

function lineAt(text: string, index: number, offset: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line + offset;
}

/**
 * Locked notes keep `octavo-encrypted: v1` in their frontmatter and the
 * ciphertext in an `octavo-encrypted` code block. Encryption and decryption
 * happen in the user's browser; the server only ever stores the envelope.
 */
export const ENCRYPTED_KEY = 'octavo-encrypted';
/** Marker used before the app was renamed to Octavo; still recognised. */
const LEGACY_ENCRYPTED_KEY = 'ultron-encrypted';

export function isEncryptedContent(content: string): boolean {
  if (!content.startsWith('---')) return false;
  const { frontmatter } = splitFrontmatter(content);
  return frontmatter[ENCRYPTED_KEY] != null || frontmatter[LEGACY_ENCRYPTED_KEY] != null;
}

/** A reference to a non-Markdown file (image, PDF, audio…) rather than a note. */
export function isAttachmentRef(target: string): boolean {
  return /\.[a-z0-9]{2,5}$/i.test(target) && !/\.md$/i.test(target);
}

export function parseNote(content: string): ParsedNote {
  const { frontmatter, body, lineOffset } = splitFrontmatter(content);
  const masked = maskCode(body);

  const tagSet = new Set<string>();
  for (const t of toStringList(frontmatter.tags ?? frontmatter.tag)) {
    const n = normalizeTag(t);
    if (n) tagSet.add(n);
  }
  for (const m of masked.matchAll(TAG_RE)) {
    const tag = m[2].replace(/\/+$/, '');
    // Pure numbers (e.g. "#1") are not tags, matching Obsidian.
    if (!/^[\d/]+$/.test(tag)) tagSet.add(normalizeTag(tag));
  }

  // Aliases may contain spaces, so (unlike tags) strings are not split.
  const rawAliases = frontmatter.aliases ?? frontmatter.alias;
  const aliases = (Array.isArray(rawAliases) ? rawAliases : rawAliases == null ? [] : [rawAliases])
    .filter((a): a is string | number => typeof a === 'string' || typeof a === 'number')
    .map((a) => String(a).trim())
    .filter(Boolean);

  const links: ParsedLink[] = [];
  for (const m of masked.matchAll(WIKILINK_RE)) {
    const { target, heading, alias } = parseWikiInner(m[2]);
    if (!target && !heading) continue;
    // ![[photo.png]], [[report.pdf]]: attachments, not links to notes.
    if (isAttachmentRef(target)) continue;
    links.push({
      target,
      heading,
      alias,
      embed: m[1] === '!',
      kind: 'wiki',
      line: lineAt(masked, m.index!, lineOffset),
    });
  }
  for (const m of masked.matchAll(MDLINK_RE)) {
    const href = m[3];
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // external URL
    let target = href;
    try {
      target = decodeURI(href);
    } catch {
      /* keep raw */
    }
    links.push({
      target: target.replace(/\.md$/i, ''),
      heading: m[4] ? m[4].slice(1) : undefined,
      alias: m[2] || undefined,
      embed: m[1] === '!',
      kind: 'markdown',
      line: lineAt(masked, m.index!, lineOffset),
    });
  }

  const headings: Heading[] = [];
  for (const m of masked.matchAll(HEADING_RE)) {
    headings.push({ level: m[1].length, text: m[2], line: lineAt(masked, m.index!, lineOffset) });
  }

  return { frontmatter, body, tags: [...tagSet].sort(), aliases, links, headings };
}
