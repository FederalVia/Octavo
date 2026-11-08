import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectClients } from '../src/connect.js';

test('connect snippets: every client, valid JSON files, key only where given, no stdio without a command', () => {
  const clients = connectClients({
    name: 'octavo-work',
    stdio: { command: 'C:\\Octavo\\Octavo.exe', args: ['C:\\Octavo\\cli.mjs', 'mcp', '--vault', 'C:\\Users\\me\\My Notes'], env: { ELECTRON_RUN_AS_NODE: '1' } },
    httpUrl: 'http://127.0.0.1:4321/mcp',
    token: 'k3y',
  });
  const ids = clients.map((c) => c.id);
  assert.deepEqual(ids, ['claude-code', 'claude-desktop', 'codex', 'cursor', 'windsurf', 'gemini', 'vscode', 'chatgpt', 'other']);
  for (const c of clients) {
    assert.ok(c.snippets.length, c.id);
    for (const s of c.snippets) {
      if (s.kind === 'file' && s.file?.endsWith('.json')) {
        const parsed = JSON.parse(s.text) as Record<string, Record<string, unknown>>;
        const root = parsed.mcpServers ?? parsed.servers;
        assert.ok(root && root['octavo-work'], `${c.id}: ${s.title}`);
      }
    }
  }
  const claude = clients.find((c) => c.id === 'claude-code')!;
  assert.match(claude.snippets[0].text, /^claude mcp add octavo-work --scope user --env ELECTRON_RUN_AS_NODE=1 -- /);
  assert.match(claude.snippets[0].text, /'C:\\Users\\me\\My Notes'/); // spaces are quoted
  assert.match(claude.snippets[1].text, /--header 'Authorization: Bearer k3y'/);
  const codex = clients.find((c) => c.id === 'codex')!;
  assert.match(codex.snippets.find((s) => s.kind === 'file')!.text, /^\[mcp_servers\.octavo-work\]\ncommand = "C:\\\\Octavo\\\\Octavo\.exe"/);
  const desktop = clients.find((c) => c.id === 'claude-desktop')!;
  assert.deepEqual(JSON.parse(desktop.snippets[0].text).mcpServers['octavo-work'].env, { ELECTRON_RUN_AS_NODE: '1' });
  const vscode = clients.find((c) => c.id === 'vscode')!;
  assert.equal(JSON.parse(vscode.snippets[1].text).servers['octavo-work'].headers.Authorization, 'Bearer k3y');

  // No stdio (Docker) and no key: HTTP only, nothing mentions a key.
  const http = connectClients({ name: 'octavo', httpUrl: 'http://127.0.0.1:4321/mcp' });
  for (const c of http) for (const s of c.snippets) if (s.kind !== 'note') assert.doesNotMatch(s.text, /Bearer|--env|ELECTRON/, `${c.id}: ${s.title}`);
  assert.equal(http.find((c) => c.id === 'claude-code')!.snippets.length, 1);
  assert.equal(http.find((c) => c.id === 'claude-desktop')!.snippets[0].kind, 'note');
});
