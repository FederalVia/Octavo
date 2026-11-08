import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '@octavo/core';
import { findNotes, renderNote, visibleLength } from '../src/tui.js';

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('renderNote: numbered links, headings, tasks, frontmatter, wrapping', () => {
  const r = renderNote('---\ntags: [a]\n---\n# Title\nSee [[Alpha]] and [[Beta|the second]], then [[Alpha]] again.\n- [ ] open\n- [x] done\n' + 'word '.repeat(30), 40);
  assert.deepEqual(r.links, ['Alpha', 'Beta']);
  const text = r.lines.map(plain);
  assert.equal(text[0], 'tags: [a]');
  assert.ok(text.includes('Title'));
  assert.ok(text.some((l) => l.includes('Alpha[1]') && l.includes('the second[2]')), text.join('\n'));
  assert.ok(text.some((l) => l.includes('Alpha[1] again') || l.startsWith('Alpha[1] again') || l.includes('[1] again')));
  assert.ok(text.includes('☐ open') && text.includes('☑ done'));
  assert.ok(r.lines.every((l) => visibleLength(l) <= 40), 'every line fits the width');
  // Embedded files are shown, not numbered as links; embedded notes are links.
  const e = renderNote('![[cover.png]] ![[Sketch.excalidraw]] ![[Other note]]', 80);
  assert.deepEqual(e.links, ['Other note']);
  assert.match(plain(e.lines[0]), /^\[image: cover\.png\] \[file: Sketch\.excalidraw\] Other note\[1\]$/);
});

test('findNotes: name matches first, then full-text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-tui-'));
  await fs.writeFile(path.join(dir, 'Grace.md'), 'A note about grace.\n');
  await fs.writeFile(path.join(dir, 'Amazing Grace.md'), 'A hymn.\n');
  await fs.writeFile(path.join(dir, 'Augustine.md'), 'Wrote much on grace and will.\n');
  const vault = await Vault.open(dir, { watch: false });
  try {
    assert.deepEqual(findNotes(vault, 'grace').map((n) => n.name), ['Grace', 'Amazing Grace', 'Augustine']);
    assert.equal(findNotes(vault, '').length, 3);
    assert.deepEqual(findNotes(vault, 'nothing here'), []);
  } finally {
    vault.close();
  }
});

test('renderNote: terminal control sequences in a note are not passed through', () => {
  // OSC 52 (write the clipboard), a title change, a raw CSI and a C1 CSI, as another device or Claude might write them.
  const evil = 'Hi\x1b]52;c;ZWNobyBwd25lZA==\x07 there\x1b]0;title\x07\x1b[2J\x9b31m\r\n# Head\x1b[5m\n\tindented';
  const r = renderNote(evil, 80);
  const joined = r.lines.join('\n');
  // Only the renderer's own SGR styling may remain.
  assert.equal(joined.replace(/\x1b\[[0-9;]*m/g, '').match(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/), null, JSON.stringify(joined));
  assert.ok(!joined.includes('\x1b]'));
  assert.ok(!joined.includes('\x1b[2J'));
  assert.ok(r.lines.map(plain).some((l) => l.includes('    indented')));
});
