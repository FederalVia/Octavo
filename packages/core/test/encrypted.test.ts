import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault, EncryptedNoteError, isEncryptedContent } from '../src/index.js';

const LOCKED = `---
octavo-encrypted: v1
---
# 🔒 Locked note

This note is encrypted. Unlock it in Octavo to read it. #secret [[Should Not Count]]

\`\`\`octavo-encrypted
{"v":1,"ct":"AAAA"}
\`\`\`
`;

describe('locked (encrypted) notes', () => {
  let dir: string;
  let vault: Vault;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-enc-'));
    await fs.writeFile(path.join(dir, 'Diary.md'), '# Diary\nMy secret plans. #private\n- [ ] hidden task\n');
    await fs.writeFile(path.join(dir, 'Other.md'), '# Other\nLinks to [[Diary]] and mentions Vault.\n');
    vault = await Vault.open(dir, { watch: false });
  });
  after(async () => {
    vault.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('detects the envelope', () => {
    assert.equal(isEncryptedContent(LOCKED), true);
    assert.equal(isEncryptedContent(LOCKED.replace('octavo-encrypted: v1', 'ultron-encrypted: v1')), true, 'legacy marker');
    assert.equal(isEncryptedContent('# plain'), false);
  });

  test('locking purges plain-text history and hides content from indexes', async () => {
    // Create a plain-text history snapshot first.
    await vault.write('Diary', '# Diary\nMy secret plans, v2. #private\n- [ ] hidden task\n');
    assert.equal((await vault.history('Diary')).length, 1);

    await vault.write('Diary', LOCKED);
    assert.equal(vault.isEncrypted('Diary'), true);
    assert.equal((await vault.history('Diary')).length, 0, 'plain-text history must be deleted on lock');
    assert.equal(vault.search('secret').length, 0);
    assert.equal(vault.search('Locked').length, 0);
    assert.equal(vault.tasks().length, 0);
    assert.deepEqual(vault.tags().map((t) => t.tag), []);
    const s = vault.list().find((n) => n.path === 'Diary.md')!;
    assert.equal(s.encrypted, true);
    assert.equal(vault.graph().nodes.find((n) => n.id === 'Diary.md')!.encrypted, true);
    // Placeholder links don't count; links *to* the locked note still do.
    assert.equal(vault.unresolvedLinks().length, 0);
    assert.deepEqual(vault.backlinks('Diary').map((b) => b.path), ['Other.md']);
  });

  test('plain-text edits are refused', async () => {
    await assert.rejects(vault.append('Diary', 'more'), EncryptedNoteError);
    await assert.rejects(vault.edit('Diary', 'AAAA', 'BBBB'), EncryptedNoteError);
    await assert.rejects(vault.setTask('Diary', 1), EncryptedNoteError);
  });

  test('re-encrypting keeps (encrypted) history; unlocking permanently works', async () => {
    await vault.write('Diary', LOCKED.replace('AAAA', 'BBBB'));
    const h = await vault.history('Diary');
    assert.equal(h.length, 1);
    assert.equal(isEncryptedContent(await vault.readVersion('Diary', h[0].id)), true);
    await vault.write('Diary', '# Diary\nback to plain\n');
    assert.equal(vault.isEncrypted('Diary'), false);
    assert.equal(vault.search('plain').length, 1);
  });
});
