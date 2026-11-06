import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../src/index.js';

describe('Vault extras', () => {
  let dir: string;
  let vault: Vault;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-extras-'));
    await fs.mkdir(path.join(dir, 'img'));
    await fs.writeFile(path.join(dir, 'img', 'Cat Photo.png'), Buffer.from([137, 80, 78, 71]));
    await fs.writeFile(path.join(dir, 'Alpha.md'), '# Alpha\nTalks about Beta a lot. ![[Cat Photo.png]]\n- [ ] open task\n- [x] done task\n- [?] question\n```\n- [ ] not a task\n```\n');
    await fs.writeFile(path.join(dir, 'Beta.md'), '# Beta\nNo links here.\n');
    await fs.writeFile(path.join(dir, 'Gamma.md'), '# Gamma\nLinks [[Beta]] and mentions alpha.\n');
    vault = await Vault.open(dir, { watch: false });
  });

  after(async () => {
    vault.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('resolves attachments by name and saves uploads', async () => {
    assert.equal(vault.resolveAttachment('Cat Photo.png'), 'img/Cat Photo.png');
    assert.equal(vault.resolveAttachment('img/Cat Photo.png'), 'img/Cat Photo.png');
    assert.equal(vault.resolveAttachment('nope.png'), null);
    const a = await vault.saveAttachment('shot.png', Buffer.from('x'));
    const b = await vault.saveAttachment('shot.png', Buffer.from('y'));
    assert.equal(a, 'attachments/shot.png');
    assert.equal(b, 'attachments/shot 1.png');
    assert.throws(() => vault.filePath('../etc/passwd'));
    assert.throws(() => vault.filePath('.octavo/bookmarks.json'));
  });

  test('unlinked mentions skip notes that already link', () => {
    const m = vault.unlinkedMentions('Beta').map((x) => x.path);
    assert.deepEqual(m, ['Alpha.md']); // Gamma links to Beta, so it is not an unlinked mention
    assert.deepEqual(vault.unlinkedMentions('Alpha').map((x) => x.path), ['Gamma.md']);
  });

  test('insights: orphans and dead ends', () => {
    const i = vault.insights();
    assert.deepEqual(i.orphans.map((n) => n.path), ['Alpha.md', 'Gamma.md']);
    // Alpha's only "link" is an image embed, which doesn't count as linking to a note.
    assert.deepEqual(i.deadEnds.map((n) => n.path), ['Alpha.md', 'Beta.md']);
  });

  test('tasks: list and toggle, ignoring code blocks', async () => {
    assert.deepEqual(
      vault.tasks().map((t) => [t.text, t.status]),
      [
        ['open task', ' '],
        ['question', '?'],
      ],
    );
    assert.equal(vault.tasks({ includeDone: true }).length, 3);
    const t = vault.tasks()[0];
    await vault.setTask(t.path, t.line);
    assert.equal(vault.tasks().length, 1);
    await assert.rejects(vault.setTask('Alpha', 1));
  });

  test('history snapshots and restore', async () => {
    await vault.write('Beta', '# Beta\nversion two\n');
    const h = await vault.history('Beta');
    assert.equal(h.length, 1);
    assert.equal(await vault.readVersion('Beta', h[0].id), '# Beta\nNo links here.\n');
    // Throttled: a second quick write does not add a snapshot.
    await vault.write('Beta', '# Beta\nversion three\n');
    assert.equal((await vault.history('Beta')).length, 1);
    await vault.restoreVersion('Beta', h[0].id);
    assert.equal((await vault.read('Beta')).content, '# Beta\nNo links here.\n');
    assert.equal((await vault.history('Beta')).length, 2); // restore snapshotted "version three"
  });

  test('migrates the legacy .ultron folder', async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-legacy-'));
    await fs.mkdir(path.join(d, '.ultron'));
    await fs.writeFile(path.join(d, '.ultron', 'bookmarks.json'), '[{"type":"url","url":"https://x"}]');
    const v = await Vault.open(d, { watch: false });
    assert.deepEqual(await v.getConfig('bookmarks', []), [{ type: 'url', url: 'https://x' }]);
    v.close();
    await fs.rm(d, { recursive: true, force: true });
  });

  test('config storage', async () => {
    assert.deepEqual(await vault.getConfig('bookmarks', []), []);
    await vault.setConfig('bookmarks', [{ type: 'note', path: 'Alpha.md' }]);
    assert.deepEqual(await vault.getConfig('bookmarks', []), [{ type: 'note', path: 'Alpha.md' }]);
    await assert.rejects(vault.setConfig('../x', 1));
  });
});
