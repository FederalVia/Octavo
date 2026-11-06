#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Vault } from '@ultron/core';
import { startServer } from './index.js';
import { createMcpServer } from './mcp.js';
import { seedIfEmpty } from './seed.js';
import { NOTE_COMMANDS, NOTE_COMMANDS_HELP, runNoteCommand } from './commands.js';
import { lanAddresses, loadOrCreateToken, phoneUrl, qrTerminal } from './phone.js';

const HELP = `Ultron Mind: a Markdown knowledge base that doubles as Claude's memory.

Usage:
  ultron serve [options]   Run the web app, REST API and MCP endpoint (/mcp)
  ultron mcp   [options]   Run an MCP server over stdio (for Claude Desktop / Claude Code)

Options:
  --vault <dir>     Vault folder (env ULTRON_VAULT, default ~/UltronMind)
  --port <n>        HTTP port for "serve" (env PORT, default 4321)
  --host <addr>     Bind address for "serve" (env ULTRON_HOST, default 127.0.0.1)
  --token <secret>  Require this bearer token for /api and /mcp (env ULTRON_TOKEN)
  --phone           Open to your Wi-Fi with an access key and show a QR code to scan
  --read-only       Expose only read tools over MCP
  --daily <folder>  Folder for daily journal notes (default Journal)
  --no-seed         Don't create starter notes in an empty vault
  -h, --help        Show this help

${NOTE_COMMANDS_HELP}
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
      phone: { type: 'boolean', default: false },
      daily: { type: 'string' },
      'no-seed': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      content: { type: 'string' },
      heading: { type: 'string' },
      limit: { type: 'string' },
      done: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  const command = positionals[0] ?? 'serve';
  if (values.help || !['serve', 'mcp', ...NOTE_COMMANDS].includes(command)) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const vaultPath = path.resolve(expandHome(values.vault ?? process.env.ULTRON_VAULT ?? '~/UltronMind'));
  const token = values.token ?? process.env.ULTRON_TOKEN ?? undefined;
  const seed = !values['no-seed'];

  if (NOTE_COMMANDS.has(command)) {
    await runNoteCommand(vaultPath, command, positionals.slice(1), {
      content: values.content,
      heading: values.heading,
      limit: values.limit,
      done: values.done,
      json: values.json,
      daily: values.daily,
    });
    return;
  }

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

  const phone = values.phone;
  const host = values.host ?? process.env.ULTRON_HOST ?? (phone ? '0.0.0.0' : '127.0.0.1');
  const port = Number(values.port ?? process.env.PORT ?? 4321);
  // Phone mode always uses an access key: a saved one (so the phone's bookmark keeps working) unless --token is given.
  const serveToken = token ?? (phone ? loadOrCreateToken() : undefined);
  if (!serveToken && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.warn(
      `[ultron] WARNING: listening on ${host} without --token. Anyone who can reach this port can read and edit your vault.`,
    );
  }
  const running = await startServer({
    vaultPath,
    port,
    host,
    token: serveToken,
    dailyFolder: values.daily,
    mcpReadOnly: values['read-only'],
  });
  if (seed) await seedIfEmpty(running.vault);
  console.log(`[ultron] Vault:  ${vaultPath} (${running.vault.list().length} notes)`);
  console.log(`[ultron] App:    ${running.url}`);
  console.log(`[ultron] MCP:    ${running.url}/mcp${serveToken ? ' (bearer token required)' : ''}`);
  if (phone && serveToken) {
    const addrs = lanAddresses();
    if (!addrs.length) {
      console.log('[ultron] Phone:  no Wi-Fi/LAN address found. Is this computer connected to a network?');
    } else {
      const url = phoneUrl(addrs[0], running.port, serveToken);
      console.log('');
      console.log('  Scan with your phone (it must be on the same Wi-Fi):');
      console.log('');
      console.log(await qrTerminal(url));
      console.log(`  ${url}`);
      for (const other of addrs.slice(1, 3)) console.log(`  or ${phoneUrl(other, running.port, serveToken)}`);
      console.log('');
      console.log('  Treat this link like a password. Anyone with it can read and edit your notes.');
      console.log('  Away from home? See docs/INSTALL.md → "Use it on your phone".');
      console.log('');
    }
  }
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
