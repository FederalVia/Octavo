import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkedLookup, clipNote, privateAddress, readPage, type Resolver } from '../src/webread.js';

const PAGE = `<!doctype html><html><head><title>Fallback title</title>
<meta property="og:title" content="How octopuses think">
<meta property="og:site_name" content="Sea Notes"><meta name="author" content="Ada">
<meta name="description" content="Nine brains, one animal.">
<script>alert(1)</script><style>body{}</style></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<header class="site-header">Sea Notes</header>
<div class="layout"><aside class="sidebar">Popular posts</aside>
<article><h1>How octopuses think</h1>
<p>An octopus has a central brain and a cluster of neurons in each of its eight arms, so each arm can act on its own to a surprising degree.</p>
<p>Researchers have watched arms solve small problems while the animal's attention is elsewhere, which raises questions about where thinking happens.</p>
<img data-src="/img/arm.jpg" src="data:image/gif;base64,R0lGOD" alt="An arm">
<p>Read <a href="/more" onclick="track()">more about cephalopods</a> or the <a href="javascript:void(0)">weird link</a>.</p>
<div class="share-buttons">Share on everything</div>
<ul><li>Eight arms</li><li>Three hearts</li></ul>
</article></div>
<div id="comments">Comment spam</div>
<footer>© Sea Notes</footer></body></html>`;

test('reader mode keeps the article and drops the rest', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/old') {
      res.writeHead(301, { Location: '/post' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // Local addresses are refused unless a test says otherwise.
    await assert.rejects(readPage(`${base}/post`), /Local network addresses/);
    const page = await readPage(`${base}/old`, { allowPrivate: true });
    assert.equal(page.url, `${base}/post`); // followed the redirect
    assert.equal(page.title, 'How octopuses think');
    assert.equal(page.siteName, 'Sea Notes');
    assert.match(page.markdown, /^# How octopuses think\n\nAn octopus has a central brain/);
    assert.match(page.markdown, /!\[An arm\]\(http:\/\/127\.0\.0\.1:\d+\/img\/arm\.jpg\)/);
    assert.match(page.markdown, /\[more about cephalopods\]\(http:\/\/127\.0\.0\.1:\d+\/more\)/);
    assert.match(page.markdown, /- Eight arms\n- Three hearts/);
    for (const junk of ['Popular posts', 'Share on everything', 'Comment spam', '© Sea Notes', 'About', 'alert', 'onclick', 'javascript:']) {
      assert.ok(!page.markdown.includes(junk) && !page.html.includes(junk), `should drop ${junk}`);
    }
    const note = clipNote(page, new Date('2026-11-06T12:00:00Z'));
    assert.match(note, /^---\nsource: "http:\/\/127\.0\.0\.1:\d+\/post"\nclipped: 2026-11-06\nauthor: "Ada"\nsite: "Sea Notes"\ntags: \[clipping\]\n---\n# How octopuses think\n\n> Nine brains, one animal\.\n\n# How octopuses think/);
  } finally {
    server.close();
  }
});

test('refuses non-web and local addresses', async () => {
  await assert.rejects(readPage('file:///etc/passwd'), /Only http and https/);
  await assert.rejects(readPage('http://localhost:8080/'), /Local addresses/);
  await assert.rejects(readPage('http://10.0.0.1/'), /Local network/);
  await assert.rejects(readPage('http://[::1]/'), /Local network/);
  await assert.rejects(readPage('not a url'), /isn’t a web address/);
});

test('IPv4 hidden in IPv6 is refused (mapped, compatible, NAT64, 6to4)', async () => {
  // The URL parser rewrites [::ffff:127.0.0.1] as [::ffff:7f00:1]; both spellings must be refused.
  for (const url of [
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/',
  ]) {
    await assert.rejects(readPage(url), /Local network/, url);
  }
});

test('privateAddress: blocked ranges and public addresses', () => {
  const blocked = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fd00::1', 'ff02::1',
    '::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::ffff:a00:1', '::7f00:1', '64:ff9b::7f00:1', '2002:c0a8:101::1',
    'not an address',
  ];
  for (const ip of blocked) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '2002:808:808::']) {
    assert.equal(privateAddress(ip), false, ip);
  }
});

test('the connection uses exactly the address that was checked (no second DNS lookup)', async () => {
  const lookup = checkedLookup(async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1::1', family: 6 },
  ]);
  const call = (opts: object) =>
    new Promise<{ err: Error | null; address?: unknown; family?: number }>((resolve) =>
      lookup('example.test', opts, (err, address, family) => resolve({ err, address, family })),
    );
  assert.deepEqual(await call({}), { err: null, address: '93.184.216.34', family: 4 });
  assert.deepEqual((await call({ all: true })).address, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1::1', family: 6 },
  ]);
  assert.deepEqual(await call({ family: 6 }), { err: null, address: '2606:2800:220:1::1', family: 6 });
  // One private answer among public ones is enough to refuse the whole name.
  const mixed = checkedLookup(async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  const err = await new Promise<Error | null>((resolve) => mixed('rebind.test', {}, (e) => resolve(e)));
  assert.match(String(err?.message), /Local network/);
});

test('DNS rebinding: one lookup per connection, and redirects are checked at connect time too', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/hop') {
      res.writeHead(302, { Location: `http://inside.test:${(server.address() as AddressInfo).port}/` });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  // For this test 127.0.0.1 plays "the public internet"; everything else counts as private.
  const isPrivate = (ip: string) => ip !== '127.0.0.1';
  try {
    // A name that answers "public" first and "private" afterwards: the old code checked one answer and
    // let fetch resolve again. Now the single checked answer is the one connected to.
    let calls = 0;
    const flipping: Resolver = async () => (calls++ === 0 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.1', family: 4 }]);
    const page = await readPage(`http://flip.test:${port}/`, { resolve: flipping, isPrivate });
    assert.equal(page.title, 'How octopuses think');
    assert.equal(calls, 1, 'resolved exactly once for one connection');
    assert.equal(hits, 1);

    // A name that resolves to a private address is refused before any connection is made.
    hits = 0;
    const toPrivate: Resolver = async () => [{ address: '10.0.0.1', family: 4 }];
    await assert.rejects(readPage(`http://private.test:${port}/`, { resolve: toPrivate, isPrivate }), /Local network/);
    assert.equal(hits, 0, 'nothing was requested');

    // A redirect to a name that resolves privately is refused on the second hop.
    hits = 0;
    const byName: Resolver = async (host) => [{ address: host === 'inside.test' ? '10.0.0.1' : '127.0.0.1', family: 4 }];
    await assert.rejects(readPage(`http://outside.test:${port}/hop`, { resolve: byName, isPrivate }), /Local network/);
    assert.equal(hits, 1, 'only the first hop reached a server');
  } finally {
    server.close();
  }
});
