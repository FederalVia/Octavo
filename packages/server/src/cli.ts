#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { recordAccess } from './activity.js';
import { Vault } from '@octavo/core';
import { startServer } from './index.js';
import { createMcpServer } from './mcp.js';
import { seedIfEmpty } from './seed.js';
import { NOTE_COMMANDS, NOTE_COMMANDS_HELP, runNoteCommand } from './commands.js';
import { lanAddresses, loadOrCreateToken, phoneUrl, qrTerminal } from './phone.js';
import { RemoteAccess, diagnose, REMOTE_ADVICE } from './remote/remote.js';

const HELP = `Octavo: a Markdown knowledge base that doubles as Claude's memory.

Usage:
  octavo serve [options]   Run the web app, REST API and MCP endpoint (/mcp)
  octavo mcp   [options]   Run an MCP server over stdio (for Claude Desktop / Claude Code)
  octavo check-remote      Check whether your home network allows direct access from anywhere
  octavo qr <address>      Print a QR code that opens Octavo at <address> on your phone
                           (uses --token or OCTAVO_TOKEN), e.g. octavo qr https://octavo.tail1234.ts.net

Options:
  --vault <dir>     Vault folder (env OCTAVO_VAULT, default ~/Octavo)
  --port <n>        HTTP port for "serve" (env PORT, default 4321)
  --host <addr>     Bind address for "serve" (env OCTAVO_HOST, default 127.0.0.1)
  --token <secret>  Require this bearer token for /api and /mcp (env OCTAVO_TOKEN)
  --phone           Open to your Wi-Fi with an access key and show a QR code to scan
  --remote          Access from anywhere: opens your router (UPnP), gets a free HTTPS
                    certificate for your home's address and shows a QR code to scan
  --public-ip <ip>  With --remote: skip UPnP (ports forwarded by hand: 80 → 4380, 443 → 4443)
  --https-port <n>, --challenge-port <n>
                    With --remote: change the local ports (defaults 4443 and 4380)
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
      remote: { type: 'boolean', default: false },
      'public-ip': { type: 'string' },
      'acme-directory': { type: 'string' },
      'https-port': { type: 'string' },
      'challenge-port': { type: 'string' },
      daily: { type: 'string' },
      'no-seed': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      content: { type: 'string' },
      heading: { type: 'string' },
      limit: { type: 'string' },
      into: { type: 'string' },
      done: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      folder: { type: 'string' },
      tag: { type: 'string' },
      title: { type: 'string' },
    },
  });

  const command = positionals[0] ?? 'serve';
  if (values.help || !['serve', 'mcp', 'qr', 'check-remote', ...NOTE_COMMANDS].includes(command)) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const vaultPath = path.resolve(expandHome(values.vault ?? process.env.OCTAVO_VAULT ?? '~/Octavo'));
  const token = values.token ?? process.env.OCTAVO_TOKEN ?? undefined;
  const seed = !values['no-seed'];

  if (command === 'check-remote') {
    console.log('Checking whether your network allows direct connections from the internet…\n');
    const d = await diagnose();
    for (const l of d.lines) console.log(`  ${l}`);
    console.log('');
    if (d.ok) {
      console.log('  Good news: direct access should work. Start it with:  npm start -- --remote');
    } else if (d.problem) {
      console.log('  ' + REMOTE_ADVICE[d.problem].replace('{challenge}', '4380').replace('{https}', '4443'));
    }
    console.log('');
    process.exit(d.ok ? 0 : 2);
  }

  if (command === 'qr') {
    const base = positionals[1];
    if (!base || !/^https?:\/\/\S+$/.test(base)) {
      console.error('Usage: octavo qr <address>   e.g. octavo qr https://octavo.tail1234.ts.net');
      process.exit(1);
    }
    const url = new URL(base);
    if (token) url.searchParams.set('token', token);
    console.log('');
    console.log('  Scan with your phone:');
    console.log('');
    console.log(await qrTerminal(url.toString()));
    console.log(`  ${url.toString()}`);
    console.log('');
    if (token) console.log('  Treat this like a password. Anyone with it can read and edit your notes.');
    else console.log('  No access key set (OCTAVO_TOKEN), so the link has no key.');
    console.log('');
    return;
  }

  if (NOTE_COMMANDS.has(command)) {
    await runNoteCommand(vaultPath, command, positionals.slice(1), {
      content: values.content,
      heading: values.heading,
      limit: values.limit,
      done: values.done,
      json: values.json,
      daily: values.daily,
      into: values.into,
      all: values.all,
      folder: values.folder,
      tag: values.tag,
      title: values.title,
    });
    return;
  }

  if (command === 'mcp') {
    // stdout is the MCP channel: log to stderr only.
    const vault = await Vault.open(vaultPath, { dailyFolder: values.daily });
    if (seed) await seedIfEmpty(vault);
    const server = createMcpServer(vault, { readOnly: values['read-only'] });
    // Let the Octavo app (a different process) draw Claude's reads in the atlas trail.
    vault.on('event', (e: { type: string; path?: string }) => {
      if (e.type === 'access' && e.path) recordAccess(vault.root, e.path);
    });
    // Some clients keep the tool list from their first connection; telling them it changed
    // (once they've finished connecting) prompts a refresh after an Octavo update.
    server.server.oninitialized = () => {
      try {
        server.sendToolListChanged();
      } catch {
        /* not connected */
      }
    };
    await server.connect(new StdioServerTransport());
    console.error(`[octavo] MCP server (stdio) ready. Vault: ${vaultPath}`);
    const shutdown = () => {
      vault.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  const phone = values.phone;
  const host = values.host ?? process.env.OCTAVO_HOST ?? (phone ? '0.0.0.0' : '127.0.0.1');
  const port = Number(values.port ?? process.env.PORT ?? 4321);
  // Phone mode always uses an access key: a saved one (so the phone's bookmark keeps working) unless --token is given.
  const remoteMode = values.remote;
  const serveToken = token ?? (phone || remoteMode ? loadOrCreateToken() : undefined);
  if (!serveToken && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.warn(
      `[octavo] WARNING: listening on ${host} without --token. Anyone who can reach this port can read and edit your vault.`,
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
  console.log(`[octavo] Vault:  ${vaultPath} (${running.vault.list().length} notes)`);
  console.log(`[octavo] App:    ${running.url}`);
  console.log(`[octavo] MCP:    ${running.url}/mcp${serveToken ? ' (bearer token required)' : ''}`);
  if (phone && serveToken) {
    const addrs = lanAddresses();
    if (!addrs.length) {
      console.log('[octavo] Phone:  no Wi-Fi/LAN address found. Is this computer connected to a network?');
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
  let remote: RemoteAccess | null = null;
  if (remoteMode && serveToken) {
    remote = new RemoteAccess({
      app: running.app,
      stateDir: path.join(os.homedir(), '.octavo', 'remote'),
      // Hard guard: the local server must reject requests without the access key.
      requireToken: async () => (await fetch(`${running.url}/api/vault`).then((r) => r.status).catch(() => 0)) === 401,
      publicIp: values['public-ip'],
      directoryUrl: values['acme-directory'],
      ...(values['https-port'] ? { httpsPort: Number(values['https-port']), externalHttpsPorts: [Number(values['https-port'])] } : {}),
      ...(values['challenge-port'] ? { challengePort: Number(values['challenge-port']) } : {}),
      log: (m) => console.log(`[octavo] ${m}`),
    });
    const showQr = async (url: string) => {
      const link = `${url}/?token=${encodeURIComponent(serveToken)}`;
      console.log('');
      console.log('  Access from anywhere: scan with your phone (Wi-Fi or mobile data):');
      console.log('');
      console.log(await qrTerminal(link));
      console.log(`  ${link}`);
      console.log('');
      console.log('  Treat this link like a password. Anyone with it can read and edit your notes.');
      console.log('');
    };
    remote.on('status', (s) => {
      if (s.state === 'starting') console.log(`[octavo] ${s.step}`);
    });
    remote.on('address-changed', async (s) => {
      console.log('[octavo] Your home internet address changed. Scan this new code on your phone:');
      await showQr(s.url!);
    });
    const status = await remote.start();
    if (status.state === 'ready') await showQr(status.url!);
    else {
      console.log('');
      console.log(`[octavo] ${status.step}`);
      console.log('');
      console.log('  ' + (status.advice ?? '').split('\n').join('\n  '));
      console.log('');
      console.log('  Octavo is still running on this computer. Run "octavo check-remote" to diagnose.');
      console.log('');
    }
  }
  const shutdown = async () => {
    await remote?.stop();
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[octavo] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
