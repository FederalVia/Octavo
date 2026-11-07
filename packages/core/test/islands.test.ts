import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../src/index.js';

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-islands-'));
  const w = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  };
  await w('Concepts/Graphs.md', 'See [[Grace]].\n');
  await w('Theology/Grace.md', 'Links to [[Augustine]] and [[Graphs]].\n');
  await w('Theology/Church Fathers/Augustine.md', '# Augustine\n');
  await w('People/Monica.md', '---\nregion: Theology\n---\nMother of [[Augustine]].\n');
  await w('Theologyish/Not Me.md', 'A folder whose name only starts the same.\n');
  return { dir, vault: await Vault.open(dir, { watch: false }) };
}

test('a folder becomes an island: graph nodes, regionOf, properties, persistence', async () => {
  const { dir, vault } = await setup();
  try {
    assert.deepEqual(vault.islands(), []);
    assert.equal(vault.graph().nodes.find((n) => n.id === 'Theology/Grace.md')?.island, undefined);

    const saved = await vault.setIslands([{ folder: 'Theology' }]);
    assert.deepEqual(saved, [{ id: 'theology', name: 'Theology', folder: 'Theology', color: '#ff6ad5' }]);

    const g = vault.graph();
    const island = (id: string) => g.nodes.find((n) => n.id === id)?.island;
    assert.equal(island('Theology/Grace.md'), 'theology');
    assert.equal(island('Theology/Church Fathers/Augustine.md'), 'theology', 'subfolders belong too');
    assert.equal(island('People/Monica.md'), 'theology', 'region: <island name> in properties');
    assert.equal(island('Concepts/Graphs.md'), undefined);
    assert.equal(island('Theologyish/Not Me.md'), undefined, 'a prefix of the name is not the folder');
    assert.deepEqual(g.islands?.map((i) => i.id), ['theology']);
    assert.equal(g.links.length, 4, 'links across the island boundary are kept');

    const r = vault.regionOf('Grace');
    assert.equal(r.island?.name, 'Theology');
    assert.equal(r.region, 'parietal', 'the underlying region is still reported');

    // Saved in .octavo/islands.json and loaded again on the next open.
    vault.close();
    const again = await Vault.open(dir, { watch: false });
    try {
      assert.equal(again.graph().nodes.find((n) => n.id === 'Theology/Grace.md')?.island, 'theology');
    } finally {
      again.close();
    }
  } finally {
    vault.close();
  }
});

test('island list is validated: names, ids, colours, duplicates, bad folders', async () => {
  const { vault } = await setup();
  try {
    const saved = await vault.setIslands([
      { folder: '/Theology/', name: '  Faith & Reason ', color: '#ABCDEF' },
      { folder: 'People', name: 'Faith & Reason' },
    ]);
    assert.deepEqual(
      saved.map((i) => [i.id, i.name, i.folder, i.color]),
      [
        ['faith-reason', 'Faith & Reason', 'Theology', '#abcdef'],
        ['faith-reason-2', 'Faith & Reason', 'People', '#6ee7a8'],
      ],
    );
    // The deepest matching folder wins.
    await vault.setIslands([{ folder: 'Theology' }, { folder: 'Theology/Church Fathers', name: 'Fathers' }]);
    const g = vault.graph();
    assert.equal(g.nodes.find((n) => n.id === 'Theology/Church Fathers/Augustine.md')?.island, 'fathers');
    assert.equal(g.nodes.find((n) => n.id === 'Theology/Grace.md')?.island, 'theology');

    await assert.rejects(vault.setIslands([{ folder: 'Theology' }, { folder: 'theology' }]), /already an island/);
    await assert.rejects(vault.setIslands([{ folder: '../outside' }]), /invalid folder/);
    await assert.rejects(vault.setIslands([{ name: 'No folder' }]), /needs a folder/);
    await assert.rejects(vault.setIslands('nope' as unknown as unknown[]), /must be a list/);
    assert.equal((await vault.setIslands([])).length, 0);
  } finally {
    vault.close();
  }
});
