import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runNoteCommand } from '../src/commands.js';

/** Run a note command and return what it printed. */
async function run(vault: string, command: string, args: string[], opts: Record<string, unknown> = {}): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    await runNoteCommand(vault, command, args, opts);
  } finally {
    console.log = log;
  }
  return lines.join('\n');
}

test('octavo islands: list, add, remove, errors, --json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-cli-islands-'));
  await fs.mkdir(path.join(dir, 'Theology'), { recursive: true });
  await fs.writeFile(path.join(dir, 'Theology', 'Grace.md'), '# Grace\n');
  await fs.writeFile(path.join(dir, 'Theology', 'Trinity.md'), '# Trinity\n');

  assert.match(await run(dir, 'islands', []), /Islands:\n {2}\(none\)/);
  assert.match(await run(dir, 'islands', ['add', 'Theology'], { title: 'Faith' }), /Faith {2}\(Theology\/, 2 notes, #ff6ad5\)/);
  const json = JSON.parse(await run(dir, 'islands', ['list'], { json: true }));
  assert.deepEqual(json, [{ id: 'faith', name: 'Faith', folder: 'Theology', color: '#ff6ad5' }]);
  await assert.rejects(run(dir, 'islands', ['add', 'Nowhere']), /No folder called "Nowhere"/);
  await assert.rejects(run(dir, 'islands', ['remove', 'nothing']), /No island called "nothing"/);
  assert.match(await run(dir, 'islands', ['remove', 'faith']), /\(none\)/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, '.octavo', 'islands.json'), 'utf8')), { islands: [] });
});
