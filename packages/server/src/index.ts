import http from 'node:http';
import { scheduleAutoBackups } from './backup.js';
import { FolderSync, type WatchedFolder } from './folderSync.js';
import type { ConnectInfo, StdioCommand } from './connect.js';
import { watchActivity } from './activity.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Vault } from '@octavo/core';
import { createApp } from './app.js';

export { createApp, parseTrustProxy } from './app.js';
export { createMcpServer, SERVER_INSTRUCTIONS } from './mcp.js';
export { seedIfEmpty } from './seed.js';
export { lanAddresses, loadOrCreateToken, phoneUrl, qrDataUrl } from './phone.js';
export { RemoteAccess, diagnose, type RemoteStatus, type RemoteProblem } from './remote/remote.js';
export { importNotion, importEnex, type ImportResult } from './importers.js';
export { activityFile, recordAccess, watchActivity } from './activity.js';
export { connectClients, type ConnectInfo, type ConnectClient, type ConnectSnippet, type StdioCommand } from './connect.js';
export { FolderSync, syncFolder, defaultInto, type WatchedFolder, type SyncResult, type FolderStatus } from './folderSync.js';

export interface StartOptions {
  vaultPath: string;
  port?: number;
  host?: string;
  token?: string;
  webDir?: string;
  dailyFolder?: string;
  mcpReadOnly?: boolean;
  /** Behind a reverse proxy: proxy addresses to trust for X-Forwarded-For (see AppOptions.trustProxy). */
  trustProxy?: string | number | boolean;
  /** If the port is taken, fall back to a random free port. */
  fallbackToRandomPort?: boolean;
  /** Folders outside the vault to mirror into it, e.g. where Notability backs up its PDFs (see folderSync.ts). */
  watchFolders?: WatchedFolder[];
  /** For Settings → Connect an AI: the server's name in AI tools, and how a tool on this computer can start it (stdio). */
  connect?: { name?: string; stdio?: StdioCommand };
}

export interface RunningServer {
  url: string;
  port: number;
  vault: Vault;
  /** The request handler, e.g. to also serve it over HTTPS for remote access. */
  app: import('express').Express;
  /** Notes from other apps: change the watched folders with folderSync.setFolders(). */
  folderSync: FolderSync;
  close(): Promise<void>;
}

/** Locate the built web UI shipped in the @octavo/web workspace package. */
export function defaultWebDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve('@octavo/web/package.json')), 'dist');
  } catch {
    return undefined;
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const vault = await Vault.open(opts.vaultPath, { dailyFolder: opts.dailyFolder });
  const folderSync = new FolderSync(vault);
  // Filled in once the port is known (see below); the app reads it per request.
  const connect: ConnectInfo = { name: opts.connect?.name ?? 'octavo', stdio: opts.connect?.stdio, httpUrl: '', token: opts.token };
  const app = createApp({
    folderSync,
    connect,
    vault,
    token: opts.token,
    webDir: opts.webDir ?? defaultWebDir(),
    mcpReadOnly: opts.mcpReadOnly,
    trustProxy: opts.trustProxy,
    // Without a token, a loopback-only server must reject foreign Host headers (DNS rebinding).
    allowedHosts: !opts.token && LOOPBACK.has(host) ? ['localhost', '127.0.0.1', '::1'] : undefined,
  });
  const server = http.createServer(app);
  let port: number;
  try {
    port = await listen(server, opts.port ?? 4321, host);
  } catch (err) {
    if (opts.fallbackToRandomPort && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      port = await listen(server, 0, host);
    } else {
      vault.close();
      throw err;
    }
  }
  // Reads by Claude Desktop's separate Octavo process show up in this app's atlas trail.
  const stopActivity = watchActivity(vault.root, (p) => vault.noteAccessed(p));
  const stopBackups = scheduleAutoBackups(vault);
  folderSync.setFolders(opts.watchFolders ?? []);
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  connect.httpUrl = `http://${displayHost}:${port}/mcp`;
  return {
    url: `http://${displayHost}:${port}`,
    port,
    vault,
    app,
    folderSync,
    close: () =>
      new Promise<void>((resolve) => {
        stopActivity();
        stopBackups();
        folderSync.close();
        vault.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
