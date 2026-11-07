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

export interface BackupResult {
  zip: Buffer;
  files: number;
  bytes: number;
}

export async function buildBackup(vault: Vault, opts: { history?: boolean } = {}): Promise<BackupResult> {
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
        const data = await fs.readFile(path.join(root, childRel));
        bytes += data.length;
        if (files.size >= MAX_FILES || bytes > MAX_BYTES) {
          throw new BackupTooLargeError('This vault is too big for a zip backup from Octavo. Copy the vault folder itself instead (it’s just files).');
        }
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
