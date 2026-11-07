import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../src/index.js';

test('graph nodes carry a creation time from frontmatter, else ctime; ghosts get none', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-created-'));
  try {
    await fs.writeFile(path.join(dir, 'A.md'), '---\ncreated: 2021-03-04\n---\nSee [[Ghost]] and [[B]].\n');
    await fs.writeFile(path.join(dir, 'B.md'), '---\ndate: "2019-12-31T10:00:00Z"\n---\nB\n');
    await fs.writeFile(path.join(dir, 'C.md'), '---\ncreated: not a date\n---\nC\n');
    const vault = await Vault.open(dir, { watch: false });
    const byId = new Map(vault.graph().nodes.map((n) => [n.id, n]));
    assert.equal(byId.get('A.md')!.created, Date.UTC(2021, 2, 4));
    assert.equal(byId.get('B.md')!.created, Date.UTC(2019, 11, 31, 10));
    const ctime = vault.list().find((n) => n.path === 'C.md')!.ctime;
    assert.equal(byId.get('C.md')!.created, ctime);
    assert.equal(byId.get('unresolved:ghost')!.created, undefined);
    vault.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
