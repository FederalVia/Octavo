import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Vault } from '@octavo/core';
import { buildSite, writeSite, zipFiles } from '../src/publish.js';

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-publish-'));
  const w = async (rel: string, text: string | Buffer) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  };
  await w('Home.md', '---\npublish: true\n---\n# Welcome\nSee [[Public Idea]] and [[Secret Plan]]. #garden\n');
  await w('Ideas/Public Idea.md', '---\npublish: true\ntags: [garden]\n---\nA public idea with ![[pic.png|200]] and ==highlight==.\n\n> [!tip] Hint\n> Inside a callout.\n\n- [x] done task\n\n```query\nLIST FROM #garden\n```\n\n<script>alert(1)</script><b onclick="x()">bold</b>\n');
  await w('Ideas/Secret Plan.md', 'Links back to [[Public Idea]].\n');
  await w('Ideas/Blocked.md', '---\npublish: false\n---\nNever.\n');
  await w('Templates/Daily.md', '# {{date}}\n');
  await w('attachments/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { dir, vault: await Vault.open(dir, { watch: false }) };
}

test('publishes only marked notes; private links become plain text', async () => {
  const { vault } = await setup();
  try {
    const site = await buildSite(vault, { title: 'My garden' });
    assert.equal(site.pages, 2);
    assert.deepEqual([...site.files.keys()].filter((k) => k.endsWith('.html')).sort(), ['ideas/public-idea.html', 'index.html', 'search.html', 'tags/garden.html']);
    const home = String(site.files.get('index.html'));
    assert.match(home, /<title>Welcome · My garden<\/title>/);
    assert.match(home, /<a class="internal" href="ideas\/public-idea\.html">Public Idea<\/a>/);
    assert.match(home, /<span class="unpublished">Secret Plan<\/span>/);
    assert.match(home, /href="tags\/garden\.html">#garden/);
    const idea = String(site.files.get('ideas/public-idea.html'));
    assert.match(idea, /<img src="\.\.\/assets\/attachments\/pic\.png" alt="" width="200"/);
    assert.ok(site.files.has('assets/attachments/pic.png'));
    assert.match(idea, /<mark class="hl-yellow">highlight<\/mark>/);
    assert.match(idea, /class="callout callout-tip"/);
    assert.match(idea, /<li class="task done">/);
    assert.match(idea, /<ul class="query"><li><a class="internal" href="\.\.\/index\.html">Home<\/a><\/li><li><a class="internal" href="public-idea\.html">Public Idea<\/a><\/li><\/ul>/);
    assert.doesNotMatch(idea, /<script>alert|onclick/);
    // Backlinks only from published notes: Home links here, Secret Plan doesn't count.
    assert.match(idea, /<h2>Linked from<\/h2><ul><li><a class="internal" href="\.\.\/index\.html">Home<\/a><\/li><\/ul>/);
    assert.doesNotMatch(JSON.stringify([...site.files.values()].map(String)), /Never\.|Secret Plan<\/a>/);
  } finally {
    vault.close();
  }
});

test('folder, tag and all scopes; templates and publish: false stay out', async () => {
  const { vault } = await setup();
  try {
    const names = async (o: Parameters<typeof buildSite>[1]) => (await buildSite(vault, o)).pages;
    assert.equal(await names({ folder: 'Ideas' }), 2); // Public Idea + Secret Plan, not Blocked
    assert.equal(await names({ tag: 'garden' }), 2);
    assert.equal(await names({ scope: 'all' }), 3); // not Blocked, not the template
  } finally {
    vault.close();
  }
});

test('writes a folder and a valid zip', async (t) => {
  const { vault } = await setup();
  try {
    const site = await buildSite(vault);
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-site-'));
    await writeSite(site, out);
    assert.match(await fs.readFile(path.join(out, 'ideas', 'public-idea.html'), 'utf8'), /A public idea/);
    const zip = zipFiles(site.files, 'site/');
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    const zipPath = path.join(out, 'site.zip');
    await fs.writeFile(zipPath, zip);
    try {
      const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
      assert.match(listing, /site\/ideas\/public-idea\.html/);
      execFileSync('unzip', ['-tq', zipPath]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') t.diagnostic('unzip not installed; skipped archive check');
      else throw err;
    }
  } finally {
    vault.close();
  }
});
