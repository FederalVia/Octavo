import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskQuery, runTaskQuery, resolveDate } from '../src/taskQuery.ts';
import type { Task } from '../src/api.ts';

const now = new Date(2026, 10, 6);
const T = (text: string, status = ' ', path = 'A.md', due?: string): Task => ({ path, name: path.replace(/\.md$/, ''), line: 1, status, text, ...(due ? { due } : {}) });
const tasks = [
  T('Pay rent #home', ' ', 'Home.md', '2026-11-01'),
  T('Ship v1 #work', ' ', 'Projects/Octavo.md', '2026-11-10'),
  T('Plan trip', ' ', 'Home.md'),
  T('Old done #work', 'x', 'Projects/Octavo.md', '2026-10-01'),
];

test('dates', () => {
  assert.equal(resolveDate('today', now), '2026-11-06');
  assert.equal(resolveDate('in 7 days', now), '2026-11-13');
  assert.equal(resolveDate('2 weeks ago', now), '2026-10-23');
  assert.equal(resolveDate('someday', now), null);
});

test('filters, sorting, limit and errors', () => {
  const names = (src: string) => runTaskQuery(parseTaskQuery(src, now), tasks, now).map((t) => t.text);
  assert.deepEqual(names('not done\ndue before today'), ['Pay rent #home']);
  assert.deepEqual(names('not done\nhas due date\nsort by due'), ['Pay rent #home', 'Ship v1 #work']);
  assert.deepEqual(names('tag includes #work'), ['Ship v1 #work', 'Old done #work']);
  assert.deepEqual(names('done'), ['Old done #work']);
  assert.deepEqual(names('path includes projects\nnot done'), ['Ship v1 #work']);
  assert.deepEqual(names('no due date'), ['Plan trip']);
  assert.deepEqual(names('not done\nlimit 1'), ['Pay rent #home']);
  assert.deepEqual(names('// comment\ntext does not include rent\nnot done'), ['Ship v1 #work', 'Plan trip']);
  assert.deepEqual(parseTaskQuery('due before someday\nfoo', now).errors, ['Unknown date in “due before someday”', 'Not understood: “foo”']);
});
