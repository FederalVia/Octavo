import path from 'node:path';

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultPathError';
  }
}

/**
 * Normalize a user/agent supplied note path into a vault-relative POSIX path
 * ending in `.md`. Rejects anything that escapes the vault or touches hidden
 * folders (.git, .trash, .obsidian, ...).
 */
export function normalizeNotePath(input: string): string {
  if (typeof input !== 'string') throw new VaultPathError('Path must be a string');
  let p = input.trim().replace(/\\/g, '/');
  if (!p) throw new VaultPathError('Path is empty');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) {
    throw new VaultPathError(`Path must be relative to the vault: ${input}`);
  }
  p = path.posix.normalize(p);
  const segments = p.split('/').filter((s) => s && s !== '.');
  if (segments.length === 0) throw new VaultPathError('Path is empty');
  for (const seg of segments) {
    if (seg === '..') throw new VaultPathError(`Path escapes the vault: ${input}`);
    if (seg.startsWith('.')) throw new VaultPathError(`Hidden paths are not allowed: ${input}`);
  }
  p = segments.join('/');
  if (!p.toLowerCase().endsWith('.md')) p += '.md';
  return p;
}

export function normalizeFolderPath(input: string | undefined | null): string {
  if (!input) return '';
  const p = input.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!p) return '';
  const segments = path.posix.normalize(p).split('/').filter((s) => s && s !== '.');
  for (const seg of segments) {
    if (seg === '..' || seg.startsWith('.')) throw new VaultPathError(`Invalid folder: ${input}`);
  }
  return segments.join('/');
}

/** "Projects/Octavo.md" -> "Octavo" */
export function noteName(relPath: string): string {
  return path.posix.basename(relPath).replace(/\.md$/i, '');
}

/** "Projects/Octavo.md" -> "Projects" ("" for root). */
export function noteFolder(relPath: string): string {
  const d = path.posix.dirname(relPath);
  return d === '.' ? '' : d;
}

export function stripMd(p: string): string {
  return p.replace(/\.md$/i, '');
}
