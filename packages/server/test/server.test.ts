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

  test('manifest carries a valid access key in its start address only', async () => {
    const wdir = await fs.mkdtemp(path.join(os.tmpdir(), 'octavo-web-'));
    await fs.writeFile(path.join(wdir, 'index.html'), '<html></html>');
    await fs.writeFile(path.join(wdir, 'manifest.webmanifest'), JSON.stringify({ name: 'Octavo', start_url: './' }));
    const m = await startServer({ vaultPath: dir, port: 0, token: 'k1', webDir: wdir });
    try {
      const good = await (await fetch(`${m.url}/manifest.webmanifest?token=k1`)).json();
      assert.equal(good.start_url, './?token=k1');
      const bad = await (await fetch(`${m.url}/manifest.webmanifest?token=wrong`)).json();
      assert.equal(bad.start_url, './', 'wrong keys are not echoed');
      const none = await (await fetch(`${m.url}/manifest.webmanifest`)).json();
      assert.equal(none.start_url, './');
    } finally {
      await m.close();
      await fs.rm(wdir, { recursive: true, force: true });
    }
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

  test('behind a trusted proxy, each forwarded client has its own lockout', async () => {
    // The test connects from loopback, standing in for Caddy / Tailscale serve.
    const proxied = await startServer({ vaultPath: dir, port: 0, token: 'right-key', webDir: '/nonexistent', trustProxy: 'loopback' });
    const asClient = (ip: string, key: string) =>
      fetch(`${proxied.url}/api/vault`, { headers: { Authorization: `Bearer ${key}`, 'X-Forwarded-For': ip } });
    try {
      for (let i = 0; i < 10; i++) assert.equal((await asClient('203.0.113.5', 'wrong')).status, 401);
      assert.equal((await asClient('203.0.113.5', 'right-key')).status, 429, 'the guessing client is locked out');
      assert.equal((await asClient('198.51.100.7', 'right-key')).status, 200, 'another device behind the proxy is not');
      assert.equal((await asClient('198.51.100.7', 'wrong')).status, 401, 'and keeps its own counter');
    } finally {
      await proxied.close();
    }
  });

  test('without trustProxy, X-Forwarded-For is ignored (a direct client cannot dodge the lockout)', async () => {
    const direct = await startServer({ vaultPath: dir, port: 0, token: 'right-key', webDir: '/nonexistent' });
    try {
      for (let i = 0; i < 10; i++) {
        const r = await fetch(`${direct.url}/api/vault`, { headers: { Authorization: 'Bearer wrong', 'X-Forwarded-For': `203.0.113.${i}` } });
        assert.equal(r.status, 401);
      }
      const r = await fetch(`${direct.url}/api/vault`, { headers: { Authorization: 'Bearer right-key', 'X-Forwarded-For': '198.51.100.7' } });
      assert.equal(r.status, 429, 'a made-up forwarded address is not a different client');
    } finally {
      await direct.close();
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
      for (const n of ['search_notes', 'read_note', 'write_note', 'append_to_note', 'log_to_journal', 'get_vault_overview', 'list_tasks', 'update_task', 'open_periodic_note', 'merge_notes', 'random_note', 'get_note_region', 'set_note_region', 'find_orphans', 'restore_note', 'query_notes', 'set_property', 'read_canvas', 'add_to_canvas', 'manage_islands', 'place_note']) {
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
      r = await call('open_periodic_note', { period: 'week' });
      assert.match(r.text, /^Journal\/Weekly\/\d{4}-W\d{2}\.md\n\n# Week /);
      r = await call('random_note', { folder: 'People' });
      assert.match(r.text, /^# People\/Ada\.md\nUpdated .* · Brain region: Temporal \(in the “People” folder\)/);
      r = await call('set_note_region', { path: 'Ada', region: 'frontal' });
      assert.match(r.text, /now in the Frontal region \(set in the note’s properties/);
      r = await call('get_note_region', { path: 'Ada' });
      assert.match(r.text, /Frontal region \(frontal\)/);
      r = await call('set_note_region', { path: 'Ada', region: 'auto' });
      assert.match(r.text, /Temporal region/);
      // Bulk regions by folder, then back to automatic.
      await srv.vault.write('Batch/One.md', '# One');
      await srv.vault.write('Batch/Two.md', '# Two');
      r = await call('set_note_region', { folder: 'Batch', region: 'occipital' });
      assert.match(r.text, /^2 note\(s\) pinned to the Occipital region/);
      assert.equal(srv.vault.regionOf('Batch/Two.md').region, 'occipital');
      r = await call('set_note_region', { paths: ['Batch/One', 'Nope'], region: 'auto' });
      assert.match(r.text, /1 note\(s\) placed automatically again\.\nSkipped 1:\n- Nope \(not found\)/);
      // Orphans and missing notes.
      r = await call('find_orphans', { folder: 'Batch' });
      assert.match(r.text, /Orphans: nothing links to them \(2\):\n- Batch\/One\.md\n- Batch\/Two\.md/);
      r = await call('find_orphans', { kind: 'missing' });
      assert.match(r.text, /Missing notes: linked but not written yet/);
      // Random note favouring notes nothing links to.
      r = await call('random_note', { folder: 'Batch', favor: 'unlinked' });
      assert.match(r.text, /^# Batch\//);
      // Trash: a deleted note can be found and restored.
      await call('delete_note', { path: 'Batch/Two' });
      r = await call('read_note', { path: 'Batch/Two' });
      assert.match(r.text, /in the trash/);
      r = await call('restore_note', { path: 'Two' });
      assert.match(r.text, /Restored Batch\/Two\.md/);
      // Islands.
      r = await call('manage_islands', { action: 'add', folder: 'Nowhere' });
      assert.match(r.text, /No folder called “Nowhere”/);
      r = await call('manage_islands', { action: 'add', folder: 'Batch', name: 'Side project' });
      assert.match(r.text, /^Added\. Islands:\n- Side project: folder Batch\/ \(\d+ notes\), colour #ff6ad5/);
      r = await call('get_note_region', { path: 'Batch/One' });
      assert.match(r.text, /is on the “Side project” island \(folder Batch\/\)/);
      r = await call('get_vault_overview', {});
      assert.match(r.text, /\nIslands \(kept apart\): Side project \d+ \(folder Batch\/\)/);
      const islandGraph = (await (await api('/api/graph')).json()) as { nodes: { id: string; island?: string }[]; islands: { id: string }[] };
      assert.equal(islandGraph.nodes.find((n) => n.id === 'Batch/One.md')?.island, 'side-project');
      assert.deepEqual(islandGraph.islands.map((i) => i.id), ['side-project']);
      const put = await api('/api/islands', { method: 'PUT', body: JSON.stringify({ islands: [{ folder: 'Batch' }, { folder: 'batch' }] }) });
      assert.equal(put.status, 400, 'duplicate folders are rejected over REST too');
      r = await call('manage_islands', { action: 'remove', name: 'Side project' });
      assert.match(r.text, /^Removed\. Islands:\n\(none\)/);
      assert.deepEqual(((await (await api('/api/islands')).json()) as { islands: unknown[] }).islands, []);

      // Canvases.
      r = await call('add_to_canvas', {
        canvas: 'Boards/Plan',
        cards: [{ key: 'a', text: 'Start here' }, { key: 'b', note: 'Batch/One', color: '4' }, { key: 'c', note: 'Nope' }],
        connections: [{ from: 'a', to: 'b', label: 'leads to' }, { from: 'a', to: 'zzz' }],
        group: 'Plan',
      });
      assert.match(r.text, /^Boards\/Plan\.canvas: added 2 card\(s\) and 1 arrow\(s\)\. Ids: a=\w+, b=\w+\.\nSkipped:\n- c: no note called "Nope"\n- connection a → zzz: unknown card/);
      r = await call('read_canvas', { path: 'Plan' });
      assert.match(r.text, /Canvas Boards\/Plan\.canvas: 3 card\(s\), 1 arrow\(s\)/);
      assert.match(r.text, /\(file, colour 4\) \[\[Batch\/One\]\]/);
      assert.match(r.text, /"leads to"/);
      r = await call('read_canvas', {});
      assert.match(r.text, /Canvases \(1\):\n- Boards\/Plan\.canvas/);
      // Properties and queries.
      r = await call('set_property', { path: 'Batch/One', key: 'status', value: 'active' });
      assert.match(r.text, /Set status: "active" on Batch\/One\.md/);
      await call('set_property', { path: 'Batch/Two', key: 'status', value: 'done' });
      r = await call('query_notes', { query: 'TABLE status FROM "Batch" WHERE status != "done"' });
      assert.match(r.text, /\| Note \| status \|\n\| --- \| --- \|\n\| \[\[Batch\/One\]\] \| active \|\n\n1 note$/);
      r = await call('query_notes', { query: 'TABLE x FROM' });
      assert.match(r.text, /^Error: /);
      r = await call('set_property', { path: 'Batch/One', key: 'status', value: null });
      assert.match(r.text, /Removed "status"/);
      r = await call('get_vault_overview', {});
      assert.match(r.text, /Brain regions: /);
      assert.match(r.text, /\(Octavo \d+\.\d+\.\d+\)/);
      assert.equal(client.getServerVersion()?.version, JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
      const todo = await call('list_tasks', {});
      assert.doesNotMatch(todo.text, /\[\?\]/);
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

      // Placing notes by hand in the network view: beside another note (spread in a ring), at a spot, list, unpin, clear.
      r = await call('place_note', { notes: [{ note: 'Ada', x: 0.4, y: -0.2 }, { note: 'Secret', near: 'Ada' }] });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(srv.vault.pins()['People/Ada.md'], { x: 0.4, y: -0.2 });
      assert.equal((srv.vault.pins()['Secret.md'] as { near: string }).near, 'People/Ada.md');
      r = await call('place_note', { action: 'list' });
      assert.match(r.text, /Secret\.md: beside People\/Ada\.md/);
      r = await call('place_note', { notes: [{ note: 'Ada' }] });
      assert.equal(r.isError, true);
      r = await call('place_note', { notes: [{ note: 'Secret', unpin: true }] });
      assert.equal(srv.vault.pins()['Secret.md'], undefined);
      const g = await (await fetch(`${srv.url}/api/graph`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
      assert.deepEqual(g.pins, { 'People/Ada.md': { x: 0.4, y: -0.2 } });
      r = await call('place_note', { action: 'clear' });
      assert.deepEqual(srv.vault.pins(), {});
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
