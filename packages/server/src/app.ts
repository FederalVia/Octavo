import { clipNote, readPage, WebReadError } from './webread.js';
import { buildSite, zipFiles } from './publish.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CanvasFormatError,
  EditMatchError,
  EncryptedNoteError,
  NoteConflictError,
  NoteExistsError,
  NoteNotFoundError,
  VaultPathError,
  type Vault,
  type VaultEvent,
} from '@octavo/core';
import { createMcpServer } from './mcp.js';
import { VERSION } from './version.js';

export interface AppOptions {
  vault: Vault;
  /** If set, every /api and /mcp request needs `Authorization: Bearer <token>` (or `?token=`). */
  token?: string;
  /** Directory containing the built web UI. */
  webDir?: string;
  /**
   * Allowed Host header values (guards against DNS rebinding when running on
   * localhost without a token). Empty/undefined = allow any.
   */
  allowedHosts?: string[];
  /** Expose MCP tools read-only (no write/edit/delete). */
  mcpReadOnly?: boolean;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function notePathParam(req: Request): string {
  const p = (req.params as Record<string, string | string[]>).path;
  return Array.isArray(p) ? p.join('/') : p;
}

export function createApp(opts: AppOptions): express.Express {
  const { vault } = opts;
  const app = express();
  app.disable('x-powered-by');

  if (opts.allowedHosts && opts.allowedHosts.length) {
    const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
    app.use((req, res, next) => {
      const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (!allowed.has(host)) {
        res.status(403).json({ error: `Host "${host}" not allowed` });
        return;
      }
      next();
    });
  }

  // Lock out an address after repeated wrong keys (protects internet-facing servers from guessing).
  const failures = new Map<string, { count: number; first: number; blockedUntil: number }>();
  const MAX_FAILURES = 10;
  const WINDOW_MS = 10 * 60 * 1000;
  const BLOCK_MS = 15 * 60 * 1000;

  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (!opts.token) return next();
    const who = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const rec = failures.get(who);
    if (rec && rec.blockedUntil > now) {
      res.setHeader('Retry-After', String(Math.ceil((rec.blockedUntil - now) / 1000)));
      res.status(429).json({ error: 'Too many wrong access keys. Try again later.' });
      return;
    }
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const query = typeof req.query.token === 'string' ? req.query.token : '';
    if ((bearer && safeEqual(bearer, opts.token)) || (query && safeEqual(query, opts.token))) {
      failures.delete(who);
      return next();
    }
    // Only count actual guesses, not requests that simply carry no key.
    if (bearer || query) {
      const r = rec && now - rec.first < WINDOW_MS ? rec : { count: 0, first: now, blockedUntil: 0 };
      r.count++;
      if (r.count >= MAX_FAILURES) r.blockedUntil = now + BLOCK_MS;
      failures.set(who, r);
      if (failures.size > 10_000) failures.clear();
    }
    res.status(401).json({ error: 'Unauthorized' });
  };

  // Drawings carry their images inline, so their route parses a bigger body (after the access key check).
  const json = express.json({ limit: '10mb' });
  app.use((req, res, next) => (req.method === 'PUT' && req.path.startsWith('/api/drawing/') ? next() : json(req, res, next)));

  // ------------------------------------------------------------------ MCP
  app.post('/mcp', auth, async (req, res) => {
    const server = createMcpServer(vault, { readOnly: opts.mcpReadOnly });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[octavo] MCP request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });
  const mcpMethodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', auth, mcpMethodNotAllowed);
  app.delete('/mcp', auth, mcpMethodNotAllowed);

  // ------------------------------------------------------------------ REST API
  const api = express.Router();
  api.use(auth);

  api.get('/vault', (_req, res) => {
    res.json({ name: vault.name, noteCount: vault.list().length, dailyFolder: vault.dailyFolder, version: VERSION });
  });

  api.get('/notes', (req, res) => {
    res.json({
      notes: vault.list({
        folder: typeof req.query.folder === 'string' ? req.query.folder : undefined,
        tag: typeof req.query.tag === 'string' ? req.query.tag : undefined,
      }),
      folders: vault.folders(),
    });
  });

  api.get('/notes/*path', async (req, res, next) => {
    try {
      res.json(await vault.read(notePathParam(req)));
    } catch (err) {
      next(err);
    }
  });

  api.put('/notes/*path', async (req, res, next) => {
    try {
      const { content, expectedMtime } = req.body ?? {};
      if (typeof content !== 'string') {
        res.status(400).json({ error: 'Body must include "content" (string)' });
        return;
      }
      const summary = await vault.write(notePathParam(req), content, {
        expectedMtime: typeof expectedMtime === 'number' ? expectedMtime : undefined,
      });
      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  api.post('/notes', async (req, res, next) => {
    try {
      const { path: p, content } = req.body ?? {};
      if (typeof p !== 'string') {
        res.status(400).json({ error: 'Body must include "path"' });
        return;
      }
      res.status(201).json(await vault.create(p, typeof content === 'string' ? content : ''));
    } catch (err) {
      next(err);
    }
  });

  api.delete('/notes/*path', async (req, res, next) => {
    try {
      res.json(await vault.delete(notePathParam(req)));
    } catch (err) {
      next(err);
    }
  });

  api.post('/rename', async (req, res, next) => {
    try {
      const { from, to, updateLinks } = req.body ?? {};
      if (typeof from !== 'string' || typeof to !== 'string') {
        res.status(400).json({ error: 'Body must include "from" and "to"' });
        return;
      }
      res.json(await vault.rename(from, to, { updateLinks: updateLinks !== false }));
    } catch (err) {
      next(err);
    }
  });

  api.post('/merge', async (req, res, next) => {
    try {
      const { from, into } = req.body ?? {};
      if (typeof from !== 'string' || typeof into !== 'string') {
        res.status(400).json({ error: 'Body must include "from" and "into"' });
        return;
      }
      res.json(await vault.merge(from, into));
    } catch (err) {
      next(err);
    }
  });

  api.get('/resolve', async (req, res) => {
    const link = typeof req.query.link === 'string' ? req.query.link : '';
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const p = link ? vault.resolveLink({ target: link }, from) : null;
    // A link to a deleted note: say where it is in the trash, so the app can offer to restore it.
    const trashed = !p && link ? await vault.findInTrash(link) : null;
    res.json({ path: p, ...(trashed ? { trashed } : {}) });
  });

  api.post('/trash/restore', async (req, res, next) => {
    try {
      const { trashPath } = req.body ?? {};
      if (typeof trashPath !== 'string') return void res.status(400).json({ error: 'Body must include "trashPath"' });
      res.json(await vault.restore(trashPath));
    } catch (err) {
      next(err);
    }
  });

  api.get('/search', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json({ results: q.trim() ? vault.search(q, limit) : [] });
  });

  api.get('/tags', (_req, res) => {
    res.json({ tags: vault.tags() });
  });

  // The graph only changes when a note does (vault.graph() is cached until then): serialise it once per change.
  let graphJson: { graph: object; json: string } | null = null;
  api.get('/graph', (_req, res) => {
    const graph = vault.graph();
    if (graphJson?.graph !== graph) graphJson = { graph, json: JSON.stringify(graph) };
    res.type('json').send(graphJson.json);
  });

  api.get('/related/*path', (req, res, next) => {
    try {
      res.json({ related: vault.related(notePathParam(req), 20) });
    } catch (err) {
      next(err);
    }
  });

  // Attachments: GET by path or bare name (like ![[photo.png]]), POST raw bytes to upload.
  api.get('/files/*path', (req, res, next) => {
    try {
      const ref = notePathParam(req);
      const from = typeof req.query.from === 'string' ? req.query.from : undefined;
      const rel = vault.resolveAttachment(ref, from) ?? (vault.resolve(ref) && ref.toLowerCase().endsWith('.md') ? vault.resolve(ref) : null);
      if (!rel) {
        res.status(404).json({ error: `File not found: ${ref}` });
        return;
      }
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(vault.filePath(rel), { dotfiles: 'deny' });
    } catch (err) {
      next(err);
    }
  });

  api.post('/attachments', express.raw({ type: () => true, limit: '100mb' }), async (req, res, next) => {
    try {
      const name = typeof req.query.name === 'string' ? req.query.name : 'file';
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: 'Empty upload' });
        return;
      }
      const folder = typeof req.query.folder === 'string' ? req.query.folder : 'attachments';
      res.status(201).json({ path: await vault.saveAttachment(name, req.body, folder) });
    } catch (err) {
      next(err);
    }
  });

  api.get('/history/*path', async (req, res, next) => {
    try {
      const id = typeof req.query.id === 'string' ? req.query.id : '';
      if (id) res.json({ content: await vault.readVersion(notePathParam(req), id) });
      else res.json({ versions: await vault.history(notePathParam(req)) });
    } catch (err) {
      next(err);
    }
  });

  api.post('/restore', async (req, res, next) => {
    try {
      const { path: p, id } = req.body ?? {};
      if (typeof p !== 'string' || typeof id !== 'string') {
        res.status(400).json({ error: 'Body must include "path" and "id"' });
        return;
      }
      res.json(await vault.restoreVersion(p, id));
    } catch (err) {
      next(err);
    }
  });

  api.get('/mentions/*path', (req, res, next) => {
    try {
      res.json({ mentions: vault.unlinkedMentions(notePathParam(req)) });
    } catch (err) {
      next(err);
    }
  });

  api.get('/insights', (_req, res) => {
    res.json(vault.insights());
  });

  // Publish: the static website as a zip download.
  api.get('/publish.zip', async (req, res, next) => {
    try {
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      const site = await buildSite(vault, {
        scope: req.query.scope === 'all' ? 'all' : 'marked',
        folder: req.query.folder !== undefined ? String(req.query.folder) : undefined,
        tag: str(req.query.tag),
        title: str(req.query.title),
      });
      const name = (str(req.query.title) ?? path.basename(vault.root)).replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'site';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}-site.zip`);
      res.setHeader('X-Octavo-Pages', String(site.pages));
      res.send(zipFiles(site.files, `${name}-site/`));
    } catch (err) {
      next(err);
    }
  });

  api.get('/query', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const lang = req.query.lang === 'base' || req.query.lang === 'dql' ? req.query.lang : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    res.json(vault.query(q, { lang, thisPath: from }));
  });

  // Canvases (.canvas files, JSON Canvas format).
  api.get('/canvases', (_req, res) => {
    res.json({ canvases: vault.canvases() });
  });

  api.get('/canvas/*path', async (req, res, next) => {
    try {
      res.json(await vault.readCanvas(notePathParam(req)));
    } catch (err) {
      next(err);
    }
  });

  api.put('/canvas/*path', async (req, res, next) => {
    try {
      const { data, expectedMtime, createOnly } = req.body ?? {};
      res.json(await vault.writeCanvas(notePathParam(req), data ?? { nodes: [], edges: [] }, { expectedMtime: typeof expectedMtime === 'number' ? expectedMtime : undefined, createOnly: createOnly === true }));
    } catch (err) {
      next(err);
    }
  });

  // Drawings (.excalidraw files).
  api.get('/drawings', (_req, res) => {
    res.json({ drawings: vault.drawings() });
  });

  api.get('/drawing/*path', async (req, res, next) => {
    try {
      res.json(await vault.readDrawing(notePathParam(req)));
    } catch (err) {
      next(err);
    }
  });

  api.put('/drawing/*path', express.json({ limit: '40mb' }), async (req, res, next) => {
    try {
      const { data, expectedMtime, createOnly } = req.body ?? {};
      res.json(await vault.writeDrawing(notePathParam(req), data, { expectedMtime: typeof expectedMtime === 'number' ? expectedMtime : undefined, createOnly: createOnly === true }));
    } catch (err) {
      next(err);
    }
  });

  // Web viewer: reader mode and clipping a page into the vault.
  api.get('/web/read', async (req, res, next) => {
    try {
      res.json(await readPage(String(req.query.url ?? '')));
    } catch (err) {
      if (err instanceof WebReadError) res.status(422).json({ error: err.message });
      else next(err);
    }
  });

  api.post('/web/clip', async (req, res, next) => {
    try {
      const { url, folder } = req.body ?? {};
      if (typeof url !== 'string') {
        res.status(400).json({ error: 'Body must include "url"' });
        return;
      }
      const page = await readPage(url);
      const dir = (typeof folder === 'string' && folder.trim() ? folder.trim() : 'Clippings').replace(/^\/+|\/+$/g, '');
      const base = page.title.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Clipping';
      let name = `${dir}/${base}.md`;
      for (let i = 2; vault.has(name); i++) name = `${dir}/${base} ${i}.md`;
      res.json(await vault.create(name, clipNote(page)));
    } catch (err) {
      if (err instanceof WebReadError) res.status(422).json({ error: err.message });
      else next(err);
    }
  });

  api.post('/append', async (req, res, next) => {
    try {
      const { path: p, text, heading } = req.body ?? {};
      if (typeof p !== 'string' || typeof text !== 'string') {
        res.status(400).json({ error: 'Body must include "path" and "text"' });
        return;
      }
      res.json(await vault.append(p, text, { heading: typeof heading === 'string' ? heading : undefined }));
    } catch (err) {
      next(err);
    }
  });

  api.post('/property', async (req, res, next) => {
    try {
      const { path: p, key, value } = req.body ?? {};
      if (typeof p !== 'string' || typeof key !== 'string' || !key.trim()) {
        res.status(400).json({ error: 'Body must include "path" and "key"' });
        return;
      }
      res.json(await vault.setProperty(p, key.trim(), value ?? null));
    } catch (err) {
      next(err);
    }
  });

  api.get('/tasks', (req, res) => {
    res.json({ tasks: vault.tasks({ includeDone: req.query.done === '1' }) });
  });

  api.post('/tasks', async (req, res, next) => {
    try {
      const { path: p, line, status } = req.body ?? {};
      if (typeof p !== 'string' || typeof line !== 'number') {
        res.status(400).json({ error: 'Body must include "path" and "line"' });
        return;
      }
      res.json(await vault.setTask(p, line, typeof status === 'string' ? status : undefined));
    } catch (err) {
      next(err);
    }
  });

  // CSS snippets: .css files in the vault's .octavo/snippets folder. The app turns them on and off.
  api.get('/snippets', async (_req, res) => {
    const dir = path.join(vault.root, '.octavo', 'snippets');
    const names = (await fsp.readdir(dir).catch(() => [] as string[])).filter((n) => /^[^./\\][^/\\]*\.css$/i.test(n)).sort();
    const snippets = await Promise.all(
      names.map(async (name) => ({ name, css: (await fsp.readFile(path.join(dir, name), 'utf8').catch(() => '')).slice(0, 200_000) })),
    );
    res.json({ folder: '.octavo/snippets', snippets });
  });

  const CONFIG_NAMES = new Set(['bookmarks', 'settings', 'hotkeys', 'workspaces', 'snippets']);
  api.get('/config/:name', async (req, res) => {
    if (!CONFIG_NAMES.has(req.params.name)) {
      res.status(404).json({ error: 'Unknown config' });
      return;
    }
    res.json({ value: await vault.getConfig(req.params.name, null) });
  });
  api.put('/config/:name', async (req, res, next) => {
    try {
      if (!CONFIG_NAMES.has(req.params.name)) {
        res.status(404).json({ error: 'Unknown config' });
        return;
      }
      await vault.setConfig(req.params.name, req.body?.value ?? null);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  api.post('/daily', async (_req, res, next) => {
    try {
      res.json(await vault.ensureDailyNote());
    } catch (err) {
      next(err);
    }
  });

  api.post('/periodic/:period', async (req, res, next) => {
    try {
      const period = req.params.period;
      if (period !== 'day' && period !== 'week' && period !== 'month') return void res.status(400).json({ error: 'period must be day, week or month' });
      // Optional ?date=YYYY-MM-DD (e.g. clicking a day in the calendar); default today.
      const q = typeof req.query.date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(req.query.date) : null;
      const date = q ? new Date(Number(q[1]), Number(q[2]) - 1, Number(q[3])) : new Date();
      res.json(await vault.ensurePeriodicNote(period, date));
    } catch (err) {
      next(err);
    }
  });

  // Server-sent events: live updates when notes change (from the UI, Claude, or other editors).
  api.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const onEvent = (e: VaultEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    vault.on('event', onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      vault.off('event', onEvent);
    });
  });

  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use('/api', api);

  // ------------------------------------------------------------------ Web UI
  if (opts.webDir && fs.existsSync(path.join(opts.webDir, 'index.html'))) {
    const webDir = opts.webDir;
    // Home-screen apps (iOS especially) get their own storage, so the app's start
    // address must carry the access key. Only a valid key is ever echoed back.
    app.get('/manifest.webmanifest', (req, res, next) => {
      const key = typeof req.query.token === 'string' ? req.query.token : '';
      if (!key || (opts.token && !safeEqual(key, opts.token))) return next();
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(webDir, 'manifest.webmanifest'), 'utf8'));
        manifest.start_url = `./?token=${encodeURIComponent(key)}`;
        res.setHeader('Cache-Control', 'no-store');
        res.type('application/manifest+json').send(JSON.stringify(manifest));
      } catch {
        next();
      }
    });
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    // A missing file (e.g. an old build's asset asked for by a tab opened before an update) must be a
    // 404, never the app page: a script import that gets HTML crashes the app and poisons the cache.
    app.get(/\.[a-z0-9]{1,8}$/i, (_req, res) => {
      res.status(404).type('text/plain').send('Not found');
    });
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(webDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .type('text/plain')
        .send('Octavo server is running. Build the web UI with `npm run build` to use the app here.\nMCP endpoint: /mcp');
    });
  }

  // ------------------------------------------------------------------ errors
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof NoteNotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof NoteConflictError) {
      res.status(409).json({ error: err.message, currentMtime: err.currentMtime });
    } else if (err instanceof NoteExistsError) {
      res.status(409).json({ error: err.message });
    } else if (err instanceof EncryptedNoteError) {
      res.status(423).json({ error: err.message, encrypted: true });
    } else if ((err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: 'That request is too large' });
    } else if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'The request body is not valid JSON' });
    } else if (err instanceof VaultPathError || err instanceof EditMatchError || err instanceof CanvasFormatError) {
      res.status(400).json({ error: err.message });
    } else {
      console.error('[octavo] request failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}
