import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '@octavo/core';
import { FolderSync, syncFolder } from '../src/folderSync.js';

/** A minimal one-page PDF with a line of text, built by hand (offsets computed). */
function makePdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const old = new Date(Date.now() - 60_000);
async function put(file: string, data: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  await fs.utimes(file, old, old); // settled: not still being written by a cloud drive
}

test('folder sync: PDFs become notes with their text, your own notes survive updates, edited copies are kept', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-fs-vault-'));
  const src = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-fs-src-')), 'Notability');
  await put(path.join(src, 'Physics', 'Lecture 4.pdf'), makePdf('Entropy always increases'));
  await put(path.join(src, 'Ideas.md'), '# Ideas\n- one\n');
  await put(path.join(src, '.hidden.pdf'), makePdf('secret'));
  const vault = await Vault.open(vaultDir, { watch: false });
  try {
    let r = await syncFolder(vault, src, 'Notability');
    assert.deepEqual(r.added.sort(), ['Notability/Ideas.md', 'Notability/Physics/Lecture 4.md']);
    assert.deepEqual(r.errors, []);
    const note = (await vault.read('Notability/Physics/Lecture 4.md')).content;
    assert.match(note, /source: "Notability"/);
    assert.match(note, /!\[\[Notability\/Physics\/Lecture 4\.pdf\]\]/);
    assert.match(note, /> Entropy always increases/);
    assert.ok((await fs.stat(path.join(vaultDir, 'Notability/Physics/Lecture 4.pdf'))).size > 100);
    await assert.rejects(fs.stat(path.join(vaultDir, 'Notability/.hidden.md')));

    // Nothing changed: nothing written.
    r = await syncFolder(vault, src, 'Notability');
    assert.equal(r.added.length + r.updated.length, 0);
    assert.equal(r.unchanged, 2);

    // You add your own notes under the synced part; then the PDF changes in Notability.
    await vault.write('Notability/Physics/Lecture 4.md', note + '\nMy thoughts: check the second law.\n');
    await put(path.join(src, 'Physics', 'Lecture 4.pdf'), makePdf('Entropy and the arrow of time'));
    await fs.utimes(path.join(src, 'Physics', 'Lecture 4.pdf'), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
    r = await syncFolder(vault, src, 'Notability');
    assert.deepEqual(r.updated, ['Notability/Physics/Lecture 4.md']);
    const updated = (await vault.read('Notability/Physics/Lecture 4.md')).content;
    assert.match(updated, /arrow of time/);
    assert.doesNotMatch(updated, /Entropy always increases/);
    assert.match(updated, /My thoughts: check the second law\./);

    // A Markdown copy edited in Octavo is never overwritten.
    await vault.write('Notability/Ideas.md', '# Ideas\n- one\n- mine\n');
    await put(path.join(src, 'Ideas.md'), '# Ideas\n- one\n- two\n');
    await fs.utimes(path.join(src, 'Ideas.md'), new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
    r = await syncFolder(vault, src, 'Notability');
    assert.match(r.errors.join('\n'), /changed in Octavo/);
    assert.match((await vault.read('Notability/Ideas.md')).content, /- mine/);
  } finally {
    vault.close();
  }
});

test('folder sync: the vault itself, folders inside it, or around it, are never watched', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-fs-guard-'));
  const vaultDir = path.join(parent, 'Vault');
  await fs.mkdir(path.join(vaultDir, 'Inside'), { recursive: true });
  const vault = await Vault.open(vaultDir, { watch: false });
  const fsync = new FolderSync(vault, { watch: false });
  try {
    fsync.setFolders([{ source: vaultDir }, { source: path.join(vaultDir, 'Inside') }, { source: parent }, { source: path.join(parent, 'Other') }]);
    assert.deepEqual(fsync.list().map((f) => f.source), [path.join(parent, 'Other')]);
    assert.equal(fsync.list()[0].into, 'Other');
    const [st] = fsync.status();
    assert.equal(st.exists, false);
    const r = await fsync.syncOne(path.join(parent, 'Other'));
    assert.match(r!.errors[0], /Can’t find the folder/);
  } finally {
    fsync.close();
    vault.close();
  }
});

test('folder sync: names in the watched folder can’t climb out of the target folder, and links are skipped', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-fs-vault-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-fs-outside-'));
  const src = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-fs-src-')), 'Shared');
  await fs.mkdir(path.join(vaultDir, 'attachments'), { recursive: true });
  await fs.writeFile(path.join(vaultDir, 'attachments', 'photo.png'), 'mine');
  // " .." passed the old check as ".." (trimmed after the leading dots were removed).
  await put(path.join(src, ' ..', 'attachments', 'photo.png'), 'replaced');
  await put(path.join(src, ' ..', 'Planted.md'), '# planted\n');
  await put(path.join(outside, 'secret.md'), 'secret');
  await fs.symlink(path.join(outside, 'secret.md'), path.join(src, 'link.md'));
  const vault = await Vault.open(vaultDir, { watch: false });
  try {
    const r = await syncFolder(vault, src, 'Shared');
    assert.equal(await fs.readFile(path.join(vaultDir, 'attachments', 'photo.png'), 'utf8'), 'mine');
    await assert.rejects(fs.stat(path.join(vaultDir, 'Planted.md')));
    for (const p of [...r.added, ...r.updated]) assert.ok(p.startsWith('Shared/'), p);
    assert.ok(!r.added.some((p) => /link/.test(p)));
    await assert.rejects(fs.stat(path.join(vaultDir, 'Shared', 'link.md')));
  } finally {
    vault.close();
  }
});

test('safeSegment: dot and space tricks become plain names', async () => {
  const { safeSegment } = await import('../src/folderSync.js');
  for (const bad of ['..', ' ..', '.. ', ' . ', '...', '']) assert.equal(safeSegment(bad), 'Untitled', JSON.stringify(bad));
  assert.equal(safeSegment(' .git'), 'git');
  assert.equal(safeSegment('a/b'), 'a_b');
  assert.equal(safeSegment('Lecture 4'), 'Lecture 4');
});
