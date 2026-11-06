import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '@octavo/core';
import { importNotion, importEnex } from '../src/importers.js';

const ID = '0123456789abcdef0123456789abcdef';
const ID2 = 'fedcba9876543210fedcba9876543210';

test('Notion export: IDs removed from names, links rewritten', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-notion-'));
  const src = path.join(tmp, 'export');
  const vaultDir = path.join(tmp, 'vault');
  await fs.mkdir(path.join(src, `Projects ${ID}`), { recursive: true });
  await fs.mkdir(vaultDir);
  await fs.writeFile(path.join(src, `Projects ${ID}.md`), `# Projects\n\n[Alpha](Projects%20${ID}/Alpha%20${ID2}.md) and [web](https://example.com)\n`);
  await fs.writeFile(path.join(src, `Projects ${ID}`, `Alpha ${ID2}.md`), `# Alpha\n\n![diagram](Alpha%20${ID2}/pic.png) back to [Projects](../Projects%20${ID}.md#top)\n`);
  await fs.mkdir(path.join(src, `Projects ${ID}`, `Alpha ${ID2}`));
  await fs.writeFile(path.join(src, `Projects ${ID}`, `Alpha ${ID2}`, 'pic.png'), Buffer.from([137, 80, 78, 71]));
  const vault = await Vault.open(vaultDir, { watch: false });
  try {
    const r = await importNotion(vault, src);
    assert.deepEqual([r.notes, r.attachments, r.folder], [2, 1, 'Imported/Notion']);
    const top = (await vault.read('Imported/Notion/Projects.md')).content;
    assert.match(top, /\[Alpha\]\(Projects\/Alpha\.md\)/);
    assert.match(top, /\[web\]\(https:\/\/example\.com\)/);
    const alpha = await vault.read('Imported/Notion/Projects/Alpha.md');
    assert.match(alpha.content, /!\[diagram\]\(Alpha\/pic\.png\)/);
    assert.match(alpha.content, /\[Projects\]\(\.\.\/Projects\.md#top\)/);
    assert.equal(alpha.links.find((l) => l.target.includes('Projects'))?.path, 'Imported/Notion/Projects.md');
  } finally {
    await vault.close?.();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('Evernote .enex: Markdown, tags, dates, checkboxes and images', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-enex-'));
  const vaultDir = path.join(tmp, 'vault');
  await fs.mkdir(vaultDir);
  const png = Buffer.from([137, 80, 78, 71, 13, 10]);
  const hash = crypto.createHash('md5').update(png).digest('hex');
  const enex = `<?xml version="1.0" encoding="UTF-8"?>
<en-export><note><title>Trip &amp; Plans</title>
<content><![CDATA[<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><h2>Packing</h2><div><en-todo checked="true"/>Passport</div><div><en-todo/>Charger</div><p>See <b>this</b> <a href="https://example.com">site</a>.</p><en-media hash="${hash}" type="image/png"/></en-note>]]></content>
<created>20261106T153000Z</created><updated>20261107T080000Z</updated><tag>travel</tag><tag>summer plans</tag>
<resource><data encoding="base64">${png.toString('base64')}</data><mime>image/png</mime><resource-attributes><file-name>map.png</file-name></resource-attributes></resource>
</note></en-export>`;
  const file = path.join(tmp, 'notes.enex');
  await fs.writeFile(file, enex);
  const vault = await Vault.open(vaultDir, { watch: false });
  try {
    const r = await importEnex(vault, file);
    assert.deepEqual([r.notes, r.attachments, r.skipped], [1, 1, []]);
    const note = await vault.read('Imported/Evernote/Trip & Plans.md');
    assert.match(note.content, /^---\ntags: \["travel", "summer-plans"\]\ncreated: 2026-11-06T15:30:00Z\nupdated: 2026-11-07T08:00:00Z\n---\n# Trip & Plans/);
    assert.match(note.content, /## Packing/);
    assert.match(note.content, /- \[x\] Passport/);
    assert.match(note.content, /- \[ \] Charger/);
    assert.match(note.content, /See \*\*this\*\* \[site\]\(https:\/\/example\.com\)\./);
    assert.match(note.content, /!\[\[map\.png\]\]/);
    assert.deepEqual(note.tags.sort(), ['summer-plans', 'travel']);
    assert.ok(await fs.stat(path.join(vaultDir, 'Imported/Evernote/attachments/map.png')));
  } finally {
    await vault.close?.();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
