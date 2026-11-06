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
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-srv-'));
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

  test('locks out an address after repeated wrong keys', async () => {
    const lockSrv = await startServer({ vaultPath: dir, port: 0, token: 'right-key', webDir: '/nonexistent' });
    try {
      for (let i = 0; i < 10; i++) {
        const r = await fetch(`${lockSrv.url}/api/vault`, { headers: { Authorization: 'Bearer wrong' } });
        assert.equal(r.status, 401);
      }
      const blocked = await fetch(`${lockSrv.url}/api/vault`, { headers: { Authorization: 'Bearer right-key' } });
      assert.equal(blocked.status, 429, 'even the right key is refused while locked out');
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    } finally {
      await lockSrv.close();
    }
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

  test('attachments, tasks, insights, history, config', async () => {
    // Upload + fetch by bare name
    let res = await fetch(`${srv.url}/api/attachments?name=${encodeURIComponent('my pic.png')}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'image/png' },
      body: new Uint8Array([137, 80, 78, 71]),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).path, 'attachments/my pic.png');
    res = await api(`/api/files/${encodeURIComponent('my pic.png')}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal((await res.arrayBuffer()).byteLength, 4);
    res = await api('/api/files/missing.png');
    assert.equal(res.status, 404);

    // Tasks
    await api('/api/notes/Todo.md', { method: 'PUT', body: JSON.stringify({ content: '# Todo\n- [ ] one\n- [ ] two\n' }) });
    res = await api('/api/tasks');
    const tasks = (await res.json()).tasks.filter((t: { path: string }) => t.path === 'Todo.md');
    assert.equal(tasks.length, 2);
    res = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ path: 'Todo.md', line: 2 }) });
    assert.equal(res.status, 200);
    res = await api('/api/notes/Todo.md');
    assert.match((await res.json()).content, /- \[x\] one/);

    // Insights + mentions
    res = await api('/api/insights');
    const ins = await res.json();
    assert.ok(Array.isArray(ins.orphans) && Array.isArray(ins.deadEnds));
    res = await api('/api/mentions/Todo.md');
    assert.ok(Array.isArray((await res.json()).mentions));

    // History (first overwrite creates a snapshot)
    res = await api('/api/history/Todo.md');
    const versions = (await res.json()).versions;
    assert.equal(versions.length, 1);
    res = await api(`/api/history/Todo.md?id=${versions[0].id}`);
    assert.match((await res.json()).content, /- \[ \] one/);

    // Config (whitelisted names only)
    res = await api('/api/config/bookmarks', { method: 'PUT', body: JSON.stringify({ value: [{ type: 'note', path: 'Todo.md' }] }) });
    assert.equal(res.status, 200);
    res = await api('/api/config/bookmarks');
    assert.deepEqual((await res.json()).value, [{ type: 'note', path: 'Todo.md' }]);
    res = await api('/api/config/secrets');
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
      for (const n of ['search_notes', 'read_note', 'write_note', 'append_to_note', 'log_to_journal', 'get_vault_overview', 'list_tasks', 'update_task']) {
        assert.ok(names.includes(n), `missing tool ${n}`);
      }

      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
      };

      let r = await call('write_note', { path: 'People/Ada', content: '# Ada\nLikes [[Octavo]]. #person' });
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

      // Locked notes: existence visible, contents not; no overwrite/delete/append.
      await srv.vault.write('Secret.md', '---\noctavo-encrypted: v1\n---\n# Locked\n\n```octavo-encrypted\n{}\n```\n');
      r = await call('read_note', { path: 'Secret' });
      assert.match(r.text, /locked \(encrypted\) note/);
      assert.doesNotMatch(r.text, /octavo-encrypted/);
      r = await call('write_note', { path: 'Secret', content: 'overwritten' });
      assert.equal(r.isError, true);
      r = await call('append_to_note', { path: 'Secret', content: 'x' });
      assert.equal(r.isError, true);
      r = await call('delete_note', { path: 'Secret' });
      assert.equal(r.isError, true);
      r = await call('list_notes', {});
      assert.match(r.text, /Secret\.md 🔒 locked/);
      assert.equal(srv.vault.isEncrypted('Secret'), true);
    } finally {
      await client.close();
    }
  });
});

describe('loopback host guard', () => {
  test('rejects foreign Host header when no token', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-host-'));
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
