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
