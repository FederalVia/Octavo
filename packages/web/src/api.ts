export interface NoteSummary {
  path: string;
  name: string;
  folder: string;
  tags: string[];
  mtime: number;
  ctime: number;
  size: number;
  /** Locked (encrypted) note. */
  encrypted?: boolean;
}

export type QueryValue = string | number | boolean | null | QueryValue[];

export interface QueryResult {
  view: 'table' | 'list' | 'cards';
  showName: boolean;
  columns: { label: string; property?: string }[];
  rows: { path: string; name: string; values: QueryValue[]; group?: QueryValue }[];
  total: number;
  grouped: boolean;
  errors: string[];
}

export interface LinkRef {
  target: string;
  path: string | null;
  heading?: string;
  alias?: string;
  embed: boolean;
  line: number;
}

export interface Backlink {
  path: string;
  name: string;
  context: { line: number; text: string }[];
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface NoteDetail extends NoteSummary {
  content: string;
  frontmatter: Record<string, unknown>;
  aliases: string[];
  headings: Heading[];
  links: LinkRef[];
  backlinks: Backlink[];
}

export interface SearchResult {
  path: string;
  name: string;
  score: number;
  tags: string[];
  mtime: number;
  snippets: { line: number; text: string }[];
}

export interface GraphNode {
  id: string;
  name: string;
  tags: string[];
  unresolved?: boolean;
  /** Locked (encrypted) note. */
  encrypted?: boolean;
  /** Frontmatter `region` override (frontal, parietal, temporal, occipital, cerebellum, stem). */
  region?: string;
  /** Tagged #surprise or `surprise: true`: its links are highlighted in the atlas. */
  surprise?: boolean;
  degree: number;
  /** Creation time (ms): frontmatter `created`/`date`, else the file's ctime. Not on unresolved nodes. */
  created?: number;
  /** Id of the island the note belongs to (see Island): drawn apart from the six regions, in the island's colour. */
  island?: string;
}

/** A part of the vault kept apart from the six regions, e.g. a "Theology" folder. */
/** A folder from another app kept in step with the vault (Settings → Notes from other apps). */
export interface SyncFolder {
  source: string;
  into: string;
  exists: boolean;
  running: boolean;
  last: { at: string; added: string[]; updated: string[]; unchanged: number; errors: string[] } | null;
}

/** Daily automatic backups into a folder next to the vault. */
export interface AutoBackup {
  on: boolean;
  keep: number;
  folder: string;
  last: { name: string; at: string } | null;
  error?: string;
}

export interface Island {
  id: string;
  name: string;
  folder: string;
  /** "#rrggbb" */
  color: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: { source: string; target: string }[];
  /** Islands defined for the vault (absent or empty when there are none). */
  islands?: Island[];
  /** Notes placed by hand in the network view, by path. */
  pins?: Record<string, NotePin>;
}

/** A hand placement in brain units (the main brain spans about -1..1): a spot, or beside another note. */
export type NotePin = { x: number; y: number } | { near: string; dx: number; dy: number };

export interface TagCount {
  tag: string;
  count: number;
}

export type VaultEvent =
  | { type: 'change'; path: string; graphChanged?: boolean }
  | { type: 'delete'; path: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'rescan' }
  | { type: 'access'; path: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'octavo.token';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

function encodePath(p: string): string {
  return p
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

// ---------------------------------------------------------------- offline (saved copies from the service worker)

let offline = false;
const offlineListeners = new Set<(v: boolean) => void>();
function setOffline(v: boolean) {
  if (v === offline) return;
  offline = v;
  offlineListeners.forEach((f) => f(v));
}
/** Notified when the app starts or stops showing saved (offline) copies. */
export function onOffline(f: (v: boolean) => void): () => void {
  offlineListeners.add(f);
  f(offline);
  return () => offlineListeners.delete(f);
}
export const isOffline = () => offline;

export class OfflineError extends Error {
  constructor() {
    super('Octavo can’t reach your computer right now, so changes can’t be saved. Your edit is still on screen; try again when you’re back online.');
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await send(method, url, body);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText, data);
  return data as T;
}

/** The raw JSON text of a response, for callers that skip parsing when it hasn't changed. */
async function requestText(method: string, url: string): Promise<string> {
  const res = await send(method, url);
  const text = await res.text();
  if (!res.ok) {
    let data: { error?: string } = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, data.error ?? res.statusText, data);
  }
  return text;
}

async function send(method: string, url: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    if (method !== 'GET' || !navigator.onLine) {
      setOffline(true);
      throw new OfflineError();
    }
    throw err;
  }
  setOffline(res.headers.get('X-Octavo-Offline') === '1');
  return res;
}

export const api = {
  vault: () => request<{ name: string; noteCount: number; dailyFolder: string }>('GET', 'api/vault'),
  notes: () => request<{ notes: NoteSummary[]; folders: string[] }>('GET', 'api/notes'),
  note: (p: string) => request<NoteDetail>('GET', `api/notes/${encodePath(p)}`),
  save: (p: string, content: string, expectedMtime?: number) =>
    request<NoteSummary>('PUT', `api/notes/${encodePath(p)}`, { content, expectedMtime }),
  create: (p: string, content = '') => request<NoteSummary>('POST', 'api/notes', { path: p, content }),
  remove: (p: string) => request<{ path: string; trashedTo: string }>('DELETE', `api/notes/${encodePath(p)}`),
  rename: (from: string, to: string) =>
    request<{ from: string; to: string; updatedNotes: string[]; updatedLinks: number }>('POST', 'api/rename', {
      from,
      to,
    }),
  merge: (from: string, into: string) =>
    request<{ from: string; into: string; updatedNotes: string[]; updatedLinks: number; trashedTo: string }>('POST', 'api/merge', { from, into }),
  restoreTrashed: (trashPath: string) => request<NoteSummary>('POST', 'api/trash/restore', { trashPath }),
  resolve: (link: string, from?: string) =>
    request<{ path: string | null; trashed?: { trashPath: string; originalPath: string } }>(
      'GET',
      `api/resolve?link=${encodeURIComponent(link)}${from ? `&from=${encodeURIComponent(from)}` : ''}`,
    ),
  search: (q: string) => request<{ results: SearchResult[] }>('GET', `api/search?q=${encodeURIComponent(q)}`),
  tags: () => request<{ tags: TagCount[] }>('GET', 'api/tags'),
  /** The graph (GraphData) as JSON text: compare it with the last one before parsing. */
  graphText: () => requestText('GET', 'api/graph'),
  islands: () => request<{ islands: Island[] }>('GET', 'api/islands'),
  setIslands: (islands: Partial<Island>[]) => request<{ islands: Island[] }>('PUT', 'api/islands', { islands }),
  setPins: (pins: Record<string, NotePin | null>) => request<{ pins: Record<string, NotePin> }>('PUT', 'api/pins', { pins }),
  clearPins: () => request<{ pins: Record<string, NotePin> }>('PUT', 'api/pins', { clear: true }),
  autoBackup: () => request<AutoBackup>('GET', 'api/autobackup'),
  syncFolders: () => request<{ folders: SyncFolder[] }>('GET', 'api/folder-sync'),
  syncNow: () => request<{ folders: SyncFolder[] }>('POST', 'api/folder-sync/run'),
  setAutoBackup: (change: { on?: boolean; keep?: number }) => request<AutoBackup>('PUT', 'api/autobackup', change),
  backupNow: () => request<AutoBackup>('POST', 'api/autobackup/now'),
  daily: () => request<NoteSummary>('POST', 'api/daily'),
  snippets: () => request<{ folder: string; snippets: { name: string; css: string }[] }>('GET', 'api/snippets'),
  periodic: (period: 'day' | 'week' | 'month', date?: string) =>
    request<NoteSummary>('POST', `api/periodic/${period}${date ? `?date=${encodeURIComponent(date)}` : ''}`),
  upload: async (file: File, folder = 'attachments'): Promise<{ path: string }> => {
    const headers: Record<string, string> = { 'Content-Type': file.type || 'application/octet-stream' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`api/attachments?name=${encodeURIComponent(file.name || 'pasted.png')}&folder=${encodeURIComponent(folder)}`, {
      method: 'POST',
      headers,
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText, data);
    return data as { path: string };
  },
  history: (p: string) => request<{ versions: Version[] }>('GET', `api/history/${encodePath(p)}`),
  version: (p: string, id: string) => request<{ content: string }>('GET', `api/history/${encodePath(p)}?id=${encodeURIComponent(id)}`),
  restore: (p: string, id: string) => request<NoteSummary>('POST', 'api/restore', { path: p, id }),
  mentions: (p: string) => request<{ mentions: Backlink[] }>('GET', `api/mentions/${encodePath(p)}`),
  insights: () => request<Insights>('GET', 'api/insights'),
  tasks: (done = false) => request<{ tasks: Task[] }>('GET', `api/tasks${done ? '?done=1' : ''}`),
  query: (q: string, opts: { lang?: 'base' | 'dql'; from?: string } = {}) =>
    request<QueryResult>('GET', `api/query?q=${encodeURIComponent(q)}${opts.lang ? `&lang=${opts.lang}` : ''}${opts.from ? `&from=${encodeURIComponent(opts.from)}` : ''}`),
  canvases: () => request<{ canvases: string[] }>('GET', 'api/canvases'),
  canvas: (p: string) => request<{ path: string; data: { nodes: unknown[]; edges: unknown[] }; mtime: number }>('GET', `api/canvas/${p.split('/').map(encodeURIComponent).join('/')}`),
  saveCanvas: (p: string, data: unknown, expectedMtime?: number, createOnly = false) =>
    request<{ path: string; mtime: number }>('PUT', `api/canvas/${p.split('/').map(encodeURIComponent).join('/')}`, { data, expectedMtime, createOnly }),
  drawings: () => request<{ drawings: string[] }>('GET', 'api/drawings'),
  drawing: (p: string) => request<{ path: string; data: Record<string, unknown>; mtime: number }>('GET', `api/drawing/${p.split('/').map(encodeURIComponent).join('/')}`),
  saveDrawing: (p: string, data: unknown, expectedMtime?: number, createOnly = false) =>
    request<{ path: string; mtime: number }>('PUT', `api/drawing/${p.split('/').map(encodeURIComponent).join('/')}`, { data, expectedMtime, createOnly }),
  webRead: (url: string) => request<{ url: string; title: string; siteName?: string; byline?: string; excerpt?: string; html: string; markdown: string }>('GET', `api/web/read?url=${encodeURIComponent(url)}`),
  webClip: (url: string, folder?: string) => request<NoteSummary>('POST', 'api/web/clip', { url, folder }),
  append: (p: string, text: string, heading?: string) => request<NoteSummary>('POST', 'api/append', { path: p, text, heading }),
  setProperty: (p: string, key: string, value: unknown) => request<NoteSummary>('POST', 'api/property', { path: p, key, value }),
  setTask: (p: string, line: number, status?: string) => request<NoteSummary>('POST', 'api/tasks', { path: p, line, status }),
  getConfig: <T,>(name: string) => request<{ value: T | null }>('GET', `api/config/${name}`),
  setConfig: (name: string, value: unknown) => request<{ ok: boolean }>('PUT', `api/config/${name}`, { value }),
};

export interface Version {
  id: string;
  time: number;
  size: number;
}

export interface Insights {
  orphans: NoteSummary[];
  deadEnds: NoteSummary[];
  unresolved: { target: string; from: string[] }[];
}

export interface Task {
  path: string;
  name: string;
  line: number;
  status: string;
  text: string;
  /** YYYY-MM-DD, from "📅 2026-11-10" in the task text. */
  due?: string;
}

export type Bookmark =
  | { type: 'note'; path: string; heading?: string; title?: string }
  | { type: 'search'; query: string; title?: string }
  | { type: 'url'; url: string; title?: string };

/** Subscribe to live vault changes. Reconnects automatically. */
export function subscribe(onEvent: (e: VaultEvent) => void, onStatus?: (connected: boolean) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = () => {
    const token = getToken();
    es = new EventSource(`api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    es.onopen = () => onStatus?.(true);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {
        /* ignore malformed */
      }
    };
    es.onerror = () => {
      onStatus?.(false);
      es?.close();
      if (!closed) retry = setTimeout(connect, 2000);
    };
  };
  connect();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    es?.close();
  };
}

/** Ask the service worker to save every note on this device for offline reading. */
export async function saveAllForOffline(paths: string[], onProgress: (done: number, total: number) => void): Promise<boolean> {
  const reg = await navigator.serviceWorker?.getRegistration();
  const sw = reg?.active;
  if (!sw) return false;
  const base = new URL('./', location.href);
  const urls = [
    'api/vault',
    'api/notes',
    'api/graph',
    'api/tags',
    'api/tasks',
    'api/tasks?done=1',
    'api/config/bookmarks',
    'api/config/settings',
    ...paths.map((p) => `api/notes/${encodePath(p)}`),
  ].map((u) => new URL(u, base).toString());
  const listener = (e: MessageEvent) => {
    if (e.data?.type === 'octavo:save-progress') onProgress(e.data.done, e.data.total);
  };
  navigator.serviceWorker.addEventListener('message', listener);
  setTimeout(() => navigator.serviceWorker.removeEventListener('message', listener), 10 * 60 * 1000);
  sw.postMessage({ type: 'octavo:save-all', urls, token: getToken() });
  return true;
}
