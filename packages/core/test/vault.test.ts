import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault, parseNote, normalizeNotePath, NoteConflictError, EditMatchError } from '../src/index.js';

describe('parseNote', () => {
  test('extracts frontmatter, tags, links, headings', () => {
    const p = parseNote(
      [
        '---',
        'tags: [project, ai]',
        'aliases: [Ultron Mind]',
        '---',
        '# Title',
        'Links to [[Other Note]] and [[Folder/Deep#Section|alias]] and ![[Embed]].',
        'Also a [md link](Some%20Note.md#h) and #inline-tag and #nested/tag but not #123.',
        '```',
        '[[NotALink]] #notatag',
        '```',
        'Inline `[[AlsoNot]]` code.',
      ].join('\n'),
    );
    assert.deepEqual(p.tags, ['ai', 'inline-tag', 'nested/tag', 'project']);
    assert.deepEqual(p.aliases, ['Ultron Mind']);
    assert.deepEqual(
      p.links.map((l) => [l.target, l.heading, l.alias, l.embed, l.kind, l.line]),
      [
        ['Other Note', undefined, undefined, false, 'wiki', 6],
        ['Folder/Deep', 'Section', 'alias', false, 'wiki', 6],
        ['Embed', undefined, undefined, true, 'wiki', 6],
        ['Some Note', 'h', 'md link', false, 'markdown', 7],
      ],
    );
    assert.deepEqual(p.headings, [{ level: 1, text: 'Title', line: 5 }]);
  });
});

describe('normalizeNotePath', () => {
  test('adds .md and normalizes', () => {
    assert.equal(normalizeNotePath('Projects/Ultron'), 'Projects/Ultron.md');
    assert.equal(normalizeNotePath('./a//b.md'), 'a/b.md');
  });
  test('rejects escapes and hidden paths', () => {
    assert.throws(() => normalizeNotePath('../x'));
    assert.throws(() => normalizeNotePath('/etc/passwd'));
    assert.throws(() => normalizeNotePath('.git/config'));
    assert.throws(() => normalizeNotePath('a/../../x'));
  });
});

describe('Vault', () => {
  let dir: string;
  let vault: Vault;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultron-test-'));
    await fs.mkdir(path.join(dir, 'Projects'));
    await fs.writeFile(path.join(dir, 'Home.md'), '# Home\nSee [[Ultron]] and [[Missing]].\n#hub');
    await fs.writeFile(
      path.join(dir, 'Projects', 'Ultron.md'),
      '---\ntags: project\n---\n# Ultron\nLinks back to [[Home]]. Built with [[TypeScript]].\n',
    );
    await fs.writeFile(path.join(dir, 'TypeScript.md'), 'A language. #project\nSee [ultron](Projects/Ultron.md).');
    vault = await Vault.open(dir, { watch: false });
  });

  after(async () => {
    vault.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('indexes notes and resolves links by name', () => {
    assert.equal(vault.list().length, 3);
    assert.equal(vault.resolve('ultron'), 'Projects/Ultron.md');
    assert.equal(vault.resolve('Projects/Ultron.md'), 'Projects/Ultron.md');
    assert.equal(vault.resolve('Nope'), null);
  });

  test('backlinks include wiki and markdown links', () => {
    const bl = vault.backlinks('Ultron').map((b) => b.path);
    assert.deepEqual(bl, ['Home.md', 'TypeScript.md']);
  });

  test('read returns links with resolution', async () => {
    const d = await vault.read('Home');
    assert.deepEqual(
      d.links.map((l) => [l.target, l.path]),
      [
        ['Ultron', 'Projects/Ultron.md'],
        ['Missing', null],
      ],
    );
  });

  test('search ranks title matches and supports tag filters', () => {
    const r = vault.search('ultron');
    assert.equal(r[0].path, 'Projects/Ultron.md');
    const tagged = vault.search('tag:project').map((x) => x.path).sort();
    assert.deepEqual(tagged, ['Projects/Ultron.md', 'TypeScript.md']);
    assert.equal(vault.search('ultron zebra').length, 0);
  });

  test('graph includes unresolved nodes', () => {
    const g = vault.graph();
    assert.ok(g.nodes.some((n) => n.unresolved && n.name === 'Missing'));
    assert.ok(g.links.some((l) => l.source === 'Home.md' && l.target === 'Projects/Ultron.md'));
  });

  test('tags and related', () => {
    assert.deepEqual(vault.tags().find((t) => t.tag === 'project'), { tag: 'project', count: 2 });
    const rel = vault.related('Ultron').map((r) => r.path);
    assert.ok(rel.includes('Home.md'));
    assert.ok(rel.includes('TypeScript.md'));
  });

  test('write detects conflicts', async () => {
    const d = await vault.read('Home');
    await vault.write('Home', d.content + '\nmore', { expectedMtime: d.mtime });
    await assert.rejects(vault.write('Home', 'stale', { expectedMtime: d.mtime - 5000 }), NoteConflictError);
  });

  test('append under heading and edit', async () => {
    await vault.write('Scratch', '# Scratch\n\n## Ideas\n\n- one\n\n## Later\n\n- x\n');
    await vault.append('Scratch', '- two', { heading: 'Ideas' });
    let c = (await vault.read('Scratch')).content;
    assert.equal(c, '# Scratch\n\n## Ideas\n\n- one\n- two\n\n## Later\n\n- x\n');
    await vault.append('Scratch', '- new', { heading: 'Fresh' });
    c = (await vault.read('Scratch')).content;
    assert.ok(c.endsWith('## Fresh\n\n- new\n'));
    await vault.edit('Scratch', '- one', '- uno');
    assert.ok((await vault.read('Scratch')).content.includes('- uno'));
    await assert.rejects(vault.edit('Scratch', 'not there', 'x'), EditMatchError);
  });

  test('rename rewrites wiki and markdown links', async () => {
    const res = await vault.rename('Ultron', 'Archive/Ultron Mind');
    assert.equal(res.to, 'Archive/Ultron Mind.md');
    assert.equal(res.updatedLinks, 2);
    const home = (await vault.read('Home')).content;
    assert.ok(home.includes('[[Ultron Mind]]'), home);
    const ts = (await vault.read('TypeScript')).content;
    assert.ok(ts.includes('[ultron](Archive/Ultron%20Mind.md)'), ts);
    assert.deepEqual(
      vault.backlinks('Ultron Mind').map((b) => b.path),
      ['Home.md', 'TypeScript.md'],
    );
  });

  test('journal logging appends bullets', async () => {
    const date = new Date(2026, 0, 2, 9, 5);
    await vault.logToJournal('first', date);
    await vault.logToJournal('second', date);
    const d = await vault.read('Journal/2026-01-02.md');
    assert.equal(d.content, '# 2026-01-02\n\n- **09:05** first\n- **09:05** second\n');
  });

  test('delete moves to trash', async () => {
    const r = await vault.delete('Scratch');
    assert.equal(r.trashedTo, '.trash/Scratch.md');
    assert.equal(vault.resolve('Scratch'), null);
    await fs.access(path.join(dir, '.trash', 'Scratch.md'));
  });

  test('picks up external changes on rescan', async () => {
    await fs.writeFile(path.join(dir, 'External.md'), 'hello [[Home]]');
    await vault.rescan();
    assert.equal(vault.resolve('External'), 'External.md');
  });
});
