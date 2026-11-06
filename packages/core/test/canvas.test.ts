import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault, validateCanvas, normalizeCanvasPath, NoteConflictError } from '../src/index.js';

test('validateCanvas keeps unknown fields, drops dangling edges, rejects bad nodes', () => {
  const d = validateCanvas({
    nodes: [
      { id: 'a', type: 'text', text: 'hi', x: 0, y: 0, width: 100, height: 50, custom: 1 },
      { id: 'b', type: 'file', file: 'Note.md', x: 200, y: 0, width: 100, height: 50 },
    ],
    edges: [
      { id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'sideways' },
      { id: 'e2', fromNode: 'a', toNode: 'gone' },
    ],
    extra: true,
  });
  assert.equal((d.nodes[0] as { custom?: number }).custom, 1);
  assert.equal(d.extra, true);
  assert.equal(d.edges.length, 1);
  assert.equal(d.edges[0].toSide, undefined); // invalid side removed
  assert.throws(() => validateCanvas({ nodes: [{ id: 'x', type: 'blob', x: 0, y: 0, width: 1, height: 1 }] }), /unknown type/);
  assert.throws(() => validateCanvas({ nodes: [{ id: 'x', type: 'text', text: '', x: 'a', y: 0, width: 1, height: 1 }] }), /numeric x/);
  assert.throws(() => validateCanvas([]), /object/);
  assert.equal(normalizeCanvasPath('Boards/Ideas'), 'Boards/Ideas.canvas');
  assert.throws(() => normalizeCanvasPath('../x'), /Invalid path/);
  assert.throws(() => normalizeCanvasPath('.hidden/x'), /Invalid path/);
});

test('canvases are listed, read, written with conflict checks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-canvas-'));
  await fs.writeFile(path.join(dir, 'Existing.canvas'), JSON.stringify({ nodes: [{ id: 'n', type: 'text', text: 'x', x: 0, y: 0, width: 10, height: 10 }], edges: [] }));
  const vault = await Vault.open(dir, { watch: false });
  try {
    assert.deepEqual(vault.canvases(), ['Existing.canvas']);
    const r = await vault.readCanvas('Existing');
    assert.equal(r.data.nodes.length, 1);
    const w = await vault.writeCanvas('Boards/New', { nodes: [], edges: [] }, { createOnly: true });
    assert.equal(w.path, 'Boards/New.canvas');
    assert.deepEqual(vault.canvases(), ['Boards/New.canvas', 'Existing.canvas']);
    assert.match(await fs.readFile(path.join(dir, 'Boards/New.canvas'), 'utf8'), /^\{\n\t"nodes": \[\],\n\t"edges": \[\]\n\}\n$/);
    await assert.rejects(vault.writeCanvas('Boards/New', { nodes: [], edges: [] }, { createOnly: true }), /exists/i);
    await assert.rejects(vault.writeCanvas('Existing', r.data, { expectedMtime: r.mtime - 5000 }), NoteConflictError);
    await vault.writeCanvas('Existing', r.data, { expectedMtime: r.mtime });
  } finally {
    vault.close();
  }
});
