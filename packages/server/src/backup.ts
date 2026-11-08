/**
 * Backups: the whole vault folder as one zip file (notes, attachments, canvases, drawings, settings).
 * Version history is left out unless asked for, since it can be large and is easy to rebuild from use.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Vault } from '@octavo/core';
import { zipFiles } from './publish.js';

/** Folders never worth backing up. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian/cache']);
/** The zip writer has no ZIP64 support, and everything is held in memory: stay well inside both. */
const MAX_FILES = 60_000;
const MAX_BYTES = 1.5 * 1024 * 1024 * 1024;

export class BackupTooLargeError extends Error {}
/** A backup is already being built: each one can hold up to MAX_BYTES in memory, so only one at a time. */
export class BackupBusyError extends Error {}
let building = false;

export interface BackupResult {
  zip: Buffer;
  files: number;
  bytes: number;
}

export async function buildBackup(vault: Vault, opts: { history?: boolean } = {}): Promise<BackupResult> {
  if (building) throw new BackupBusyError('A backup is already being made. Try again in a moment.');
  building = true;
  try {
    return await build(vault, opts);
  } finally {
    building = false;
  }
}

async function build(vault: Vault, opts: { history?: boolean }): Promise<BackupResult> {
  const root = vault.root;
  const files = new Map<string, Buffer>();
  let bytes = 0;
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue; // never follow links out of the vault
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(childRel) || SKIP_DIRS.has(e.name)) continue;
        if (!opts.history && childRel === '.octavo/history') continue;
        await walk(childRel);
      } else if (e.isFile()) {
        const tooBig = () => new BackupTooLargeError('This vault is too big for a zip backup from Octavo. Copy the vault folder itself instead (it’s just files).');
        // Check the size before reading, so one huge file is refused without being loaded into memory.
        const size = (await fs.stat(path.join(root, childRel)).catch(() => null))?.size ?? 0;
        if (files.size >= MAX_FILES || bytes + size > MAX_BYTES) throw tooBig();
        const data = await fs.readFile(path.join(root, childRel));
        bytes += data.length;
        if (bytes > MAX_BYTES) throw tooBig();
        files.set(childRel, data);
      }
    }
  };
  await walk('');
  const top = path.basename(root).replace(/[\\/:*?"<>|]+/g, '_') || 'vault';
  return { zip: zipFiles(files, `${top}/`), files: files.size, bytes };
}

/** "Octavo backup 2026-11-07.zip"-style name for the download. */
export function backupName(vault: Vault, now = new Date()): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${path.basename(vault.root)} backup ${day}.zip`;
}

/**
 * Automatic backups: when switched on (saved in the vault's `autobackup` config), a zip a day goes to a
 * "<vault> backups" folder next to the vault, keeping the newest few. The folder is fixed on purpose, so a
 * phone or remote client can switch this on but can never choose where on the PC files get written.
 */
export interface AutoBackupConfig {
  on: boolean;
  keep: number;
}
export interface AutoBackupStatus extends AutoBackupConfig {
  folder: string;
  last: { name: string; at: string } | null;
  error?: string;
}

const DAY = 24 * 60 * 60 * 1000;
const BACKUP_FILE = / backup \d{4}-\d{2}-\d{2}( \d+)?\.zip$/;

export function autoBackupFolder(vault: Vault): string {
  return path.join(path.dirname(path.resolve(vault.root)), `${path.basename(vault.root)} backups`);
}

export async function getAutoBackupConfig(vault: Vault): Promise<AutoBackupConfig> {
  const c = (await vault.getConfig<Partial<AutoBackupConfig> | null>('autobackup', null)) ?? {};
  const keep = Number(c.keep);
  return { on: c.on === true, keep: Number.isInteger(keep) && keep >= 1 && keep <= 365 ? keep : 7 };
}

async function listBackups(folder: string): Promise<{ name: string; at: number }[]> {
  const names = (await fs.readdir(folder).catch(() => [] as string[])).filter((n) => BACKUP_FILE.test(n));
  const out = await Promise.all(names.map(async (name) => ({ name, at: (await fs.stat(path.join(folder, name)).catch(() => null))?.mtimeMs ?? 0 })));
  return out.sort((a, b) => b.at - a.at);
}

let lastError = '';

export async function autoBackupStatus(vault: Vault): Promise<AutoBackupStatus> {
  const cfg = await getAutoBackupConfig(vault);
  const folder = autoBackupFolder(vault);
  const [newest] = await listBackups(folder);
  return { ...cfg, folder, last: newest ? { name: newest.name, at: new Date(newest.at).toISOString() } : null, ...(lastError ? { error: lastError } : {}) };
}

/** Make today's backup if one is due (or `force`), then remove the oldest beyond `keep`. Returns the file written, if any. */
export async function runAutoBackup(vault: Vault, opts: { force?: boolean; now?: Date } = {}): Promise<string | null> {
  const cfg = await getAutoBackupConfig(vault);
  if (!cfg.on && !opts.force) return null;
  const folder = autoBackupFolder(vault);
  const now = opts.now ?? new Date();
  const existing = await listBackups(folder);
  if (!opts.force && existing[0] && now.getTime() - existing[0].at < DAY - 60 * 60 * 1000) return null;
  try {
    const b = await buildBackup(vault);
    await fs.mkdir(folder, { recursive: true });
    const base = backupName(vault, now).replace(/\.zip$/, '');
    let file = path.join(folder, `${base}.zip`);
    for (let i = 2; existing.some((e) => path.join(folder, e.name) === file); i++) file = path.join(folder, `${base} ${i}.zip`);
    await fs.writeFile(`${file}.part`, b.zip);
    await fs.rename(`${file}.part`, file);
    lastError = '';
    const all = await listBackups(folder);
    for (const old of all.slice(cfg.keep)) await fs.rm(path.join(folder, old.name), { force: true });
    return file;
  } catch (err) {
    lastError = (err as Error).message;
    throw err;
  }
}

/** Check once a minute after start, then hourly; a backup is made at most once a day. */
export function scheduleAutoBackups(vault: Vault): () => void {
  const tick = () => void runAutoBackup(vault).catch(() => {});
  const first = setTimeout(tick, 60_000);
  const every = setInterval(tick, 60 * 60 * 1000);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
