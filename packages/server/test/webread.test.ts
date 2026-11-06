import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { clipNote, readPage } from '../src/webread.js';

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
