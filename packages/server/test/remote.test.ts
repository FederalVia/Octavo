import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import express from 'express';
import { classifyAddress } from '../src/remote/netcheck.js';
import { RemoteAccess, diagnose } from '../src/remote/remote.js';
import type { Router } from '../src/remote/router.js';

function fakeRouter(opts: { ip: string; refuse?: number[]; offer?: Record<number, number> }) {
  const mapped = new Map<number, number>();
  let ip = opts.ip;
  const r: Router & { mapped: Map<number, number>; setIp(v: string): void; stopped: boolean } = {
    label: 'test router',
    mapped,
    stopped: false,
    setIp: (v) => (ip = v),
    externalIp: async () => ip,
    async map(internal, external) {
      if (opts.refuse?.includes(external)) throw new Error(`port ${external} refused`);
      const got = opts.offer?.[external] ?? external;
      mapped.set(internal, got);
      return got;
    },
    async unmap(internal) {
      mapped.delete(internal);
    },
    async stop() {
      r.stopped = true;
    },
  };
  return r;
}

// Talk to local test servers directly, not through any HTTP proxy in the environment.
process.env.NO_PROXY = process.env.no_proxy = '*';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'octavo-remote-'));
const app = express().get('/hello', (_q, s) => s.send('hi'));

describe('address classification', () => {
  test('recognises CGNAT, double NAT and public addresses', () => {
    assert.equal(classifyAddress('100.72.1.9'), 'cgnat');
    assert.equal(classifyAddress('192.168.0.10'), 'private');
    assert.equal(classifyAddress('10.1.2.3'), 'private');
    assert.equal(classifyAddress('172.20.0.1'), 'private');
    assert.equal(classifyAddress('203.0.113.7'), 'public');
    assert.equal(classifyAddress('81.2.69.142'), 'public');
    assert.equal(classifyAddress('127.0.0.1'), 'invalid');
    assert.equal(classifyAddress('2001:db8::1'), 'public');
    assert.equal(classifyAddress('nonsense'), 'invalid');
  });
});

describe('remote access failure modes (no certificate needed)', () => {
  const base = async () => ({ app, stateDir: await tmp(), httpsPort: 0, challengePort: 0 });

  test('no router', async () => {
    const r = new RemoteAccess({ ...(await base()), findRouter: async () => null });
    const s = await r.start();
    assert.equal(s.state, 'error');
    assert.equal(s.problem, 'no-router');
    assert.match(s.advice!, /UPnP/);
    await r.stop();
  });

  test('refuses to open anything when the access key is not enforced', async () => {
    const router = fakeRouter({ ip: '203.0.113.7' });
    const r = new RemoteAccess({ ...(await base()), findRouter: async () => router, requireToken: async () => false });
    const s = await r.start();
    assert.equal(s.state, 'error');
    assert.match(s.advice!, /without an access key/);
    assert.equal(router.mapped.size, 0, 'no router ports opened');
    await r.stop();
  });

  test('CGNAT is detected and explained', async () => {
    const r = new RemoteAccess({ ...(await base()), findRouter: async () => fakeRouter({ ip: '100.80.3.4' }) });
    const s = await r.start();
    assert.equal(s.problem, 'cgnat');
    assert.match(s.advice!, /provider/);
    await r.stop();
  });

  test('double NAT', async () => {
    const r = new RemoteAccess({ ...(await base()), findRouter: async () => fakeRouter({ ip: '192.168.1.2' }) });
    assert.equal((await r.start()).problem, 'double-nat');
    await r.stop();
  });

  test('router refusing port 80', async () => {
    const router = fakeRouter({ ip: '203.0.113.7', refuse: [80] });
    const r = new RemoteAccess({ ...(await base()), findRouter: async () => router });
    assert.equal((await r.start()).problem, 'port-80');
    await r.stop();
    assert.equal(router.mapped.size, 0, 'ports closed again on stop');
    assert.equal(router.stopped, true);
  });

  test('HTTPS port falls back when 443 is refused', async () => {
    const router = fakeRouter({ ip: '203.0.113.7', refuse: [443] });
    const r = new RemoteAccess({
      app,
      stateDir: await tmp(),
      httpsPort: 47101,
      challengePort: 47102,
      findRouter: async () => router,
      directoryUrl: 'https://127.0.0.1:9/unreachable', // stop at the certificate step
      certificateTimeoutMs: 5000,
      networkRetries: 0,
    });
    try {
      const s = await r.start();
      assert.equal(s.problem, 'certificate');
      assert.equal(router.mapped.get(47102), 80);
      assert.equal(router.mapped.get(47101), 8443);
    } finally {
      await r.stop();
    }
    assert.equal(router.mapped.size, 0);
  });

  test('diagnose reports a usable network', async () => {
    const d = await diagnose({ findRouter: async () => fakeRouter({ ip: '203.0.113.7' }) });
    assert.equal(d.ok, true);
    assert.ok(d.lines.some((l) => l.includes('203.0.113.7')));
    const bad = await diagnose({ findRouter: async () => fakeRouter({ ip: '100.64.0.9' }) });
    assert.equal(bad.ok, false);
    assert.equal(bad.problem, 'cgnat');
  });
});

/**
 * Full certificate flow against Pebble (Let's Encrypt's test CA). Run with:
 *   PEBBLE_URL=https://localhost:14000/dir PEBBLE_IP=<this machine's address> \
 *   NODE_EXTRA_CA_CERTS=pebble.minica.pem npm test -w @octavo/server
 * Pebble must validate http-01 on port 5002 (its default "httpPort").
 */
const PEBBLE = process.env.PEBBLE_URL;
describe('remote access with a real ACME server (Pebble)', { skip: !PEBBLE && 'set PEBBLE_URL to run' }, () => {
  test('issues an IP certificate, serves HTTPS, renews, and follows address changes', async () => {
    const ip = process.env.PEBBLE_IP ?? '192.0.2.2';
    const router = fakeRouter({ ip });
    const stateDir = await tmp();
    const remote = new RemoteAccess({
      app,
      stateDir,
      httpsPort: 4443,
      challengePort: 5002,
      externalHttpsPorts: [4443],
      directoryUrl: PEBBLE!,
      findRouter: async () => router,
      log: () => {},
    });
    try {
      const s = await remote.start();
      assert.equal(s.state, 'ready', s.advice);
      assert.equal(s.url, `https://${ip}:4443`);
      assert.ok(s.certificateExpires! - Date.now() < 7 * 24 * 3600 * 1000, 'short-lived (≤ 6 days) certificate');

      // The certificate must verify against Pebble's root for the bare IP.
      const mgmt = (process.env.PEBBLE_URL ?? '').replace(':14000/dir', ':15000');
      const root = await (await fetch(`${mgmt}/roots/0`)).text();
      const get = () =>
        new Promise<{ body: string; serial: string }>((resolve, reject) => {
          https
            .get(`https://${ip}:4443/hello`, { ca: root, agent: false }, (res) => {
              let body = '';
              res.on('data', (c) => (body += c));
              res.on('end', () => resolve({ body, serial: (res.socket as import('node:tls').TLSSocket).getPeerCertificate().serialNumber }));
            })
            .on('error', reject);
        });
      const first = await get();
      assert.equal(first.body, 'hi');

      // Forced renewal swaps the certificate without restarting.
      assert.equal(await remote.checkRenewal(true), true);
      const second = await get();
      assert.notEqual(second.serial, first.serial);
      assert.equal(remote.current.state, 'ready', 'still ready after renewing');

      // Cached certificate is reused on restart (no new issuance needed).
      const saved = JSON.parse(await fs.readFile(path.join(stateDir, 'remote.json'), 'utf8'));
      assert.equal(saved.ip, ip);
      assert.ok(saved.accountKey && saved.certPem && saved.keyPem);

      // Address change to a shared (CGNAT) address is reported clearly.
      router.setIp('100.64.9.9');
      assert.equal(await remote.checkIp(), true);
      assert.equal(remote.current.problem, 'cgnat');
    } finally {
      await remote.stop();
    }
    assert.equal(router.mapped.size, 0);
  });
});
