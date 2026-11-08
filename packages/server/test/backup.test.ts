import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '@octavo/core';
import { buildBackup, backupName } from '../src/backup.js';
import { runNoteCommand } from '../src/commands.js';

/** File names stored in a zip, read from its central directory. */
function zipNames(zip: Buffer): string[] {
  const names: string[] = [];
  for (let i = 0; i < zip.length - 46; i++) {
    if (zip.readUInt32LE(i) !== 0x02014b50) continue;
    const n = zip.readUInt16LE(i + 28);
    names.push(zip.subarray(i + 46, i + 46 + n).toString('utf8'));
  }
  return names;
}

test('backup: whole vault, history only when asked, no symlinks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-backup-'));
  await fs.mkdir(path.join(dir, 'Projects'), { recursive: true });
  await fs.mkdir(path.join(dir, 'attachments'), { recursive: true });
  await fs.mkdir(path.join(dir, '.octavo', 'history'), { recursive: true });
  await fs.writeFile(path.join(dir, 'Projects', 'Alpha.md'), '# Alpha\n');
  await fs.writeFile(path.join(dir, 'attachments', 'pic.png'), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(dir, 'Board.canvas'), '{"nodes":[],"edges":[]}');
  await fs.writeFile(path.join(dir, '.octavo', 'islands.json'), '{"islands":[]}');
  await fs.writeFile(path.join(dir, '.octavo', 'history', 'old.md'), 'old');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-outside-'));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  try {
    await fs.symlink(outside, path.join(dir, 'linked'), 'dir');
  } catch {
    /* symlinks may be unavailable */
  }

  const vault = await Vault.open(dir, { watch: false });
  try {
    const top = path.basename(dir);
    const plain = await buildBackup(vault);
    const names = zipNames(plain.zip);
    for (const f of ['Projects/Alpha.md', 'attachments/pic.png', 'Board.canvas', '.octavo/islands.json']) assert.ok(names.includes(`${top}/${f}`), f);
    assert.ok(!names.some((n) => n.includes('history')), 'history left out');
    assert.ok(!names.some((n) => n.includes('secret')), 'symlink not followed');
    assert.equal(plain.files, 4);

    const withHistory = await buildBackup(vault, { history: true });
    assert.ok(zipNames(withHistory.zip).includes(`${top}/.octavo/history/old.md`));

    assert.match(backupName(vault, new Date(2026, 10, 7)), / backup 2026-11-07\.zip$/);

    // The CLI refuses to write the backup inside the vault itself.
    await assert.rejects(runNoteCommand(dir, 'backup', [path.join(dir, 'b.zip')], {}), /outside the vault/);
    await assert.rejects(fs.stat(path.join(dir, 'b.zip')));
  } finally {
    vault.close();
  }
});

test('automatic backups: off by default, daily once switched on, keeps the newest N', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-auto-'));
  const dir = path.join(parent, 'Notes');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'A.md'), '# A\n');
  const vault = await Vault.open(dir, { watch: false });
  try {
    const { runAutoBackup, autoBackupStatus, autoBackupFolder } = await import('../src/backup.js');
    assert.equal(autoBackupFolder(vault), path.join(parent, 'Notes backups'));
    assert.equal(await runAutoBackup(vault), null, 'off by default');
    await vault.setConfig('autobackup', { on: true, keep: 2 });
    const first = await runAutoBackup(vault, { now: new Date(2026, 10, 1) });
    assert.ok(first && first.endsWith('Notes backup 2026-11-01.zip'));
    assert.equal(await runAutoBackup(vault, { now: new Date(2026, 10, 1, 12) }), null, 'not twice a day');
    await runAutoBackup(vault, { force: true, now: new Date(2026, 10, 2) });
    await runAutoBackup(vault, { force: true, now: new Date(2026, 10, 3) });
    const files = (await fs.readdir(path.join(parent, 'Notes backups'))).sort();
    assert.equal(files.length, 2, `kept two: ${files.join(', ')}`);
    assert.ok(!files.some((f) => f.endsWith('.part')));
    const status = await autoBackupStatus(vault);
    assert.equal(status.on, true);
    assert.equal(status.keep, 2);
    assert.ok(status.last);
  } finally {
    vault.close();
  }
});

test('backup: one at a time (each can hold a lot of memory), the next one works again', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-busy-'));
  for (let i = 0; i < 20; i++) await fs.writeFile(path.join(dir, `N${i}.md`), `# ${i}\n`);
  const vault = await Vault.open(dir, { watch: false });
  try {
    const { BackupBusyError } = await import('../src/backup.js');
    const first = buildBackup(vault);
    await assert.rejects(buildBackup(vault), BackupBusyError);
    assert.equal((await first).files, 20);
    assert.equal((await buildBackup(vault)).files, 20);
  } finally {
    vault.close();
  }
});
