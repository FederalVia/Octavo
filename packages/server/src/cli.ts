#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Vault } from '@ultron/core';
import { startServer } from './index.js';
import { createMcpServer } from './mcp.js';
import { seedIfEmpty } from './seed.js';

const HELP = `Ultron Mind: a Markdown knowledge base that doubles as Claude's memory.

Usage:
  ultron serve [options]   Run the web app, REST API and MCP endpoint (/mcp)
  ultron mcp   [options]   Run an MCP server over stdio (for Claude Desktop / Claude Code)

Options:
  --vault <dir>     Vault folder (env ULTRON_VAULT, default ~/UltronMind)
  --port <n>        HTTP port for "serve" (env PORT, default 4321)
  --host <addr>     Bind address for "serve" (env ULTRON_HOST, default 127.0.0.1)
  --token <secret>  Require this bearer token for /api and /mcp (env ULTRON_TOKEN)
  --read-only       Expose only read tools over MCP
  --daily <folder>  Folder for daily journal notes (default Journal)
  --no-seed         Don't create starter notes in an empty vault
  -h, --help        Show this help
`;

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      vault: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      token: { type: 'string' },
      'read-only': { type: 'boolean', default: false },
      daily: { type: 'string' },
      'no-seed': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const command = positionals[0] ?? 'serve';
  if (values.help || !['serve', 'mcp'].includes(command)) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const vaultPath = path.resolve(expandHome(values.vault ?? process.env.ULTRON_VAULT ?? '~/UltronMind'));
  const token = values.token ?? process.env.ULTRON_TOKEN ?? undefined;
  const seed = !values['no-seed'];

  if (command === 'mcp') {
    // stdout is the MCP channel: log to stderr only.
    const vault = await Vault.open(vaultPath, { dailyFolder: values.daily });
    if (seed) await seedIfEmpty(vault);
    const server = createMcpServer(vault, { readOnly: values['read-only'] });
    await server.connect(new StdioServerTransport());
    console.error(`[ultron] MCP server (stdio) ready. Vault: ${vaultPath}`);
    const shutdown = () => {
      vault.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  const host = values.host ?? process.env.ULTRON_HOST ?? '127.0.0.1';
  const port = Number(values.port ?? process.env.PORT ?? 4321);
  if (!token && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.warn(
      `[ultron] WARNING: listening on ${host} without --token. Anyone who can reach this port can read and edit your vault.`,
    );
  }
  const running = await startServer({
    vaultPath,
    port,
    host,
    token,
    dailyFolder: values.daily,
    mcpReadOnly: values['read-only'],
  });
  if (seed) await seedIfEmpty(running.vault);
  console.log(`[ultron] Vault:  ${vaultPath} (${running.vault.list().length} notes)`);
  console.log(`[ultron] App:    ${running.url}`);
  console.log(`[ultron] MCP:    ${running.url}/mcp${token ? ' (bearer token required)' : ''}`);
  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[ultron] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
