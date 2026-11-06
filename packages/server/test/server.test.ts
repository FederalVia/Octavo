import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, seedIfEmpty, type RunningServer } from '../src/index.js';

const TOKEN = 'test-token';

describe('HTTP server', () => {
  let dir: string;
  let srv: RunningServer;
  const api = (p: string, init: RequestInit = {}) =>
    fetch(`${srv.url}${p}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    });

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultron-srv-'));
    srv = await startServer({ vaultPath: dir, port: 0, token: TOKEN, webDir: '/nonexistent' });
    await seedIfEmpty(srv.vault);
  });

  after(async () => {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('rejects requests without token', async () => {
    const res = await fetch(`${srv.url}/api/notes`);
    assert.equal(res.status, 401);
  });

  test('REST CRUD, search, graph', async () => {
    let res = await api('/api/notes');
    const list = await res.json();
    assert.ok(list.notes.some((n: { path: string }) => n.path === 'Home.md'));

    res = await api('/api/notes/Projects/Alpha.md', {
      method: 'PUT',
      body: JSON.stringify({ content: '# Alpha\nPart of [[Home]] #project' }),
    });
    assert.equal(res.status, 200);
    const saved = await res.json();

    res = await api('/api/notes/Projects/Alpha.md');
    const note = await res.json();
    assert.equal(note.links[0].path, 'Home.md');

    // Stale write -> 409
    res = await api('/api/notes/Projects/Alpha.md', {
      method: 'PUT',
      body: JSON.stringify({ content: 'x', expectedMtime: saved.mtime - 10000 }),
    });
    assert.equal(res.status, 409);

    res = await api('/api/search?q=alpha');
    assert.equal((await res.json()).results[0].path, 'Projects/Alpha.md');

    res = await api('/api/graph');
    const g = await res.json();
    assert.ok(g.links.some((l: { source: string; target: string }) => l.source === 'Projects/Alpha.md' && l.target === 'Home.md'));

    res = await api('/api/notes/../secret');
    assert.ok(res.status === 400 || res.status === 404);

    res = await api('/api/notes/Nope.md');
    assert.equal(res.status, 404);
  });

  test('MCP over streamable HTTP', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    try {
      assert.match(client.getInstructions() ?? '', /long-term memory/);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      for (const n of ['search_notes', 'read_note', 'write_note', 'append_to_note', 'log_to_journal', 'get_vault_overview']) {
        assert.ok(names.includes(n), `missing tool ${n}`);
      }

      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
      };

      let r = await call('write_note', { path: 'People/Ada', content: '# Ada\nLikes [[Ultron Mind]]. #person' });
      assert.equal(r.text, 'Created People/Ada.md');
      r = await call('append_to_note', { path: 'Ada', content: '- prefers dark mode', heading: 'Preferences' });
      assert.match(r.text, /Appended to People\/Ada.md/);
      r = await call('search_notes', { query: 'dark mode' });
      assert.match(r.text, /People\/Ada.md/);
      r = await call('read_note', { path: 'Ada' });
      assert.match(r.text, /## Preferences/);
      r = await call('log_to_journal', { entry: 'Met [[Ada]]' });
      assert.match(r.text, /Logged to Journal\//);
      r = await call('get_vault_overview', {});
      assert.match(r.text, /Home note \(Home.md\)/);
      r = await call('read_note', { path: 'Does not exist' });
      assert.equal(r.isError, true);
      r = await call('write_note', { path: '../escape', content: 'x' });
      assert.equal(r.isError, true);
    } finally {
      await client.close();
    }
  });
});

describe('loopback host guard', () => {
  test('rejects foreign Host header when no token', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultron-host-'));
    const srv = await startServer({ vaultPath: dir, port: 0, webDir: '/nonexistent' });
    try {
      const ok = await fetch(`${srv.url}/api/vault`);
      assert.equal(ok.status, 200);
      // fetch() refuses to override Host, so use a raw request.
      const status = await new Promise<number>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port: srv.port, path: '/api/vault', headers: { Host: 'evil.example.com' } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on('error', reject);
      });
      assert.equal(status, 403);
    } finally {
      await srv.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
