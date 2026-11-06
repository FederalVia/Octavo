import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveKey,
  lockContent,
  unlockContent,
  keyForContent,
  isLocked,
  parseEnvelope,
  WrongPasswordError,
} from '../src/crypto.ts';

const PLAIN = '---\ntags: [private]\n---\n# Diary\nSecret plans 🚀 with [[Links]].\n';

test('round trip, fresh IV each time, wrong password rejected', async () => {
  const nk = await deriveKey('correct horse battery staple');
  const a = await lockContent(PLAIN, nk);
  const b = await lockContent(PLAIN, nk);
  assert.equal(isLocked(a), true);
  assert.equal(isLocked(PLAIN), false);
  assert.ok(!a.includes('Secret') && !a.includes('Diary') && !a.includes('private'), 'no plaintext leaks');
  assert.notEqual(parseEnvelope(a)!.iv, parseEnvelope(b)!.iv);
  assert.equal(parseEnvelope(a)!.iter, 600_000);
  assert.equal(await unlockContent(a, nk), PLAIN);

  const again = await keyForContent(a, 'correct horse battery staple');
  assert.equal(await unlockContent(b, again), PLAIN);
  await assert.rejects(keyForContent(a, 'wrong password'), WrongPasswordError);
});

test('tampering is detected', async () => {
  const nk = await deriveKey('pw');
  const locked = await lockContent('hello', nk);
  const env = parseEnvelope(locked)!;
  const bytes = Buffer.from(env.ct, 'base64');
  bytes[0] ^= 1;
  const tampered = locked.replace(env.ct, bytes.toString('base64'));
  await assert.rejects(unlockContent(tampered, nk), WrongPasswordError);
});
