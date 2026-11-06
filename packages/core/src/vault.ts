import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { maskCode, parseNote, parseWikiInner, splitFrontmatter, type ParsedLink } from './parse.js';
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
  return { path: n.path, name: n.name, folder: n.folder, tags: n.tags, mtime: n.mtime, ctime: n.ctime, size: n.size };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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
    const parsed = parseNote(content);
    return {
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

  private async walk(dirRel: string, out: string[]): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(this.abs(dirRel || '.'), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDirectory()) await this.walk(rel, out);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(rel);
    }
  }

  /** Full rescan of the vault folder, reconciling the index with disk. */
  async rescan(emit = true): Promise<void> {
    const files: string[] = [];
    await this.walk('', files);
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
        console.error('[ultron] file watcher error:', err);
      });
    } catch (err) {
      console.error('[ultron] could not watch vault folder; external edits will not be detected live:', err);
    }
  }

  private scheduleFile(rel: string) {
    const existing = this.pending.get(rel);
    if (existing) clearTimeout(existing);
    this.pending.set(
      rel,
      setTimeout(() => {
        this.pending.delete(rel);
        this.refreshFile(rel, true).catch((err) => console.error('[ultron] refresh failed:', err));
      }, 75),
    );
  }

  private scheduleRescan() {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      this.rescan(true).catch((err) => console.error('[ultron] rescan failed:', err));
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

  /** Resolve a bare name/path typed by a user or agent ("Ultron", "Projects/Ultron.md"). */
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
    return searchNotes(this.notes.values(), query, limit);
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
      nodes.set(n.path, { id: n.path, name: n.name, tags: n.tags, degree: 0 });
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

    const newName = noteName(to);
    const others = [...(this.byName.get(newName.toLowerCase()) ?? [])].filter((p) => p !== from);
    const wikiTarget = others.length === 0 ? newName : stripMd(to);
    const srcAliases = new Set(src.aliases.map((a) => a.toLowerCase()));

    // Compute link rewrites against the pre-rename index.
    const rewrites = new Map<string, { content: string; count: number }>();
    if (opts.updateLinks !== false) {
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
          if (srcAliases.has(lt) && lt !== src.name.toLowerCase()) continue; // alias links still work
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

  // ---------------------------------------------------------------- journal

  dailyNotePath(date = new Date()): string {
    const name = `${formatDate(date)}.md`;
    return this.dailyFolder ? `${this.dailyFolder}/${name}` : name;
  }

  /** Return today's daily note, creating it if it doesn't exist. */
  async ensureDailyNote(date = new Date()): Promise<NoteSummary> {
    const rel = this.dailyNotePath(date);
    const existing = this.notes.get(rel);
    if (existing) return summarize(existing);
    return this.write(rel, `# ${formatDate(date)}\n\n`);
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
