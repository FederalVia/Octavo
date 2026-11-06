/**
 * Sharing "Claude read this note" between processes.
 *
 * Claude Desktop runs its own Octavo process (`octavo mcp`, over stdio), separate from the app the
 * user has open. File changes reach the app through the vault's file watcher, but reads leave no
 * trace on disk, so the atlas trail never showed them. The stdio process now appends each read to a
 * small activity file in the OS temp folder (named after the vault, outside it so it never syncs),
 * and the app's server tails that file. It holds only note paths and times.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 256 * 1024;

export function activityFile(vaultRoot: string): string {
  let key = path.resolve(vaultRoot);
  try {
    key = fs.realpathSync.native(key); // the same folder through a symlink or short name must hash the same
  } catch {
    /* keep the given path */
  }
  if (process.platform !== 'linux') key = key.toLowerCase();
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `octavo-activity-${hash}.jsonl`);
}

/** Record that a note was read (called by the stdio MCP process). Never throws. */
export function recordAccess(vaultRoot: string, notePath: string): void {
  const file = activityFile(vaultRoot);
  try {
    const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_BYTES) fs.writeFileSync(file, ''); // start over; only new lines matter
    fs.appendFileSync(file, JSON.stringify({ t: Date.now(), path: notePath }) + '\n');
  } catch {
    /* temp folder not writable: the trail just won't show this read */
  }
}

/** Call `onAccess` for every read recorded from now on. Returns a function that stops watching. */
export function watchActivity(vaultRoot: string, onAccess: (notePath: string) => void): () => void {
  const file = activityFile(vaultRoot);
  let offset = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  let partial = '';
  const check = () => {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0; // the file was started over
    if (size === offset) return;
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;
      const text = partial + buf.toString('utf8');
      const lines = text.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as { path?: unknown };
          if (typeof e.path === 'string') onAccess(e.path);
        } catch {
          /* ignore a damaged line */
        }
      }
    } catch {
      /* try again next time */
    }
  };
  const timer = setInterval(check, 700);
  timer.unref?.();
  return () => clearInterval(timer);
}
