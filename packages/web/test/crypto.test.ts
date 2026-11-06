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

test('pure-JS fallback (plain-http pages) is interoperable with Web Crypto', async () => {
  const { _setForceFallback } = await import('../src/crypto.ts');
  const nk = await deriveKey('phone password');
  const fromWebCrypto = await lockContent(PLAIN, nk);
  _setForceFallback(true);
  try {
    const fallbackKey = await keyForContent(fromWebCrypto, 'phone password');
    assert.deepEqual([...fallbackKey.raw], [...nk.raw], 'same derived key');
    assert.equal(fallbackKey.ck, undefined);
    assert.equal(await unlockContent(fromWebCrypto, fallbackKey), PLAIN);
    const fromFallback = await lockContent(PLAIN + 'edited on phone', fallbackKey);
    await assert.rejects(keyForContent(fromFallback, 'wrong'), WrongPasswordError);
    _setForceFallback(false);
    assert.equal(await unlockContent(fromFallback, nk), PLAIN + 'edited on phone');
  } finally {
    _setForceFallback(false);
  }
});
