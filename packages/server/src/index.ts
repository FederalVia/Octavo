import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Vault } from '@ultron/core';
import { createApp } from './app.js';

export { createApp } from './app.js';
export { createMcpServer, SERVER_INSTRUCTIONS } from './mcp.js';
export { seedIfEmpty } from './seed.js';

export interface StartOptions {
  vaultPath: string;
  port?: number;
  host?: string;
  token?: string;
  webDir?: string;
  dailyFolder?: string;
  mcpReadOnly?: boolean;
  /** If the port is taken, fall back to a random free port. */
  fallbackToRandomPort?: boolean;
}

export interface RunningServer {
  url: string;
  port: number;
  vault: Vault;
  close(): Promise<void>;
}

/** Locate the built web UI shipped in the @ultron/web workspace package. */
export function defaultWebDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve('@ultron/web/package.json')), 'dist');
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
  const app = createApp({
    vault,
    token: opts.token,
    webDir: opts.webDir ?? defaultWebDir(),
    mcpReadOnly: opts.mcpReadOnly,
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
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${displayHost}:${port}`,
    port,
    vault,
    close: () =>
      new Promise<void>((resolve) => {
        vault.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
