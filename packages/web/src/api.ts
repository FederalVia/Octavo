export interface NoteSummary {
  path: string;
  name: string;
  folder: string;
  tags: string[];
  mtime: number;
  ctime: number;
  size: number;
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
  degree: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: { source: string; target: string }[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export type VaultEvent =
  | { type: 'change'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'rescan' };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'ultron.token';

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

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText, data);
  return data as T;
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
  resolve: (link: string, from?: string) =>
    request<{ path: string | null }>(
      'GET',
      `api/resolve?link=${encodeURIComponent(link)}${from ? `&from=${encodeURIComponent(from)}` : ''}`,
    ),
  search: (q: string) => request<{ results: SearchResult[] }>('GET', `api/search?q=${encodeURIComponent(q)}`),
  tags: () => request<{ tags: TagCount[] }>('GET', 'api/tags'),
  graph: () => request<GraphData>('GET', 'api/graph'),
  daily: () => request<NoteSummary>('POST', 'api/daily'),
};

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
