import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault, parseNoteQuery, formatQueryResult } from '../src/index.js';

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-query-'));
  const w = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  };
  await w('Projects/Octavo.md', '---\nstatus: active\ndue: 2026-12-01\npriority: 1\ntags: [project]\n---\nLinks [[Ada]].\n');
  await w('Projects/Garden.md', '---\nstatus: done\ndue: 2026-10-01\npriority: 3\ntags: [project, outdoors]\n---\n');
  await w('Projects/Old/Shed.md', '---\nStatus: paused\ntags: [project]\n---\nSee [[Octavo]].\n');
  await w('People/Ada.md', '#person\nrole:: mathematician\nborn:: 1815\n\nWorks on [[Octavo]].\n');
  await w('Home.md', '# Home\n[[Octavo]] [[Garden]]\n');
  return { dir, vault: await Vault.open(dir, { watch: false }) };
}

test('Dataview-style TABLE with FROM, WHERE, SORT and LIMIT', async () => {
  const { vault } = await setup();
  try {
    const r = vault.query('TABLE status, due AS "Due" FROM "Projects" WHERE status != "done" SORT due DESC');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.columns, [{ label: 'status', property: 'status' }, { label: 'Due', property: 'due' }]);
    // Shed has no due date: empty values sort last; "Status" matches "status" case-insensitively.
    assert.deepEqual(r.rows.map((x) => [x.name, ...x.values]), [
      ['Octavo', 'active', '2026-12-01'],
      ['Shed', 'paused', null],
    ]);
    const lim = vault.query('LIST FROM #project SORT priority ASC LIMIT 1');
    assert.equal(lim.total, 3);
    assert.deepEqual(lim.rows.map((x) => x.name), ['Octavo']);
  } finally {
    vault.close();
  }
});

test('sources: folders include subfolders; tags, links, and/or/not', async () => {
  const { vault } = await setup();
  try {
    const names = (q: string, thisPath?: string) => vault.query(q, { thisPath }).rows.map((r) => r.name).sort();
    assert.deepEqual(names('LIST FROM "Projects"'), ['Garden', 'Octavo', 'Shed']);
    assert.deepEqual(names('LIST FROM "Projects" AND NOT "Projects/Old"'), ['Garden', 'Octavo']);
    assert.deepEqual(names('LIST FROM #outdoors OR #person'), ['Ada', 'Garden']);
    assert.deepEqual(names('LIST FROM [[Octavo]]'), ['Ada', 'Home', 'Shed']);
    // [[]] is the note the query is written in.
    assert.deepEqual(names('LIST FROM [[]]', 'Projects/Octavo.md'), ['Ada', 'Home', 'Shed']);
  } finally {
    vault.close();
  }
});

test('inline fields, file fields, functions and dates', async () => {
  const { vault } = await setup();
  try {
    const ada = vault.query('TABLE role, born + 0 AS n, file.folder, file.inlinks WHERE role');
    assert.deepEqual(ada.rows.map((r) => [r.name, ...r.values]), [['Ada', 'mathematician', 1815, 'People', 1]]);
    assert.deepEqual(
      vault.query('LIST WHERE contains(file.tags, "outdoors")').rows.map((r) => r.name),
      ['Garden'],
    );
    assert.deepEqual(
      vault.query('LIST FROM #project WHERE due < 2026-11-01').rows.map((r) => r.name),
      ['Garden'],
    );
    const shifted = vault.query('TABLE WITHOUT ID due + dur(7 days) FROM "Projects" WHERE due SORT due');
    assert.deepEqual(shifted.rows.map((r) => r.values[0]), ['2026-10-08', '2026-12-08']);
    assert.equal(shifted.showName, false);
    assert.match(vault.query('LIST WHERE nosuch(1)').errors[0], /Unknown function/);
  } finally {
    vault.close();
  }
});

test('YAML base blocks and GROUP BY', async () => {
  const { vault } = await setup();
  try {
    const r = vault.query('folder: Projects\nwhere:\n  - status\n  - priority < 3\ncolumns: [status, priority]\nview: cards');
    assert.deepEqual(r.errors, []);
    assert.equal(r.view, 'cards');
    assert.deepEqual(r.rows.map((x) => x.name), ['Octavo']);
    const g = vault.query('TABLE status FROM #project GROUP BY status');
    assert.equal(g.grouped, true);
    assert.deepEqual(g.rows.map((x) => [x.group, x.name]), [['active', 'Octavo'], ['done', 'Garden'], ['paused', 'Shed']]);
    assert.match(formatQueryResult(g), /## active/);
    assert.ok(parseNoteQuery('from: "Projects"').from);
    assert.ok(parseNoteQuery('TABLE x FROM').errors.length);
  } finally {
    vault.close();
  }
});

test('setProperty keeps the key spelling and removes with null', async () => {
  const { vault } = await setup();
  try {
    await vault.setProperty('Shed', 'status', 'active');
    const c = (await vault.read('Shed')).content;
    assert.match(c, /^---\nStatus: active\n/);
    await vault.setProperty('Shed', 'status', null);
    assert.doesNotMatch((await vault.read('Shed')).content, /Status/);
    await vault.setProperty('Home', 'rating', 5);
    assert.match((await vault.read('Home')).content, /^---\nrating: 5\n---\n# Home/);
    assert.deepEqual(vault.query('TABLE rating WHERE rating >= 5').rows.map((r) => r.name), ['Home']);
  } finally {
    vault.close();
  }
});
