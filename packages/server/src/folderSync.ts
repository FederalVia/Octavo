/**
 * Notes from other apps: keep a folder outside the vault (e.g. the Google Drive / OneDrive / Dropbox folder
 * Notability or GoodNotes back up to) mirrored into the vault, one way.
 *
 * - A PDF becomes a note that embeds it, with the PDF's text (typed text; handwriting has none) underneath,
 *   so search and Claude can find it. An image becomes a note that shows it.
 * - Markdown and text files are copied as notes.
 * - When the original changes, the synced part of the note is replaced. Anything you write outside the
 *   `%% synced %%` lines stays. Deleting the original never deletes the note (backups are one-way too).
 *
 * Which folders are watched is set on the computer itself (desktop app or command line), never over the
 * web API, so a phone or remote client can't make Octavo read other folders on the PC.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Vault } from '@octavo/core';

export interface WatchedFolder {
  /** Absolute folder on this computer. */
  source: string;
  /** Vault folder the notes go in (default: the source folder's name). */
  into?: string;
}

export interface SyncResult {
  at: string;
  added: string[];
  updated: string[];
  unchanged: number;
  errors: string[];
}

export interface FolderStatus {
  source: string;
  into: string;
  exists: boolean;
  last: SyncResult | null;
  running: boolean;
}

const PDF = /\.pdf$/i;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const TEXT = /\.(md|markdown|txt)$/i;
const MAX_FILE = 200 * 1024 * 1024;
const MAX_TEXT_CHARS = 60_000;
const START = '%% synced: start. Octavo updates the part between these lines when the original changes; write your own notes outside them. %%';
const END = '%% synced: end %%';

type FileState = { mtime: number; size: number; note?: string; wrote?: string };
type FolderState = { files: Record<string, FileState>; last?: SyncResult };

const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 20);

/** Whether `child` is `parent` or inside it (different drives on Windows are never inside each other). */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function defaultInto(source: string): string {
  return path.basename(path.resolve(source)).replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').trim() || 'Imported';
}

/** Every file worth syncing under a folder (hidden files and folders skipped), as `/`-separated relative paths. */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile() && (PDF.test(e.name) || IMAGE.test(e.name) || TEXT.test(e.name))) out.push(child);
    }
  };
  await walk('');
  return out.sort();
}

/** The text in a PDF, page by page (empty for handwriting-only pages). */
export async function pdfText(data: Buffer): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const r = await extractText(pdf, { mergePages: false });
    return (Array.isArray(r.text) ? r.text : [r.text]).map((t) => t.replace(/[ \t]+\n/g, '\n').trim());
  } finally {
    await pdf.destroy?.();
  }
}

/**
 * One folder or file name from the watched folder, safe as one segment of a vault path. Leading/trailing dots and
 * spaces go (trimmed before the dots, so " .." can't survive as ".." and climb out of the target folder).
 */
export function safeSegment(s: string): string {
  return s.replace(/[\\/:*?"<>|#^[\]]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '') || 'Untitled';
}

/** The synced block of a note for a PDF or image. */
function syncedBlock(embedPath: string, pages: string[] | null): string {
  const lines = [START, `![[${embedPath}]]`];
  const text = (pages ?? []).map((t, i) => (t ? `**Page ${i + 1}**\n${t}` : '')).filter(Boolean).join('\n\n');
  if (text) {
    const clipped = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + '\n…' : text;
    lines.push('', '> [!quote]- Text in the PDF', ...clipped.split('\n').map((l) => `> ${l}`));
  }
  lines.push(END);
  return lines.join('\n');
}

/** Put a new synced block into an existing note, keeping everything outside the markers. */
function replaceBlock(content: string, block: string): string | null {
  const a = content.indexOf(START);
  const b = content.indexOf(END, a + 1);
  if (a === -1 || b === -1) return null;
  return content.slice(0, a) + block + content.slice(b + END.length);
}

function frontmatter(app: string, rel: string, at: string): string {
  return `---\nsource: ${JSON.stringify(app)}\nsynced-from: ${JSON.stringify(rel)}\nsynced: ${at}\n---\n`;
}

export class FolderSync {
  private folders: WatchedFolder[] = [];
  private watchers = new Map<string, fs.FSWatcher>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Set<string>();
  private again = new Set<string>();
  private lastResults = new Map<string, SyncResult>();
  private tick: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private vault: Vault,
    private opts: { watch?: boolean; onSynced?: (source: string, r: SyncResult) => void } = {},
  ) {}

  private statePath() {
    return path.join(this.vault.root, '.octavo', 'folder-sync.json');
  }

  private async loadState(): Promise<Record<string, FolderState>> {
    try {
      return JSON.parse(await fsp.readFile(this.statePath(), 'utf8'));
    } catch {
      return {};
    }
  }

  private async saveState(state: Record<string, FolderState>) {
    await fsp.mkdir(path.dirname(this.statePath()), { recursive: true });
    await fsp.writeFile(this.statePath(), JSON.stringify(state, null, 1));
  }

  /** Replace the watched folders (the desktop app's setting, or `--watch-folder` on the command line). */
  setFolders(list: WatchedFolder[]): void {
    const seen = new Set<string>();
    const root = path.resolve(this.vault.root);
    this.folders = [];
    for (const f of list) {
      if (!f?.source) continue;
      const source = path.resolve(f.source);
      // Never watch the vault itself or a folder inside it (it would copy itself forever), nor a folder containing it.
      if (isInside(root, source) || isInside(source, root)) continue;
      if (seen.has(source)) continue;
      seen.add(source);
      this.folders.push({ source, into: f.into?.trim() || defaultInto(source) });
    }
    for (const [src, w] of this.watchers) if (!seen.has(src)) (w.close(), this.watchers.delete(src));
    if (this.opts.watch === false || this.closed) return;
    for (const f of this.folders) {
      if (this.watchers.has(f.source)) continue;
      try {
        const w = fs.watch(f.source, { recursive: true }, () => this.schedule(f.source, 2500));
        w.on('error', () => {
          w.close();
          this.watchers.delete(f.source);
        });
        this.watchers.set(f.source, w);
      } catch {
        /* folder missing or unreadable: the periodic check picks it up once it's there */
      }
      this.schedule(f.source, 1500);
    }
    // Cloud folders can change while a watch is down (sleep, the drive reconnecting): look again every 10 minutes.
    if (!this.tick) {
      this.tick = setInterval(() => this.folders.forEach((f) => this.schedule(f.source, 0)), 10 * 60 * 1000);
      this.tick.unref?.();
    }
  }

  list(): WatchedFolder[] {
    return this.folders.map((f) => ({ ...f }));
  }

  status(): FolderStatus[] {
    return this.folders.map((f) => ({
      source: f.source,
      into: f.into!,
      exists: fs.existsSync(f.source),
      last: this.lastResults.get(f.source) ?? null,
      running: this.running.has(f.source),
    }));
  }

  private schedule(source: string, delay: number) {
    if (this.closed) return;
    clearTimeout(this.timers.get(source));
    const t = setTimeout(() => {
      this.timers.delete(source);
      void this.syncOne(source).catch(() => {});
    }, delay);
    t.unref?.();
    this.timers.set(source, t);
  }

  /** Sync every watched folder now. */
  async syncAll(): Promise<FolderStatus[]> {
    for (const f of this.folders) await this.syncOne(f.source);
    return this.status();
  }

  async syncOne(source: string): Promise<SyncResult | null> {
    const folder = this.folders.find((f) => f.source === path.resolve(source));
    if (!folder || this.closed) return null;
    if (this.running.has(folder.source)) {
      this.again.add(folder.source);
      return null;
    }
    this.running.add(folder.source);
    try {
      const r = await syncFolder(this.vault, folder.source, folder.into!, this);
      this.lastResults.set(folder.source, r);
      this.opts.onSynced?.(folder.source, r);
      return r;
    } finally {
      this.running.delete(folder.source);
      if (this.again.delete(folder.source)) this.schedule(folder.source, 1000);
    }
  }

  /** @internal state shared by every sync of this vault */
  async withState<T>(fn: (state: Record<string, FolderState>) => Promise<T>): Promise<T> {
    const state = await this.loadState();
    try {
      return await fn(state);
    } finally {
      await this.saveState(state);
    }
  }

  /** @internal a file still being written (cloud sync in progress): look again shortly. */
  retrySoon(source: string) {
    this.schedule(source, 5000);
  }

  close() {
    this.closed = true;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.tick) clearInterval(this.tick);
  }
}

/**
 * Mirror one folder into the vault. Without a FolderSync (the one-off `octavo sync-folder` command) state is
 * kept the same way, so running it again only touches what changed.
 */
export async function syncFolder(vault: Vault, source: string, into: string, owner?: FolderSync): Promise<SyncResult> {
  const src = path.resolve(source);
  const app = path.basename(src);
  const result: SyncResult = { at: new Date().toISOString(), added: [], updated: [], unchanged: 0, errors: [] };
  const run = async (state: Record<string, FolderState>) => {
    const fstate: FolderState = (state[src] ??= { files: {} });
    if (!fs.existsSync(src)) {
      result.errors.push(`Can’t find the folder ${src}. Is the cloud drive connected?`);
      fstate.last = result;
      return;
    }
    const base = into.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    let fresh = false;
    for (const rel of await listFiles(src)) {
      try {
        const full = path.join(src, rel);
        // lstat: a file swapped for a link since the listing is skipped, never followed out of the folder.
        const st = await fsp.lstat(full);
        if (!st.isFile()) continue;
        const prev = fstate.files[rel];
        if (prev && prev.mtime === Math.round(st.mtimeMs) && prev.size === st.size) {
          result.unchanged++;
          continue;
        }
        if (st.size > MAX_FILE) {
          result.errors.push(`${rel}: over 200 MB, skipped`);
          continue;
        }
        // Still being written by the cloud drive: leave it for the next look.
        if (Date.now() - st.mtimeMs < 3000) {
          fresh = true;
          continue;
        }
        const dirParts = rel.split('/').slice(0, -1).map(safeSegment);
        const file = rel.split('/').pop()!;
        const ext = path.extname(file);
        const stem = safeSegment(file.slice(0, file.length - ext.length));
        const dir = [base, ...dirParts].filter(Boolean).join('/');
        const notePath = `${dir ? dir + '/' : ''}${stem}.md`;
        const existing = vault.resolve(notePath) ? await vault.read(notePath).catch(() => null) : null;
        let content: string;
        if (TEXT.test(file)) {
          const text = await fsp.readFile(full, 'utf8');
          // A copy you edited in Octavo is never overwritten.
          if (existing && prev?.wrote && sha(existing.content) !== prev.wrote) {
            result.errors.push(`${rel}: changed in Octavo since the last sync, so it wasn’t overwritten`);
            fstate.files[rel] = { ...prev, mtime: Math.round(st.mtimeMs), size: st.size };
            continue;
          }
          if (existing && !prev) {
            result.errors.push(`${rel}: ${notePath} already exists, so it wasn’t overwritten`);
            continue;
          }
          content = text;
        } else {
          const data = await fsp.readFile(full);
          const attachment = `${dir ? dir + '/' : ''}${stem}${ext.toLowerCase()}`;
          await vault.writeAttachment(attachment, data);
          let pages: string[] | null = null;
          if (PDF.test(file)) {
            try {
              pages = await pdfText(data);
            } catch {
              pages = null; // damaged or encrypted PDF: still embedded, just without text
            }
          }
          const block = syncedBlock(attachment, pages);
          if (existing) {
            const replaced = replaceBlock(existing.content, block);
            // The synced lines were removed by hand: keep the note as it is (the PDF itself is still updated).
            content = replaced ?? existing.content;
            content = content.replace(/^(---\r?\n[\s\S]*?)synced: [^\n]*\n/, `$1synced: ${result.at}\n`);
          } else content = `${frontmatter(app, rel, result.at)}# ${stem}\n\n${block}\n`;
        }
        if (existing && existing.content === content) {
          result.unchanged++;
        } else {
          await vault.write(notePath, content);
          (existing ? result.updated : result.added).push(notePath);
        }
        fstate.files[rel] = { mtime: Math.round(st.mtimeMs), size: st.size, note: notePath, wrote: sha(content) };
      } catch (err) {
        result.errors.push(`${rel}: ${(err as Error).message}`);
      }
    }
    fstate.last = result;
    if (fresh) owner?.retrySoon(src);
  };
  if (owner) await owner.withState(run);
  else {
    const statePath = path.join(vault.root, '.octavo', 'folder-sync.json');
    let state: Record<string, FolderState> = {};
    try {
      state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    } catch {
      /* first run */
    }
    await run(state);
    await fsp.mkdir(path.dirname(statePath), { recursive: true });
    await fsp.writeFile(statePath, JSON.stringify(state, null, 1));
  }
  return result;
}
