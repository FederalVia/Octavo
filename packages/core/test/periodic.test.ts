import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault, isoWeek } from '../src/index.js';

test('ISO week numbers, including year boundaries', () => {
  const w = (y: number, m: number, d: number) => {
    const r = isoWeek(new Date(y, m - 1, d));
    return `${r.year}-W${r.week}`;
  };
  assert.equal(w(2026, 11, 6), '2026-W45');
  assert.equal(w(2026, 1, 1), '2026-W1'); // Thursday
  assert.equal(w(2027, 1, 1), '2026-W53'); // Friday: still the last week of 2026
  assert.equal(w(2024, 12, 30), '2025-W1'); // Monday: first week of 2025
  assert.equal(w(2021, 1, 3), '2020-W53'); // Sunday
});

test('daily, weekly and monthly notes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-periodic-'));
  const vault = await Vault.open(dir, { watch: false });
  try {
    const date = new Date(2026, 10, 6); // Friday 6 November 2026
    assert.equal(vault.periodicNotePath('day', date), 'Journal/2026-11-06.md');
    assert.equal(vault.periodicNotePath('week', date), 'Journal/Weekly/2026-W45.md');
    assert.equal(vault.periodicNotePath('month', date), 'Journal/Monthly/2026-11.md');

    const week = await vault.ensurePeriodicNote('week', date);
    const content = (await vault.read(week.path)).content;
    assert.match(content, /^# Week 45, 2026/);
    assert.match(content, /2026-11-02 to 2026-11-08/);
    assert.match(content, /\[\[2026-11-02\]\][\s\S]*\[\[2026-11-08\]\]/);

    const month = await vault.ensurePeriodicNote('month', date);
    assert.match((await vault.read(month.path)).content, /^# November 2026/);

    // Existing notes are returned, not overwritten.
    await vault.write(week.path, '# Mine');
    await vault.ensurePeriodicNote('week', date);
    assert.equal((await vault.read(week.path)).content, '# Mine');
  } finally {
    await vault.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('task due dates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-due-'));
  const vault = await Vault.open(dir, { watch: false });
  try {
    await vault.write(
      'Todo.md',
      ['- [ ] Pay rent 📅 2026-12-01', '- [ ] Call Ada due: 2026-11-10', '- [ ] Dataview style [due:: 2026-11-12]', '- [ ] No date', '- [x] Done 📅 2026-01-01'].join('\n'),
    );
    const t = vault.tasks();
    assert.deepEqual(
      t.map((x) => x.due),
      ['2026-12-01', '2026-11-10', '2026-11-12', undefined],
    );
    assert.equal(vault.tasks({ includeDone: true })[4].due, '2026-01-01');
  } finally {
    await vault.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('merge notes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-merge-'));
  const vault = await Vault.open(dir, { watch: false });
  try {
    await vault.write('Ideas/Old.md', '---\naliases: [Legacy]\n---\n# Old idea\nSome text. See [[Old]].\n');
    await vault.write('Ideas/New.md', '# New idea\nBody.\n');
    await vault.write('Other.md', 'Links: [[Old]], [[Old#Section|sec]], [[Legacy]], [md](Ideas/Old.md) and [[New]].\n');
    const r = await vault.merge('Old', 'New');
    assert.equal(r.from, 'Ideas/Old.md');
    assert.equal(r.into, 'Ideas/New.md');
    assert.match(r.trashedTo, /^\.trash\//);
    assert.equal(vault.resolve('Old'), null);
    const merged = (await vault.read('New')).content;
    assert.equal(merged, '# New idea\nBody.\n\n## Old idea\nSome text. See [[New]].\n');
    const other = (await vault.read('Other')).content;
    assert.equal(other, 'Links: [[New]], [[New#Section|sec]], [[New]], [md](Ideas/New.md) and [[New]].\n');
    await assert.rejects(vault.merge('New', 'New'));
  } finally {
    await vault.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('brain regions: reasons, pinning and random notes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-region-'));
  const vault = await Vault.open(dir, { watch: false });
  try {
    await vault.write('Projects/Alpha.md', '# Alpha\n');
    await vault.write('Loose idea.md', '# Idea #person\n');
    await vault.write('Home.md', '# Home\n');
    assert.deepEqual(vault.regionOf('Alpha'), { region: 'frontal', label: 'Frontal', reason: 'in the “Projects” folder' });
    assert.equal(vault.regionOf('Loose idea').region, 'temporal');
    assert.equal(vault.regionOf('Home').reason, 'a home/index note');

    await vault.setRegion('Alpha', 'occipital');
    assert.match((await vault.read('Alpha')).content, /^---\nregion: occipital\n---\n# Alpha/);
    assert.equal(vault.regionOf('Alpha').region, 'occipital');
    await vault.setRegion('Alpha', null);
    assert.equal((await vault.read('Alpha')).content, '# Alpha\n');

    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(vault.randomNote()!.path);
    assert.equal(seen.size, 3);
    assert.equal(vault.randomNote({ region: 'stem' })!.path, 'Home.md');
    assert.equal(vault.randomNote({ folder: 'Nope' }), null);

    const events: unknown[] = [];
    vault.on('event', (e) => events.push(e));
    vault.noteAccessed('Alpha');
    assert.deepEqual(events, [{ type: 'access', path: 'Projects/Alpha.md' }]);
  } finally {
    await vault.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('related: direct links first; hubs and journal notes do not dominate', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-related-'));
  const vault = await Vault.open(dir, { watch: false });
  try {
    // A hub linked from everything, and a journal note that mentions everything written that day.
    const topics = Array.from({ length: 14 }, (_, i) => `Topic ${i}`);
    for (const t of topics) await vault.write(`Concepts/${t}.md`, `# ${t}\nSee [[Home]].`);
    await vault.write('Home.md', `# Home\n${topics.map((t) => `[[${t}]]`).join(' ')}\n[[Fermi paradox]]`);
    await vault.write('Journal/2026-11-06.md', `# Today\n${topics.map((t) => `[[${t}]]`).join(' ')} [[Fermi paradox]]`);
    await vault.write('Concepts/Fermi paradox.md', '# Fermi\nRelated: [[Drake equation]] and [[Great filter]].');
    await vault.write('Concepts/Drake equation.md', '# Drake\nSee [[Great filter]].');
    await vault.write('Concepts/Great filter.md', '# Filter');
    const rel = vault.related('Fermi paradox');
    const names = rel.map((r) => r.name);
    // The two notes it links to directly outrank Home and the journal day.
    assert.ok(names.indexOf('Drake equation') < names.indexOf('Home'), names.join(', '));
    assert.ok(names.indexOf('Great filter') < names.indexOf('Home'), names.join(', '));
    // Topics reached only through Home or the journal barely register.
    const topic = rel.find((r) => r.name.startsWith('Topic'));
    assert.ok(!topic || topic.score < 1, `topic score ${topic?.score}`);
  } finally {
    await vault.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('moving a note does not touch notes whose links read the same; identical saves are no-ops', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-move-'));
  const vault = await Vault.open(dir, { watch: false });
  try {
    await vault.write('Ideas/Fermi.md', '# Fermi');
    await vault.write('A.md', 'See [[Fermi]].');
    await vault.write('B.md', 'See [md](Ideas/Fermi.md).');
    const before = (p: string) => vault.list().find((n) => n.path === p)!.mtime;
    const aTime = before('A.md');
    await new Promise((r) => setTimeout(r, 30));
    const r = await vault.rename('Ideas/Fermi', 'Physics/Fermi.md');
    assert.deepEqual(r.updatedNotes, ['B.md']); // the Markdown link's path changed; the [[name]] link did not
    assert.equal(before('A.md'), aTime, 'A.md untouched');
    assert.equal((await vault.read('B')).content, 'See [md](Physics/Fermi.md).');

    // Saving the same text again: no new version, same mtime.
    const t = before('A.md');
    await vault.write('A.md', 'See [[Fermi]].');
    assert.equal(before('A.md'), t);
    assert.equal((await vault.history('A.md')).length, 0);
  } finally {
    await vault.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('trash: find a deleted note by name and restore it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-trash-'));
  const vault = await Vault.open(dir, { watch: false });
  try {
    await vault.write('Notes/Test.md', '# Test\nimportant');
    await vault.delete('Test');
    assert.equal(vault.resolve('Test'), null);
    const t = await vault.findInTrash('Test');
    assert.deepEqual(t, { trashPath: '.trash/Notes/Test.md', originalPath: 'Notes/Test.md' });
    const s = await vault.restore(t!.trashPath);
    assert.equal(s.path, 'Notes/Test.md');
    assert.equal((await vault.read('Test')).content, '# Test\nimportant');
    assert.equal(await vault.findInTrash('Test'), null);
    await assert.rejects(vault.restore('../outside.md'));
  } finally {
    await vault.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('append keeps a closing #tags line or "Back to" footer at the end', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-append-'));
  const vault = await Vault.open(dir, { watch: false });
  try {
    await vault.write('A.md', '# A\n\nIntro.\n\n## Notes\n\n- one\n\n#physics #idea\n');
    await vault.append('A', '- two', { heading: 'Notes' });
    assert.equal((await vault.read('A')).content, '# A\n\nIntro.\n\n## Notes\n\n- one\n- two\n\n#physics #idea\n');
    await vault.append('A', 'A new paragraph.');
    assert.equal((await vault.read('A')).content, '# A\n\nIntro.\n\n## Notes\n\n- one\n- two\n\nA new paragraph.\n\n#physics #idea\n');
    await vault.append('A', 'Fresh section text.', { heading: 'Later' });
    assert.match((await vault.read('A')).content, /A new paragraph\.\n\n## Later\n\nFresh section text\.\n\n#physics #idea\n$/);

    await vault.write('B.md', '# B\n\nBody.\n\n---\nBack to [[Home]]\n');
    await vault.append('B', 'More body.');
    assert.equal((await vault.read('B')).content, '# B\n\nBody.\n\nMore body.\n\n---\nBack to [[Home]]\n');

    // Notes without a footer behave as before; a note that is only tags isn't treated as a footer.
    await vault.write('C.md', '#just #tags');
    await vault.append('C', 'text');
    assert.equal((await vault.read('C')).content, '#just #tags\n\ntext\n');
  } finally {
    await vault.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a Journal.md index gets a link to each new journal note', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-jindex-'));
  const vault = await Vault.open(dir, { watch: false });
  try {
    await vault.write('Journal.md', '# Journal\n');
    await vault.ensurePeriodicNote('day', new Date(2026, 10, 6));
    await vault.ensurePeriodicNote('day', new Date(2026, 10, 6)); // existing: no duplicate
    await vault.logToJournal('hello', new Date(2026, 10, 7));
    await vault.ensurePeriodicNote('week', new Date(2026, 10, 6));
    assert.equal((await vault.read('Journal')).content, '# Journal\n\n- [[2026-11-06]]\n- [[2026-11-07]]\n- [[2026-W45]]\n');
  } finally {
    await vault.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
