import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isEncryptedContent, maskCode, parseNote, parseWikiInner, splitFrontmatter, type ParsedLink } from './parse.js';
import { normalizeFolderPath, normalizeNotePath, noteFolder, noteName, stripMd, VaultPathError } from './paths.js';
import { searchNotes } from './search.js';
import type {
  Backlink,
  GraphData,
  GraphNode,
  IndexedNote,
  LinkRef,
  NoteDetail,
  NoteSummary,
  SearchResult,
  TagCount,
  VaultEvent,
} from './types.js';

export class NoteNotFoundError extends Error {
  constructor(public readonly notePath: string) {
    super(`Note not found: ${notePath}`);
    this.name = 'NoteNotFoundError';
  }
}

export class NoteConflictError extends Error {
  constructor(
    public readonly notePath: string,
    public readonly currentMtime: number,
  ) {
    super(`Note was modified since it was loaded: ${notePath}`);
    this.name = 'NoteConflictError';
  }
}

export class NoteExistsError extends Error {
  constructor(public readonly notePath: string) {
    super(`A note already exists at: ${notePath}`);
    this.name = 'NoteExistsError';
  }
}

export class EncryptedNoteError extends Error {
  constructor(public readonly notePath: string) {
    super(`${notePath} is a locked (encrypted) note. It can only be read or changed after unlocking it in the Octavo app.`);
    this.name = 'EncryptedNoteError';
  }
}

export class EditMatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditMatchError';
  }
}

export interface VaultOptions {
  /** Watch the folder for external changes (other editors, other processes). Default true. */
  watch?: boolean;
  /** Folder for daily journal notes. Default "Journal". */
  dailyFolder?: string;
}

export interface RelatedNote {
  path: string;
  name: string;
  score: number;
  reasons: string[];
}

export interface VaultOverview {
  name: string;
  noteCount: number;
  folders: { folder: string; count: number }[];
  topTags: TagCount[];
  recent: NoteSummary[];
  /** Content of the vault's home note (Home.md / Index.md / README.md), if any. */
  home: { path: string; content: string } | null;
}

const HOME_CANDIDATES = ['home.md', 'index.md', 'readme.md', 'start here.md'];

function summarize(n: IndexedNote): NoteSummary {
  return {
    path: n.path,
    name: n.name,
    folder: n.folder,
    tags: n.tags,
    mtime: n.mtime,
    ctime: n.ctime,
    size: n.size,
    ...(n.encrypted ? { encrypted: true } : {}),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type Period = 'day' | 'week' | 'month';

export interface TaskItem {
  path: string;
  name: string;
  line: number;
  status: string;
  text: string;
  /** YYYY-MM-DD, from "📅 2026-11-10" (Obsidian Tasks style) or "due: 2026-11-10" / "[due:: 2026-11-10]" in the task text. */
  due?: string;
}

const DUE_RE = /(?:📅|🗓️?|\bdue::?)\s*(\d{4}-\d{2}-\d{2})\b/iu;

/** The due date written in a task's text, if any. */
export function taskDueDate(text: string): string | undefined {
  return DUE_RE.exec(text)?.[1];
}

/** ISO 8601 week: weeks start on Monday; week 1 contains the year's first Thursday. */
export function isoWeek(d: Date): { year: number; week: number; monday: Date; sunday: Date } {
  const day = (d.getDay() + 6) % 7; // Monday = 0
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
  const year = thursday.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const week1Monday = new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7));
  const week = Math.round((monday.getTime() - week1Monday.getTime()) / (7 * 86400000)) + 1;
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { year, week, monday, sunday };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function encodeMdHref(rel: string): string {
  return rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

export class Vault extends EventEmitter {
  readonly root: string;
  readonly dailyFolder: string;
  private notes = new Map<string, IndexedNote>();
  /** Non-Markdown files (attachments): lower-cased basename -> vault paths. */
  private attachments = new Map<string, Set<string>>();
  private lastSnapshot = new Map<string, number>();
  private byName = new Map<string, Set<string>>();
  private byAlias = new Map<string, Set<string>>();
  private watcher: fs.FSWatcher | null = null;
  private pending = new Map<string, NodeJS.Timeout>();
  private rescanTimer: NodeJS.Timeout | null = null;

  private constructor(root: string, opts: VaultOptions) {
    super();
    this.root = path.resolve(root);
    this.dailyFolder = normalizeFolderPath(opts.dailyFolder ?? 'Journal');
  }

  static async open(root: string, opts: VaultOptions = {}): Promise<Vault> {
    const vault = new Vault(root, opts);
    await fsp.mkdir(vault.root, { recursive: true });
    // Settings, bookmarks and history used to live in `.ultron/` (before the rename to Octavo).
    const legacy = path.join(vault.root, '.ultron');
    const current = path.join(vault.root, '.octavo');
    if ((await fsp.stat(legacy).catch(() => null)) && !(await fsp.stat(current).catch(() => null))) {
      await fsp.rename(legacy, current).catch(() => {});
    }
    await vault.rescan(false);
    if (opts.watch !== false) vault.startWatching();
    return vault;
  }

  get name(): string {
    return path.basename(this.root);
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
  }

  // ---------------------------------------------------------------- indexing

  private abs(rel: string): string {
    const full = path.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new VaultPathError(`Path escapes the vault: ${rel}`);
    }
    return full;
  }

  private addToMap(map: Map<string, Set<string>>, key: string, value: string) {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(value);
  }

  private removeFromMap(map: Map<string, Set<string>>, key: string, value: string) {
    const set = map.get(key);
    if (!set) return;
    set.delete(value);
    if (set.size === 0) map.delete(key);
  }

  private setIndexed(note: IndexedNote) {
    this.unindex(note.path);
    this.notes.set(note.path, note);
    this.addToMap(this.byName, note.name.toLowerCase(), note.path);
    for (const a of note.aliases) this.addToMap(this.byAlias, a.toLowerCase(), note.path);
  }

  private unindex(rel: string): boolean {
    const old = this.notes.get(rel);
    if (!old) return false;
    this.notes.delete(rel);
    this.removeFromMap(this.byName, old.name.toLowerCase(), rel);
    for (const a of old.aliases) this.removeFromMap(this.byAlias, a.toLowerCase(), rel);
    return true;
  }

  private buildIndexed(rel: string, content: string, stat: fs.Stats): IndexedNote {
    const encrypted = isEncryptedContent(content);
    // A locked note's placeholder text isn't real content: index nothing from it.
    const parsed = encrypted
      ? { frontmatter: splitFrontmatter(content).frontmatter, tags: [], aliases: [], links: [], headings: [] }
      : parseNote(content);
    return {
      encrypted,
      path: rel,
      name: noteName(rel),
      folder: noteFolder(rel),
      content,
      frontmatter: parsed.frontmatter,
      tags: parsed.tags,
      aliases: parsed.aliases,
      links: parsed.links,
      headings: parsed.headings,
      mtime: stat.mtimeMs,
      ctime: stat.birthtimeMs || stat.ctimeMs,
      size: stat.size,
    };
  }

  /** Re-read a single file from disk. Returns true if the index changed. */
  private async refreshFile(rel: string, emit: boolean): Promise<boolean> {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(this.abs(rel));
    } catch {
      if (this.unindex(rel)) {
        if (emit) this.emitEvent({ type: 'delete', path: rel });
        return true;
      }
      return false;
    }
    if (!stat.isFile()) return false;
    const existing = this.notes.get(rel);
    if (existing && existing.mtime === stat.mtimeMs && existing.size === stat.size) return false;
    const content = await fsp.readFile(this.abs(rel), 'utf8');
    this.setIndexed(this.buildIndexed(rel, content, stat));
    if (emit) this.emitEvent({ type: 'change', path: rel });
    return true;
  }

  private async walk(dirRel: string, out: string[], other?: string[]): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(this.abs(dirRel || '.'), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDirectory()) await this.walk(rel, out, other);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(rel);
      else if (e.isFile()) other?.push(rel);
    }
  }

  /** Full rescan of the vault folder, reconciling the index with disk. */
  async rescan(emit = true): Promise<void> {
    const files: string[] = [];
    const other: string[] = [];
    await this.walk('', files, other);
    this.attachments = new Map();
    for (const rel of other) this.addToMap(this.attachments, path.posix.basename(rel).toLowerCase(), rel);
    const seen = new Set(files);
    let changed = false;
    for (const rel of files) {
      if (await this.refreshFile(rel, emit)) changed = true;
    }
    for (const rel of [...this.notes.keys()]) {
      if (!seen.has(rel)) {
        this.unindex(rel);
        changed = true;
        if (emit) this.emitEvent({ type: 'delete', path: rel });
      }
    }
    if (changed && emit) this.emitEvent({ type: 'rescan' });
  }

  private startWatching() {
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_type, filename) => {
        if (!filename) return this.scheduleRescan();
        const rel = filename.toString().split(path.sep).join('/');
        if (rel.split('/').some((s) => s.startsWith('.') || s === 'node_modules')) return;
        if (rel.toLowerCase().endsWith('.md')) this.scheduleFile(rel);
        else this.scheduleRescan();
      });
      this.watcher.on('error', (err) => {
        console.error('[octavo] file watcher error:', err);
      });
    } catch (err) {
      console.error('[octavo] could not watch vault folder; external edits will not be detected live:', err);
    }
  }

  private scheduleFile(rel: string) {
    const existing = this.pending.get(rel);
    if (existing) clearTimeout(existing);
    this.pending.set(
      rel,
      setTimeout(() => {
        this.pending.delete(rel);
        this.refreshFile(rel, true).catch((err) => console.error('[octavo] refresh failed:', err));
      }, 75),
    );
  }

  private scheduleRescan() {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      this.rescan(true).catch((err) => console.error('[octavo] rescan failed:', err));
    }, 250);
  }

  private emitEvent(e: VaultEvent) {
    this.emit('event', e);
  }

  // ---------------------------------------------------------------- links

  /** Resolve a link target (as written in `fromPath`) to a vault path. */
  resolveLink(link: Pick<ParsedLink, 'target'> & { kind?: ParsedLink['kind'] }, fromPath?: string): string | null {
    const raw = link.target.trim();
    if (!raw) return fromPath && this.notes.has(fromPath) ? fromPath : null;
    const fromFolder = fromPath ? noteFolder(fromPath) : '';

    // Markdown links are relative to the source note's folder.
    if (link.kind === 'markdown') {
      const joined = path.posix.normalize(path.posix.join(fromFolder, raw));
      if (!joined.startsWith('..')) {
        const candidate = joined.toLowerCase().endsWith('.md') ? joined : `${joined}.md`;
        if (this.notes.has(candidate)) return candidate;
      }
    }

    const t = stripMd(raw.replace(/\\/g, '/').replace(/^\.?\/+/, '')).toLowerCase();
    let candidates: string[] = [];
    if (t.includes('/')) {
      for (const p of this.notes.keys()) {
        const lp = stripMd(p).toLowerCase();
        if (lp === t || lp.endsWith('/' + t)) candidates.push(p);
      }
    } else {
      candidates = [...(this.byName.get(t) ?? [])];
      if (candidates.length === 0) candidates = [...(this.byAlias.get(t) ?? [])];
    }
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    candidates.sort((a, b) => {
      const sa = noteFolder(a) === fromFolder ? 0 : 1;
      const sb = noteFolder(b) === fromFolder ? 0 : 1;
      return sa - sb || a.length - b.length || a.localeCompare(b);
    });
    return candidates[0];
  }

  /** Resolve a bare name/path typed by a user or agent ("Octavo", "Projects/Octavo.md"). */
  resolve(nameOrPath: string): string | null {
    try {
      const normalized = normalizeNotePath(nameOrPath);
      if (this.notes.has(normalized)) return normalized;
      // Case-insensitive path match.
      const lower = normalized.toLowerCase();
      for (const p of this.notes.keys()) if (p.toLowerCase() === lower) return p;
    } catch {
      /* fall through to link resolution */
    }
    return this.resolveLink({ target: nameOrPath });
  }

  private requireNote(nameOrPath: string): IndexedNote {
    const resolved = this.resolve(nameOrPath);
    const note = resolved ? this.notes.get(resolved) : undefined;
    if (!note) throw new NoteNotFoundError(nameOrPath);
    return note;
  }

  outgoing(nameOrPath: string): LinkRef[] {
    const note = this.requireNote(nameOrPath);
    return note.links.map((l) => ({
      target: l.target,
      path: this.resolveLink(l, note.path),
      heading: l.heading,
      alias: l.alias,
      embed: l.embed,
      line: l.line,
    }));
  }

  backlinks(nameOrPath: string): Backlink[] {
    const target = this.requireNote(nameOrPath).path;
    const out: Backlink[] = [];
    for (const n of this.notes.values()) {
      if (n.path === target) continue;
      const lines = new Set<number>();
      for (const l of n.links) {
        if (this.resolveLink(l, n.path) === target) lines.add(l.line);
      }
      if (lines.size === 0) continue;
      const contentLines = n.content.split('\n');
      out.push({
        path: n.path,
        name: n.name,
        context: [...lines]
          .sort((a, b) => a - b)
          .map((line) => ({ line, text: (contentLines[line - 1] ?? '').trim() })),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Links that point at notes which don't exist yet. */
  unresolvedLinks(): { target: string; from: string[] }[] {
    const map = new Map<string, { target: string; from: Set<string> }>();
    for (const n of this.notes.values()) {
      for (const l of n.links) {
        if (!l.target || this.resolveLink(l, n.path)) continue;
        const key = l.target.toLowerCase();
        let entry = map.get(key);
        if (!entry) map.set(key, (entry = { target: l.target, from: new Set() }));
        entry.from.add(n.path);
      }
    }
    return [...map.values()].map((e) => ({ target: e.target, from: [...e.from] }));
  }

  // ---------------------------------------------------------------- queries

  has(nameOrPath: string): boolean {
    return this.resolve(nameOrPath) !== null;
  }

  list(opts: { folder?: string; tag?: string } = {}): NoteSummary[] {
    const folder = normalizeFolderPath(opts.folder);
    const tag = opts.tag?.replace(/^#/, '').toLowerCase();
    const out: NoteSummary[] = [];
    for (const n of this.notes.values()) {
      if (folder && n.folder !== folder && !n.folder.startsWith(folder + '/')) continue;
      if (tag && !n.tags.some((t) => t === tag || t.startsWith(tag + '/'))) continue;
      out.push(summarize(n));
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  recent(limit = 10): NoteSummary[] {
    return [...this.notes.values()]
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map(summarize);
  }

  folders(): string[] {
    const set = new Set<string>();
    for (const n of this.notes.values()) {
      let f = n.folder;
      while (f) {
        set.add(f);
        f = noteFolder(f);
      }
    }
    return [...set].sort();
  }

  tags(): TagCount[] {
    const counts = new Map<string, number>();
    for (const n of this.notes.values()) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  search(query: string, limit = 20): SearchResult[] {
    return searchNotes([...this.notes.values()].filter((n) => !n.encrypted), query, limit);
  }

  async read(nameOrPath: string): Promise<NoteDetail> {
    const resolved = this.resolve(nameOrPath);
    if (resolved) await this.refreshFile(resolved, true);
    const note = this.requireNote(nameOrPath);
    return {
      ...summarize(note),
      content: note.content,
      frontmatter: note.frontmatter,
      aliases: note.aliases,
      headings: note.headings,
      links: this.outgoing(note.path),
      backlinks: this.backlinks(note.path),
    };
  }

  graph(): GraphData {
    const nodes = new Map<string, GraphNode>();
    const links = new Map<string, { source: string; target: string }>();
    for (const n of this.notes.values()) {
      const region = typeof n.frontmatter.region === 'string' ? n.frontmatter.region : undefined;
      nodes.set(n.path, {
        id: n.path,
        name: n.name,
        tags: n.tags,
        degree: 0,
        ...(region ? { region } : {}),
        ...(n.encrypted ? { encrypted: true } : {}),
      });
    }
    for (const n of this.notes.values()) {
      for (const l of n.links) {
        if (!l.target) continue;
        let target = this.resolveLink(l, n.path);
        if (!target) {
          target = `unresolved:${l.target.toLowerCase()}`;
          if (!nodes.has(target)) {
            nodes.set(target, { id: target, name: l.target, tags: [], unresolved: true, degree: 0 });
          }
        }
        if (target === n.path) continue;
        const key = `${n.path}\u0000${target}`;
        if (links.has(key)) continue;
        links.set(key, { source: n.path, target });
        nodes.get(n.path)!.degree++;
        nodes.get(target)!.degree++;
      }
    }
    return { nodes: [...nodes.values()], links: [...links.values()] };
  }

  related(nameOrPath: string, limit = 10): RelatedNote[] {
    const note = this.requireNote(nameOrPath);
    const scores = new Map<string, { score: number; reasons: Set<string> }>();
    const bump = (p: string, s: number, reason: string) => {
      if (p === note.path) return;
      let e = scores.get(p);
      if (!e) scores.set(p, (e = { score: 0, reasons: new Set() }));
      e.score += s;
      e.reasons.add(reason);
    };
    const direct = new Set<string>();
    for (const l of note.links) {
      const p = this.resolveLink(l, note.path);
      if (p) {
        bump(p, 3, 'linked from this note');
        direct.add(p);
      }
    }
    for (const b of this.backlinks(note.path)) {
      bump(b.path, 3, 'links to this note');
      direct.add(b.path);
    }
    for (const n of this.notes.values()) {
      const shared = n.tags.filter((t) => note.tags.includes(t));
      if (shared.length) bump(n.path, shared.length, `shared tags: ${shared.map((t) => '#' + t).join(' ')}`);
    }
    for (const d of direct) {
      const dn = this.notes.get(d);
      if (!dn) continue;
      for (const l of dn.links) {
        const p = this.resolveLink(l, dn.path);
        if (p && !direct.has(p)) bump(p, 1, `2 hops via ${dn.name}`);
      }
    }
    return [...scores.entries()]
      .map(([p, e]) => ({ path: p, name: noteName(p), score: e.score, reasons: [...e.reasons] }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  overview(): VaultOverview {
    const folderCounts = new Map<string, number>();
    let home: IndexedNote | undefined;
    for (const n of this.notes.values()) {
      folderCounts.set(n.folder || '/', (folderCounts.get(n.folder || '/') ?? 0) + 1);
      if (!n.folder && HOME_CANDIDATES.includes(path.posix.basename(n.path).toLowerCase())) {
        if (!home || HOME_CANDIDATES.indexOf(n.path.toLowerCase()) < HOME_CANDIDATES.indexOf(home.path.toLowerCase())) {
          home = n;
        }
      }
    }
    return {
      name: this.name,
      noteCount: this.notes.size,
      folders: [...folderCounts.entries()]
        .map(([folder, count]) => ({ folder, count }))
        .sort((a, b) => a.folder.localeCompare(b.folder)),
      topTags: this.tags().slice(0, 25),
      recent: this.recent(10),
      home: home ? { path: home.path, content: home.content } : null,
    };
  }

  // ---------------------------------------------------------------- writes

  private async atomicWrite(rel: string, content: string): Promise<fs.Stats> {
    const full = this.abs(rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.${Date.now()}.tmp`);
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, full);
    return fsp.stat(full);
  }

  /**
   * Create or overwrite a note. Pass `expectedMtime` (from a previous read) to
   * fail with NoteConflictError if the file changed on disk in the meantime.
   */
  async write(
    nameOrPath: string,
    content: string,
    opts: { expectedMtime?: number; createOnly?: boolean } = {},
  ): Promise<NoteSummary> {
    const rel = this.resolve(nameOrPath) ?? normalizeNotePath(nameOrPath);
    const full = this.abs(rel);
    const stat = await fsp.stat(full).catch(() => null);
    if (stat && opts.createOnly) throw new NoteExistsError(rel);
    if (stat && opts.expectedMtime != null && Math.abs(stat.mtimeMs - opts.expectedMtime) > 1) {
      throw new NoteConflictError(rel, stat.mtimeMs);
    }
    const wasEncrypted = stat ? (this.notes.get(rel)?.encrypted ?? false) : false;
    if (stat && isEncryptedContent(content) && !wasEncrypted) {
      // Locking a note: earlier plain-text versions must not linger in the history folder.
      await this.purgeHistory(rel);
    } else if (stat) {
      await this.snapshot(rel, content);
    }
    const newStat = await this.atomicWrite(rel, content);
    const note = this.buildIndexed(rel, content, newStat);
    this.setIndexed(note);
    this.emitEvent({ type: 'change', path: rel });
    return summarize(note);
  }

  async create(nameOrPath: string, content = ''): Promise<NoteSummary> {
    const rel = normalizeNotePath(nameOrPath);
    if (this.resolve(rel) === rel || (await fsp.stat(this.abs(rel)).catch(() => null))) {
      throw new NoteExistsError(rel);
    }
    return this.write(rel, content, { createOnly: true });
  }

  /**
   * Append text to a note (creating it if needed). With `heading`, the text is
   * added at the end of that section; the heading is created if missing.
   */
  async append(
    nameOrPath: string,
    text: string,
    opts: { heading?: string; separator?: 'paragraph' | 'line' } = {},
  ): Promise<NoteSummary> {
    const rel = this.resolve(nameOrPath) ?? normalizeNotePath(nameOrPath);
    const existing = this.notes.get(rel);
    if (existing) await this.refreshFile(rel, true);
    if (this.notes.get(rel)?.encrypted) throw new EncryptedNoteError(rel);
    const current = this.notes.get(rel)?.content ?? '';
    const block = text.replace(/\s+$/, '');

    const isListItem = (l: string | undefined) => !!l && /^\s*([-*+]|\d+[.)])\s/.test(l);
    const lastLine = current.replace(/\n+$/, '').split('\n').pop();
    // Appending a list item right after another list item keeps the list tight.
    const lineMode = opts.separator === 'line' || (opts.separator == null && isListItem(block) && isListItem(lastLine));
    const sepFor = (c: string) =>
      c === '' || c.endsWith('\n\n') ? '' : c.endsWith('\n') ? (lineMode ? '' : '\n') : lineMode ? '\n' : '\n\n';

    if (!opts.heading) {
      const sep = sepFor(current);
      return this.write(rel, `${current}${sep}${block}\n`);
    }

    const lines = current.split('\n');
    const note = this.notes.get(rel);
    const wanted = opts.heading.replace(/^#+\s*/, '').trim().toLowerCase();
    const heading = note?.headings.find((h) => h.text.trim().toLowerCase() === wanted);
    if (!heading) {
      const sep = current === '' || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
      return this.write(rel, `${current}${sep}## ${opts.heading.replace(/^#+\s*/, '').trim()}\n\n${block}\n`);
    }
    const next = note!.headings.find((h) => h.line > heading.line && h.level <= heading.level);
    let insertAt = next ? next.line - 1 : lines.length; // 0-based index of the line to insert before
    // Skip back over trailing blank lines in the section.
    while (insertAt > heading.line && lines[insertAt - 1].trim() === '') insertAt--;
    const prev = lines[insertAt - 1];
    const tight = opts.separator === 'line' || (opts.separator == null && isListItem(block) && isListItem(prev));
    const insertion = tight || prev?.trim() === '' ? [block] : ['', block];
    if (next && lines[insertAt]?.trim() !== '') insertion.push('');
    lines.splice(insertAt, 0, ...insertion);
    let result = lines.join('\n');
    if (!result.endsWith('\n')) result += '\n';
    return this.write(rel, result);
  }

  /** Replace an exact snippet of text in a note. */
  async edit(
    nameOrPath: string,
    oldText: string,
    newText: string,
    opts: { replaceAll?: boolean } = {},
  ): Promise<NoteSummary & { replacements: number }> {
    const note = this.requireNote(nameOrPath);
    await this.refreshFile(note.path, true);
    if (this.notes.get(note.path)!.encrypted) throw new EncryptedNoteError(note.path);
    const content = this.notes.get(note.path)!.content;
    if (!oldText) throw new EditMatchError('old_text must not be empty');
    const count = content.split(oldText).length - 1;
    if (count === 0) throw new EditMatchError(`Text not found in ${note.path}`);
    if (count > 1 && !opts.replaceAll) {
      throw new EditMatchError(
        `Text appears ${count} times in ${note.path}; include more surrounding context or set replace_all`,
      );
    }
    const updated = opts.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText);
    const summary = await this.write(note.path, updated);
    return { ...summary, replacements: opts.replaceAll ? count : 1 };
  }

  /** Move a note to the vault's `.trash` folder (recoverable). */
  async delete(nameOrPath: string): Promise<{ path: string; trashedTo: string }> {
    const note = this.requireNote(nameOrPath);
    let trashRel = `.trash/${note.path}`;
    if (await fsp.stat(path.join(this.root, trashRel)).catch(() => null)) {
      trashRel = `.trash/${stripMd(note.path)} ${Date.now()}.md`;
    }
    const trashAbs = path.join(this.root, trashRel);
    await fsp.mkdir(path.dirname(trashAbs), { recursive: true });
    await fsp.rename(this.abs(note.path), trashAbs);
    this.unindex(note.path);
    this.emitEvent({ type: 'delete', path: note.path });
    return { path: note.path, trashedTo: trashRel };
  }

  /** New content for every note with links to `src`, pointing them at `to` instead. */
  private linkRewrites(src: IndexedNote, to: string, opts: { keepAliasLinks: boolean }): Map<string, { content: string; count: number }> {
    const from = src.path;
    const newName = noteName(to);
    const others = [...(this.byName.get(newName.toLowerCase()) ?? [])].filter((p) => p !== from && p !== to);
    const wikiTarget = others.length === 0 ? newName : stripMd(to);
    const srcAliases = new Set(src.aliases.map((a) => a.toLowerCase()));

    // Computed against the current index, before anything moves.
    const rewrites = new Map<string, { content: string; count: number }>();
    {
      for (const n of this.notes.values()) {
        const { body } = splitFrontmatter(n.content);
        const fmLen = n.content.length - body.length;
        const masked = n.content.slice(0, fmLen).replace(/[^\n]/g, ' ') + maskCode(body);
        const sourcePathAfter = n.path === from ? to : n.path;
        const edits: { start: number; end: number; text: string }[] = [];

        for (const m of masked.matchAll(/(!?)\[\[([^\[\]\n]+?)\]\]/g)) {
          const inner = parseWikiInner(n.content.slice(m.index! + m[1].length + 2, m.index! + m[0].length - 2));
          if (!inner.target) continue;
          if (this.resolveLink({ target: inner.target }, n.path) !== from) continue;
          const lt = stripMd(inner.target).toLowerCase();
          if (opts.keepAliasLinks && srcAliases.has(lt) && lt !== src.name.toLowerCase()) continue; // alias links still work
          const text = `${m[1]}[[${wikiTarget}${inner.heading ? '#' + inner.heading : ''}${inner.alias ? '|' + inner.alias : ''}]]`;
          edits.push({ start: m.index!, end: m.index! + m[0].length, text });
        }
        for (const m of masked.matchAll(/(!?)\[([^\]\n]*)\]\(<?([^)\s>]+?\.md)(#[^)\s>]*)?>?\)/g)) {
          const href = n.content.slice(m.index!, m.index! + m[0].length).match(/\]\(<?([^)\s>]+?\.md)/)![1];
          if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
          let decoded = href;
          try {
            decoded = decodeURI(href);
          } catch {
            /* keep */
          }
          if (this.resolveLink({ target: decoded.replace(/\.md$/i, ''), kind: 'markdown' }, n.path) !== from) continue;
          const rel = path.posix.relative(noteFolder(sourcePathAfter), to);
          const original = n.content.slice(m.index!, m.index! + m[0].length);
          const label = original.slice(m[1].length + 1, original.indexOf(']('));
          const text = `${m[1]}[${label}](${encodeMdHref(rel)}${m[4] ?? ''})`;
          edits.push({ start: m.index!, end: m.index! + m[0].length, text });
        }

        if (edits.length) {
          edits.sort((a, b) => b.start - a.start);
          let content = n.content;
          for (const e of edits) content = content.slice(0, e.start) + e.text + content.slice(e.end);
          rewrites.set(n.path, { content, count: edits.length });
        }
      }
    }
    return rewrites;
  }

  /**
   * Rename/move a note. By default every wikilink and markdown link that
   * points at it is rewritten to the new location.
   */
  async rename(
    fromNameOrPath: string,
    toPath: string,
    opts: { updateLinks?: boolean } = {},
  ): Promise<{ from: string; to: string; updatedNotes: string[]; updatedLinks: number }> {
    const src = this.requireNote(fromNameOrPath);
    const from = src.path;
    const to = normalizeNotePath(toPath);
    if (to === from) return { from, to, updatedNotes: [], updatedLinks: 0 };
    const caseOnly = to.toLowerCase() === from.toLowerCase();
    if (!caseOnly && (this.notes.has(to) || (await fsp.stat(this.abs(to)).catch(() => null)))) {
      throw new NoteExistsError(to);
    }

    const rewrites = opts.updateLinks !== false ? this.linkRewrites(src, to, { keepAliasLinks: true }) : new Map<string, { content: string; count: number }>();

    // Move the file.
    await fsp.mkdir(path.dirname(this.abs(to)), { recursive: true });
    await fsp.rename(this.abs(from), this.abs(to));
    this.unindex(from);
    await this.refreshFile(to, false);
    this.emitEvent({ type: 'rename', from, to });

    // Apply rewrites.
    let updatedLinks = 0;
    const updatedNotes: string[] = [];
    for (const [p, r] of rewrites) {
      const target = p === from ? to : p;
      await this.write(target, r.content);
      updatedLinks += r.count;
      updatedNotes.push(target);
    }
    return { from, to, updatedNotes, updatedLinks };
  }


  /**
   * Merge one note into another: its text is appended to the target, links to it
   * are pointed at the target, and the source goes to the trash.
   */
  async merge(
    sourceNameOrPath: string,
    targetNameOrPath: string,
    opts: { heading?: boolean } = {},
  ): Promise<{ from: string; into: string; updatedNotes: string[]; updatedLinks: number; trashedTo: string }> {
    const src = this.requireNote(sourceNameOrPath);
    const dst = this.requireNote(targetNameOrPath);
    if (src.path === dst.path) throw new EditMatchError('A note can’t be merged into itself');
    await this.refreshFile(src.path, true);
    await this.refreshFile(dst.path, true);
    for (const n of [src.path, dst.path]) if (this.notes.get(n)!.encrypted) throw new EncryptedNoteError(n);

    const rewrites = this.linkRewrites(this.notes.get(src.path)!, dst.path, { keepAliasLinks: false });
    const srcContent = rewrites.get(src.path)?.content ?? this.notes.get(src.path)!.content;
    const dstContent = rewrites.get(dst.path)?.content ?? this.notes.get(dst.path)!.content;
    let body = splitFrontmatter(srcContent).body.trim();
    if (opts.heading !== false) {
      // Keep the source's title as a section heading: "# Title" becomes "## Title", or add one.
      const h1 = /^# +(.+)\n?/.exec(body);
      body = h1 ? `## ${h1[1]}\n${body.slice(h1[0].length)}` : `## ${src.name}\n\n${body}`;
    }
    const merged = body ? `${dstContent.replace(/\s*$/, '')}\n\n${body}\n` : dstContent;

    let updatedLinks = 0;
    const updatedNotes: string[] = [];
    await this.write(dst.path, merged);
    updatedNotes.push(dst.path);
    updatedLinks += rewrites.get(dst.path)?.count ?? 0;
    for (const [p, r] of rewrites) {
      if (p === src.path || p === dst.path) continue;
      await this.write(p, r.content);
      updatedLinks += r.count;
      updatedNotes.push(p);
    }
    const { trashedTo } = await this.delete(src.path);
    return { from: src.path, into: dst.path, updatedNotes, updatedLinks, trashedTo };
  }

  // ---------------------------------------------------------------- attachments

  /** Resolve an attachment reference (path or bare file name, like Obsidian) to a vault path. */
  resolveAttachment(ref: string, fromPath?: string): string | null {
    const clean = ref.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!clean) return null;
    if (fromPath) {
      const rel = path.posix.normalize(path.posix.join(noteFolder(fromPath), clean));
      if (!rel.startsWith('..') && [...this.attachments.values()].some((set) => set.has(rel))) return rel;
    }
    for (const set of this.attachments.values()) if (set.has(clean)) return clean;
    const byName = [...(this.attachments.get(path.posix.basename(clean).toLowerCase()) ?? [])];
    if (byName.length === 0) return null;
    return byName.sort((a, b) => a.length - b.length)[0];
  }

  /** Absolute path of an attachment or note, for streaming it to a client. */
  filePath(rel: string): string {
    const clean = rel.replace(/\\/g, '/');
    if (clean.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) throw new VaultPathError(`Invalid path: ${rel}`);
    return this.abs(clean);
  }

  /** Save an uploaded file into the attachments folder, picking a free name. */
  async saveAttachment(name: string, data: Buffer, folder = 'attachments'): Promise<string> {
    const base = path.posix.basename(name.replace(/\\/g, '/')).replace(/[^\p{L}\p{N}._ -]/gu, '_') || 'file';
    if (base.startsWith('.')) throw new VaultPathError('Invalid file name');
    const dir = normalizeFolderPath(folder);
    const ext = path.posix.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let rel = dir ? `${dir}/${base}` : base;
    for (let i = 1; await fsp.stat(this.abs(rel)).catch(() => null); i++) rel = `${dir ? dir + '/' : ''}${stem} ${i}${ext}`;
    await fsp.mkdir(path.dirname(this.abs(rel)), { recursive: true });
    await fsp.writeFile(this.abs(rel), data);
    this.addToMap(this.attachments, path.posix.basename(rel).toLowerCase(), rel);
    this.emitEvent({ type: 'rescan' });
    return rel;
  }

  // ---------------------------------------------------------------- history

  private historyDir(rel: string): string {
    return path.join(this.root, '.octavo', 'history', ...rel.split('/'));
  }

  /**
   * Keep a copy of a note's previous content before it is overwritten.
   * At most one snapshot per note every 5 minutes, and the newest 50 are kept.
   */
  private async purgeHistory(rel: string): Promise<void> {
    this.lastSnapshot.delete(rel);
    await fsp.rm(this.historyDir(rel), { recursive: true, force: true }).catch(() => {});
  }

  /** Is this a locked (encrypted) note? */
  isEncrypted(nameOrPath: string): boolean {
    const rel = this.resolve(nameOrPath);
    return !!(rel && this.notes.get(rel)?.encrypted);
  }

  private async snapshot(rel: string, nextContent: string): Promise<void> {
    const prev = this.notes.get(rel)?.content ?? (await fsp.readFile(this.abs(rel), 'utf8').catch(() => null));
    if (prev == null || prev === nextContent || prev.trim() === '') return;
    const now = Date.now();
    if (now - (this.lastSnapshot.get(rel) ?? 0) < 5 * 60 * 1000) return;
    this.lastSnapshot.set(rel, now);
    const dir = this.historyDir(rel);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, `${now}.md`), prev, 'utf8');
      const all = (await fsp.readdir(dir)).filter((f) => /^\d+\.md$/.test(f)).sort();
      for (const old of all.slice(0, Math.max(0, all.length - 50))) await fsp.rm(path.join(dir, old), { force: true });
    } catch (err) {
      console.error('[octavo] could not save history snapshot:', err);
    }
  }

  /** Saved versions of a note, newest first. */
  async history(nameOrPath: string): Promise<{ id: string; time: number; size: number }[]> {
    const rel = this.resolve(nameOrPath) ?? normalizeNotePath(nameOrPath);
    const dir = this.historyDir(rel);
    const files = await fsp.readdir(dir).catch(() => [] as string[]);
    const out: { id: string; time: number; size: number }[] = [];
    for (const f of files) {
      const m = /^(\d+)\.md$/.exec(f);
      if (!m) continue;
      const st = await fsp.stat(path.join(dir, f));
      out.push({ id: m[1], time: Number(m[1]), size: st.size });
    }
    return out.sort((a, b) => b.time - a.time);
  }

  async readVersion(nameOrPath: string, id: string): Promise<string> {
    if (!/^\d+$/.test(id)) throw new VaultPathError('Invalid version id');
    const rel = this.resolve(nameOrPath) ?? normalizeNotePath(nameOrPath);
    try {
      return await fsp.readFile(path.join(this.historyDir(rel), `${id}.md`), 'utf8');
    } catch {
      throw new NoteNotFoundError(`${rel} (version ${id})`);
    }
  }

  /** Restore an old version (the current content is snapshotted first, so this can be undone). */
  async restoreVersion(nameOrPath: string, id: string): Promise<NoteSummary> {
    const content = await this.readVersion(nameOrPath, id);
    const rel = this.resolve(nameOrPath) ?? normalizeNotePath(nameOrPath);
    this.lastSnapshot.delete(rel);
    return this.write(rel, content);
  }

  // ---------------------------------------------------------------- insights

  /** Notes that mention this note's name (or aliases) in plain text without linking to it. */
  unlinkedMentions(nameOrPath: string): Backlink[] {
    const target = this.requireNote(nameOrPath);
    const names = [target.name, ...target.aliases].filter((n) => n.length >= 3);
    if (!names.length) return [];
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_\\[])(${names.map(esc).join('|')})(?=$|[^\\p{L}\\p{N}_\\]])`, 'iu');
    const out: Backlink[] = [];
    for (const n of this.notes.values()) {
      if (n.path === target.path || n.encrypted) continue;
      if (n.links.some((l) => this.resolveLink(l, n.path) === target.path)) continue;
      const { body } = splitFrontmatter(n.content);
      const offset = n.content.slice(0, n.content.length - body.length).split('\n').length - 1;
      const lines = maskCode(body).split('\n');
      const orig = body.split('\n');
      const context: { line: number; text: string }[] = [];
      lines.forEach((line, i) => {
        // Ignore text inside [[...]] so links to other notes don't count.
        if (context.length < 3 && re.test(line.replace(/\[\[[^\]]*\]\]/g, (m) => ' '.repeat(m.length)))) {
          context.push({ line: i + 1 + offset, text: orig[i].trim() });
        }
      });
      if (context.length) out.push({ path: n.path, name: n.name, context });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Orphans (nothing links in), dead ends (link nowhere) and links to missing notes. */
  insights(): { orphans: NoteSummary[]; deadEnds: NoteSummary[]; unresolved: { target: string; from: string[] }[] } {
    const incoming = new Set<string>();
    const outgoing = new Set<string>();
    for (const n of this.notes.values()) {
      for (const l of n.links) {
        if (!l.target) continue;
        outgoing.add(n.path);
        const p = this.resolveLink(l, n.path);
        if (p && p !== n.path) incoming.add(p);
      }
    }
    // Templates are meant to stand alone, so they're not reported.
    const all = [...this.notes.values()]
      .filter((n) => !/^templates?\//i.test(n.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    return {
      orphans: all.filter((n) => !incoming.has(n.path)).map(summarize),
      deadEnds: all.filter((n) => !outgoing.has(n.path)).map(summarize),
      unresolved: this.unresolvedLinks().sort((a, b) => b.from.length - a.from.length),
    };
  }

  // ---------------------------------------------------------------- tasks

  /** Every Markdown task (`- [ ] ...`) in the vault. Status is the character between the brackets. */
  tasks(opts: { includeDone?: boolean } = {}): TaskItem[] {
    const out: TaskItem[] = [];
    for (const n of [...this.notes.values()].filter((x) => !x.encrypted).sort((a, b) => a.path.localeCompare(b.path))) {
      const lines = n.content.split('\n');
      const masked = maskCode(n.content).split('\n');
      masked.forEach((line, i) => {
        const m = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(.*)$/.exec(line);
        if (!m) return;
        const done = m[1] === 'x' || m[1] === 'X' || m[1] === '-';
        if (done && !opts.includeDone) return;
        const text = lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+\[.\]\s+/, '').trim();
        if (!text) return; // an empty "- [ ]" placeholder
        const due = taskDueDate(text);
        out.push({ path: n.path, name: n.name, line: i + 1, status: m[1], text, ...(due ? { due } : {}) });
      });
    }
    return out;
  }

  /** Set a task's status (default: toggle between open and done). */
  async setTask(nameOrPath: string, line: number, status?: string): Promise<NoteSummary> {
    const note = this.requireNote(nameOrPath);
    await this.refreshFile(note.path, true);
    if (this.notes.get(note.path)!.encrypted) throw new EncryptedNoteError(note.path);
    const lines = this.notes.get(note.path)!.content.split('\n');
    const current = lines[line - 1];
    const m = current == null ? null : /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\].*)$/.exec(current);
    if (!m) throw new EditMatchError(`Line ${line} of ${note.path} is not a task`);
    const next = status ?? (m[2] === ' ' ? 'x' : ' ');
    if ([...next].length !== 1) throw new EditMatchError('Task status must be a single character');
    lines[line - 1] = m[1] + next + m[3];
    return this.write(note.path, lines.join('\n'));
  }

  // ---------------------------------------------------------------- settings

  /** Small JSON documents stored in the vault's hidden `.octavo/` folder (bookmarks, etc.). */
  async getConfig<T = unknown>(name: string, fallback: T): Promise<T> {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new VaultPathError('Invalid config name');
    try {
      return JSON.parse(await fsp.readFile(path.join(this.root, '.octavo', `${name}.json`), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  async setConfig(name: string, value: unknown): Promise<void> {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new VaultPathError('Invalid config name');
    const dir = path.join(this.root, '.octavo');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${name}.json`), JSON.stringify(value, null, 2), 'utf8');
  }

  // ---------------------------------------------------------------- journal

  dailyNotePath(date = new Date()): string {
    return this.periodicNotePath('day', date);
  }

  /** Journal/2026-11-06.md, Journal/Weekly/2026-W45.md, Journal/Monthly/2026-11.md */
  periodicNotePath(period: Period, date = new Date()): string {
    let rel: string;
    if (period === 'week') {
      const w = isoWeek(date);
      rel = `Weekly/${w.year}-W${pad(w.week)}.md`;
    } else if (period === 'month') rel = `Monthly/${date.getFullYear()}-${pad(date.getMonth() + 1)}.md`;
    else rel = `${formatDate(date)}.md`;
    return this.dailyFolder ? `${this.dailyFolder}/${rel}` : rel;
  }

  /** Return today's daily note, creating it if it doesn't exist. */
  async ensureDailyNote(date = new Date()): Promise<NoteSummary> {
    return this.ensurePeriodicNote('day', date);
  }

  /** Return the note for this day, week or month, creating it if it doesn't exist. */
  async ensurePeriodicNote(period: Period, date = new Date()): Promise<NoteSummary> {
    const rel = this.periodicNotePath(period, date);
    const existing = this.notes.get(rel);
    if (existing) return summarize(existing);
    let content: string;
    if (period === 'week') {
      const w = isoWeek(date);
      const days = Array.from({ length: 7 }, (_, i) => formatDate(new Date(w.monday.getFullYear(), w.monday.getMonth(), w.monday.getDate() + i)));
      content = `# Week ${w.week}, ${w.year}\n\n${formatDate(w.monday)} to ${formatDate(w.sunday)}\n\n## Goals\n\n## Days\n\n${days.map((d) => `- [[${d}]]`).join('\n')}\n\n## Review\n\n`;
    } else if (period === 'month') {
      content = `# ${MONTHS[date.getMonth()]} ${date.getFullYear()}\n\n## Goals\n\n## Notes\n\n## Review\n\n`;
    } else content = `# ${formatDate(date)}\n\n`;
    return this.write(rel, content);
  }

  /** Append a timestamped bullet to today's daily note. */
  async logToJournal(entry: string, date = new Date()): Promise<NoteSummary> {
    const daily = await this.ensureDailyNote(date);
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const lines = entry.trim().split('\n');
    const bullet = [`- **${time}** ${lines[0]}`, ...lines.slice(1).map((l) => `  ${l}`)].join('\n');
    return this.append(daily.path, bullet, { separator: 'line' });
  }
}
