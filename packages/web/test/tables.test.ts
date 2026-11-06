import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTable, formatTable, editTable, editTableInContent } from '../src/tables.ts';

const RAW = '| Name | Qty | Note |\n| :--- | ---: | --- |\n| Pear | 10 | `a|b` |\n| apple | 2 | x \\| y |\n| Fig |  | |';

test('parse keeps alignment, escaped pipes and code', () => {
  const t = parseTable(RAW)!;
  assert.deepEqual(t.header, ['Name', 'Qty', 'Note']);
  assert.deepEqual(t.align, ['left', 'right', null]);
  assert.deepEqual(t.rows[0], ['Pear', '10', '`a|b`']);
  assert.deepEqual(t.rows[1], ['apple', '2', 'x \\| y']);
  assert.deepEqual(t.rows[2], ['Fig', '', '']);
});

test('sort (numeric-aware, empty last), columns and rows', () => {
  const t = parseTable(RAW)!;
  assert.deepEqual(editTable(t, { type: 'sort', col: 0, desc: false }).rows.map((r) => r[0]), ['apple', 'Fig', 'Pear']);
  assert.deepEqual(editTable(t, { type: 'sort', col: 1, desc: false }).rows.map((r) => r[1]), ['2', '10', '']);
  assert.deepEqual(editTable(t, { type: 'sort', col: 1, desc: true }).rows.map((r) => r[1]), ['10', '2', '']);
  const ins = editTable(t, { type: 'insertCol', col: 0, side: 'right' });
  assert.deepEqual(ins.header, ['Name', 'Column', 'Qty', 'Note']);
  assert.deepEqual(ins.align, ['left', null, 'right', null]);
  assert.deepEqual(editTable(t, { type: 'moveCol', col: 1, by: -1 }).header, ['Qty', 'Name', 'Note']);
  assert.deepEqual(editTable(t, { type: 'deleteCol', col: 2 }).header, ['Name', 'Qty']);
  assert.equal(editTable(t, { type: 'insertRow', row: 0, side: 'below' }).rows[1].join(''), '');
  assert.deepEqual(editTable(t, { type: 'deleteRow', row: 0 }).rows.map((r) => r[0]), ['apple', 'Fig']);
  assert.deepEqual(editTable(t, { type: 'moveRow', row: 2, by: -1 }).rows.map((r) => r[0]), ['Pear', 'Fig', 'apple']);
});

test('format round-trips and edits in place', () => {
  const t = parseTable(RAW)!;
  assert.deepEqual(parseTable(formatTable(t)), t);
  assert.equal(formatTable(parseTable('|a|b|\n|-|:-:|\n|1|2|')!), '| a   |  b  |\n| --- | :-: |\n| 1   |  2  |');
  const content = `# Doc\n\n${RAW}\n\nAfter.\n`;
  const out = editTableInContent(content, RAW, { type: 'deleteRow', row: 0 })!;
  assert.match(out, /^# Doc\n\n\| Name /);
  assert.doesNotMatch(out, /Pear/);
  assert.match(out, /\n\nAfter\.\n$/);
  assert.equal(editTableInContent('no table', RAW, { type: 'deleteRow', row: 0 }), null);
});
