import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateToken, phoneUrl, lanAddresses, qrDataUrl } from '../src/phone.js';

test('phone access key is created once, kept private, and reused', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-phone-'));
  const file = path.join(dir, 'nested', 'phone-token');
  const a = loadOrCreateToken(file);
  const b = loadOrCreateToken(file);
  assert.equal(a, b);
  assert.ok(a.length >= 32);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(phoneUrl('192.168.1.5', 4321, a), `http://192.168.1.5:4321/?token=${a}`);
  assert.ok(Array.isArray(lanAddresses()));
  assert.match(await qrDataUrl('http://x'), /^data:image\/png;base64,/);
  await fs.rm(dir, { recursive: true, force: true });
});

import { VERSION } from '../src/version.js';
import { readFileSync } from 'node:fs';
test('VERSION matches package.json', () => {
  assert.equal(VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});
