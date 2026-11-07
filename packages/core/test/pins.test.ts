import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../src/index.js';

test('hand-placed notes: set, near, loops refused, rename follows, graph carries them, saved to disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-pins-'));
  await fs.writeFile(path.join(dir, 'A.md'), '# A\n[[B]]\n');
  await fs.writeFile(path.join(dir, 'B.md'), '# B\n');
  await fs.writeFile(path.join(dir, 'C.md'), '# C\n');
  const vault = await Vault.open(dir, { watch: false });
  try {
    await vault.setPins({ A: { x: 0.5, y: -0.25 }, C: { near: 'B', dx: 0.1, dy: 0 } });
    assert.deepEqual(vault.pins(), { 'A.md': { x: 0.5, y: -0.25 }, 'C.md': { near: 'B.md', dx: 0.1, dy: 0 } });
    assert.deepEqual(vault.graph().pins, vault.pins());
    // Out-of-range values are clamped, nonsense refused.
    await vault.setPins({ A: { x: 99, y: 0 } });
    assert.deepEqual(vault.pins()['A.md'], { x: 3, y: 0 });
    await assert.rejects(vault.setPins({ A: { x: 'left' } as never }), /Give a spot/);
    await assert.rejects(vault.setPins({ B: { near: 'B', dx: 0, dy: 0 } }), /next to itself/);
    await assert.rejects(vault.setPins({ B: { near: 'C', dx: 0, dy: 0 } }), /already placed next to/);
    await assert.rejects(vault.setPins({ Missing: { x: 0, y: 0 } }));
    // Renaming a note keeps its placement, and placements next to it.
    await vault.rename('B', 'Folder/B2.md');
    assert.deepEqual(vault.pins()['C.md'], { near: 'Folder/B2.md', dx: 0.1, dy: 0 });
    // Unpin one, then saved file reloads in a fresh vault.
    await vault.setPins({ A: null });
    assert.equal(vault.pins()['A.md'], undefined);
    const again = await Vault.open(dir, { watch: false });
    assert.deepEqual(again.pins(), vault.pins());
    again.close();
    await vault.clearPins();
    assert.deepEqual(vault.pins(), {});
  } finally {
    vault.close();
  }
});
