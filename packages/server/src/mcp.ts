import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VERSION } from './version.js';
import { formatDate, formatQueryResult, REGION_INFO, type CanvasData, type CanvasNode, type NoteSummary, type RegionKey, type Vault } from '@octavo/core';

export const SERVER_INSTRUCTIONS = `Octavo is your long-term memory: a vault of interlinked Markdown notes that persists between conversations and that the user can also browse and edit in an Obsidian-like app.

How to use it:
- At the start of a task, call get_vault_overview (once per conversation), then search_notes for the people, projects and topics involved. Read the most relevant notes before answering.
- Save things worth remembering: decisions, facts about the user and their preferences, project context, and lessons learned. Update an existing note with append_to_note or edit_note rather than creating near-duplicates; search first.
- Keep one topic per note, give it a clear name, and connect notes with [[wikilinks]] (e.g. [[Project Octavo]]) and #tags. Linking to a note that doesn't exist yet is fine: it marks a topic to fill in later.
- Use log_to_journal for a short running log of what happened in each session.
- Now and then, use random_note to resurface an older note: it may be relevant again, out of date, or worth linking to something new.
- The app draws the vault as a brain, and folders decide the region: Projects/ and Decisions/ (frontal), Concepts/ and Tools/ (parietal), People/ and Orgs/ (temporal), Sources/, Repos/ and Reading/ (occipital), Journal/ and Logs/ (cerebellum), Home/Index notes (brain stem). Put new notes in the matching folder. read_note shows each note's region and why; get_note_region and set_note_region check or pin it.
- Note paths are relative to the vault, e.g. "Projects/Octavo.md". The .md extension is optional, and a bare note name like "Octavo" resolves the same way a wikilink would.
- Notes marked 🔒 locked are encrypted by the user. You can't read, edit or delete them, and you shouldn't try to infer their contents.
- Never store secrets such as passwords or API keys in the vault.`;

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function summaryLine(n: NoteSummary): string {
  const tags = n.tags.length ? ` ${n.tags.map((t) => '#' + t).join(' ')}` : '';
  return `- ${n.path}${n.encrypted ? ' 🔒 locked' : ''} (updated ${fmtDate(n.mtime)})${tags}`;
}

type Handler<A> = (args: A) => Promise<ReturnType<typeof text>>;
function safe<A>(fn: Handler<A>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

export function createMcpServer(vault: Vault, opts: { readOnly?: boolean } = {}): McpServer {
  const server = new McpServer(
    { name: 'octavo', version: VERSION },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {} } },
  );

  const pathArg = z.string().describe('Note path relative to the vault (e.g. "Projects/Octavo.md") or a note name.');
  const regionArg = z.enum(['frontal', 'parietal', 'temporal', 'occipital', 'cerebellum', 'stem']);
  const regionLabel = (k: RegionKey) => REGION_INFO.find((r) => r.key === k)!.label;
  const regionCounts = () => {
    const counts = new Map<RegionKey, number>();
    const islandCounts = new Map<string, number>();
    for (const n of vault.list()) {
      const r = vault.regionOf(n.path);
      if (r.island) islandCounts.set(r.island.name, (islandCounts.get(r.island.name) ?? 0) + 1);
      else counts.set(r.region, (counts.get(r.region) ?? 0) + 1);
    }
    const regions = REGION_INFO.filter((r) => counts.get(r.key)).map((r) => `${r.label} ${counts.get(r.key)}`).join(', ') || 'none';
    // Islands are kept apart from the regions in the brain views (see manage_islands).
    const islands = vault.islands().map((i) => `${i.name} ${islandCounts.get(i.name) ?? 0} (folder ${i.folder}/)`);
    return islands.length ? `${regions}\nIslands (kept apart): ${islands.join(', ')}` : regions;
  };
  /** The full text of a note, with its region, links and backlinks; also lights it up in the app's trail. */
  const noteText = async (path: string) => {
    if (!vault.resolve(path)) {
      const t = await vault.findInTrash(path);
      if (t) throw new Error(`"${path}" isn't in the vault, but a deleted note with that name is in the trash (${t.trashPath}, originally ${t.originalPath}). Use restore_note to bring it back.`);
    }
    vault.noteAccessed(path);
    if (vault.isEncrypted(path)) {
      return `${vault.resolve(path)} is a locked (encrypted) note. Its contents are only readable by the user after unlocking it in the Octavo app, so don't guess at what it contains. Ask the user if you need information from it.`;
    }
    const n = await vault.read(path);
    const region = vault.regionOf(n.path);
    const out = n.links.length ? n.links.map((l) => `- [[${l.target}]] → ${l.path ?? '(not created yet)'}`).join('\n') : '(none)';
    const back = n.backlinks.length ? n.backlinks.map((b) => `- ${b.path}: ${b.context.map((c) => c.text).join(' | ')}`).join('\n') : '(none)';
    return `# ${n.path}\nUpdated ${fmtDate(n.mtime)} · Brain region: ${region.label} (${region.reason})\n\n${n.content}\n\n---\nOutgoing links:\n${out}\n\nBacklinks:\n${back}`;
  };

  server.registerTool(
    'get_vault_overview',
    {
      title: 'Vault overview',
      description:
        'Get a map of the memory vault: number of notes, folders, top tags, recently updated notes, and the home note (Home.md/Index.md) if present. Call this first in a new conversation.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const o = vault.overview();
      const parts = [
        `Vault "${o.name}": ${o.noteCount} notes. (Octavo ${VERSION})`,
        `Folders: ${o.folders.map((f) => `${f.folder} (${f.count})`).join(', ') || 'none'}`,
        `Top tags: ${o.topTags.map((t) => `#${t.tag} (${t.count})`).join(', ') || 'none'}`,
        `Brain regions: ${regionCounts()}`,
        `Recently updated:\n${o.recent.map(summaryLine).join('\n') || '(none)'}`,
        o.home ? `Home note (${o.home.path}):\n\n${o.home.content}` : 'No home note yet. Consider creating Home.md as an index.',
      ];
      return text(parts.join('\n\n'));
    }),
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description:
        'Full-text search across all notes. All words must match (in title, tags, or body). Supports "exact phrases", tag:name or #name filters, and path:folder filters. Returns paths, matching lines and tags.',
      inputSchema: {
        query: z.string().describe('Search query, e.g. `octavo deploy`, `"api key rotation"`, `tag:person`, `path:Projects mcp`'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10)'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ query, limit }) => {
      const results = vault.search(query, limit ?? 10);
      if (results.length === 0) return text(`No notes match "${query}".`);
      return text(
        results
          .map((r) => {
            const tags = r.tags.length ? ` ${r.tags.map((t) => '#' + t).join(' ')}` : '';
            const snips = r.snippets.map((s) => `    L${s.line}: ${s.text}`).join('\n');
            return `- ${r.path}${tags}${snips ? '\n' + snips : ''}`;
          })
          .join('\n'),
      );
    }),
  );

  server.registerTool(
    'read_note',
    {
      title: 'Read note',
      description: 'Read a note\'s full Markdown content plus its outgoing links and backlinks (notes that link to it).',
      inputSchema: { path: pathArg },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ path }) => text(await noteText(path))),
  );

  server.registerTool(
    'random_note',
    {
      title: 'Random note',
      description:
        'Pick a random note and read it, to rediscover memories instead of only recent ones. By default notes that haven\'t been updated in a long time are more likely; `favor` "unlinked" picks notes few others link to (good for connecting forgotten notes), "both" combines the two, "none" gives an even chance. Optionally limit to a folder, tag or brain region.',
      inputSchema: {
        folder: z.string().optional(),
        tag: z.string().optional(),
        region: regionArg.optional(),
        favor: z.enum(['old', 'unlinked', 'both', 'none']).optional().describe('Which notes are likelier: old (default), unlinked, both or none'),
        prefer_old: z.boolean().optional().describe('Deprecated: use favor'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ folder, tag, region, prefer_old, favor }) => {
      const n = vault.randomNote({ folder, tag, region, preferOld: prefer_old, favor });
      if (!n) return text('No notes match.');
      return text(await noteText(n.path));
    }),
  );

  server.registerTool(
    'find_orphans',
    {
      title: 'Find orphans, dead ends and missing notes',
      description:
        'Help tend the vault: orphans are notes nothing links to, dead ends are notes that link nowhere, and missing notes are links to notes that don\'t exist yet (with how many notes point to each). Optionally limit to a folder.',
      inputSchema: {
        kind: z.enum(['orphans', 'dead_ends', 'missing', 'all']).optional().describe('Which list (default all)'),
        folder: z.string().optional().describe('Only notes in this folder'),
        limit: z.number().int().min(1).max(500).optional().describe('Max per list (default 50)'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ kind = 'all', folder, limit = 50 }) => {
      const ins = vault.insights();
      const f = folder ? folder.replace(/^\/+|\/+$/g, '') + '/' : '';
      const inFolder = (p: string) => !f || p.startsWith(f);
      const parts: string[] = [];
      const list = (title: string, items: string[], total: number) =>
        parts.push(`${title} (${total}):\n${items.length ? items.join('\n') : '(none)'}${total > items.length ? `\n…and ${total - items.length} more` : ''}`);
      if (kind === 'all' || kind === 'orphans') {
        const o = ins.orphans.filter((n) => inFolder(n.path));
        list('Orphans: nothing links to them', o.slice(0, limit).map((n) => `- ${n.path}`), o.length);
      }
      if (kind === 'all' || kind === 'dead_ends') {
        const d = ins.deadEnds.filter((n) => inFolder(n.path));
        list('Dead ends: they link nowhere', d.slice(0, limit).map((n) => `- ${n.path}`), d.length);
      }
      if (kind === 'all' || kind === 'missing') {
        const m = ins.unresolved.filter((u) => u.from.some(inFolder));
        list('Missing notes: linked but not written yet', m.slice(0, limit).map((u) => `- [[${u.target}]] ← ${u.from.length} note(s): ${u.from.slice(0, 3).join(', ')}${u.from.length > 3 ? ', …' : ''}`), m.length);
      }
      return text(parts.join('\n\n'));
    }),
  );

  server.registerTool(
    'query_notes',
    {
      title: 'Query notes like a database',
      description:
        'Find notes by folder, tag, links and properties, and get a table back. Dataview-style: `TABLE status, due FROM "Projects" AND #active WHERE status != "done" SORT due ASC LIMIT 20`, `LIST FROM [[Octavo]]` (notes linking to it), `TABLE file.mtime FROM #person SORT file.mtime DESC`, `LIST WHERE due < date(today)`, `TABLE status FROM #project GROUP BY status`. Fields are properties (frontmatter) and inline `key:: value` fields, plus file.name, file.path, file.folder, file.tags, file.mtime, file.ctime, file.size, file.links, file.inlinks. Functions: contains, startswith, endswith, length, lower, upper, default, number, round, exists, date(today|yesterday|tomorrow|YYYY-MM-DD), dur(7 days), days(date). A YAML base (from/where/columns/sort/group/limit) also works. Notes can embed the same query live in a ```query block.',
      inputSchema: {
        query: z.string().describe('The query'),
        max_rows: z.number().int().min(1).max(1000).optional().describe('Max rows to return (default 200)'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ query, max_rows }) => text(formatQueryResult(vault.query(query), { maxRows: max_rows ?? 200 }))),
  );

  server.registerTool(
    'read_canvas',
    {
      title: 'Read a canvas',
      description:
        'Read a .canvas board (JSON Canvas format): its cards (text, notes, links, groups) with ids, and the arrows between them. Without a path, lists the canvases in the vault.',
      inputSchema: { path: z.string().optional().describe('Canvas path or name, e.g. "Ideas board"') },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ path: p }) => {
      if (!p) {
        const list = vault.canvases();
        return text(list.length ? `Canvases (${list.length}):\n${list.map((c) => `- ${c}`).join('\n')}` : 'No canvases yet. add_to_canvas creates one.');
      }
      const { path: rel, data } = await vault.readCanvas(p);
      const label = (n: (typeof data.nodes)[number]) =>
        n.type === 'text' ? JSON.stringify(n.text.length > 120 ? n.text.slice(0, 120) + '…' : n.text) : n.type === 'file' ? `[[${n.file.replace(/\.md$/, '')}]]` : n.type === 'link' ? n.url : `group "${n.label ?? ''}"`;
      const byId = new Map(data.nodes.map((n) => [n.id, n]));
      const lines = [`Canvas ${rel}: ${data.nodes.length} card(s), ${data.edges.length} arrow(s)`, '', 'Cards:'];
      for (const n of data.nodes) lines.push(`- ${n.id} (${n.type}${n.color ? `, colour ${n.color}` : ''}) ${label(n)}`);
      if (data.edges.length) {
        lines.push('', 'Arrows:');
        for (const e of data.edges) {
          const a = byId.get(e.fromNode);
          const b = byId.get(e.toNode);
          lines.push(`- ${e.fromNode} → ${e.toNode}${e.label ? ` "${e.label}"` : ''}${a && b ? `  (${label(a).slice(0, 40)} → ${label(b).slice(0, 40)})` : ''}`);
        }
      }
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'get_note_region',
    {
      title: 'Brain region of a note',
      description:
        'Which brain region a note is drawn in, and why (its properties, folder, tags or name). Regions: frontal (projects, decisions), parietal (concepts, tools), temporal (people, orgs), occipital (sources, reading), cerebellum (journal, logs), stem (home, index).',
      inputSchema: { path: pathArg },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ path }) => {
      const r = vault.regionOf(path);
      if (r.island) return text(`${vault.resolve(path)} is on the “${r.island.name}” island (folder ${r.island.folder}/), drawn apart from the six regions. Without the island it would be in the ${r.label} region (${r.region}): ${r.reason}.`);
      return text(`${vault.resolve(path)} is in the ${r.label} region (${r.region}): ${r.reason}.`);
    }),
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description: 'List notes, optionally filtered by folder and/or tag. Sorted by most recently updated.',
      inputSchema: {
        folder: z.string().optional().describe('Only notes in this folder (including subfolders)'),
        tag: z.string().optional().describe('Only notes with this tag (nested tags match their parent)'),
        limit: z.number().int().min(1).max(500).optional().describe('Max results (default 50)'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ folder, tag, limit }) => {
      const notes = vault
        .list({ folder, tag })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit ?? 50);
      return text(notes.length ? notes.map(summaryLine).join('\n') : 'No matching notes.');
    }),
  );

  server.registerTool(
    'get_backlinks',
    {
      title: 'Get backlinks',
      description: 'List the notes that link to a given note, with the lines containing each link.',
      inputSchema: { path: pathArg },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ path }) => {
      const bl = vault.backlinks(path);
      if (!bl.length) return text('No notes link here yet.');
      return text(bl.map((b) => `- ${b.path}\n${b.context.map((c) => `    L${c.line}: ${c.text}`).join('\n')}`).join('\n'));
    }),
  );

  server.registerTool(
    'get_related',
    {
      title: 'Get related notes',
      description:
        'Find notes related to a given note through direct links, backlinks, shared tags, and 2-hop links. Useful for pulling in surrounding context.',
      inputSchema: { path: pathArg, limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ path, limit }) => {
      const rel = vault.related(path, limit ?? 10);
      if (!rel.length) return text('No related notes found.');
      return text(rel.map((r) => `- ${r.path} (score ${r.score}): ${r.reasons.join('; ')}`).join('\n'));
    }),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description: 'List all tags in the vault with how many notes use each.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const tags = vault.tags();
      return text(tags.length ? tags.map((t) => `#${t.tag} (${t.count})`).join('\n') : 'No tags yet.');
    }),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List Markdown tasks (`- [ ] ...`) across the vault, with the note path and line number of each. Open tasks only unless include_done is true. ' +
        'Due dates are written in the task text as "📅 YYYY-MM-DD"; use `due` to get only overdue, today\'s or upcoming tasks (sorted by date). When adding a task with a deadline, include "📅 YYYY-MM-DD". ' +
        'By default only real to-dos are listed (`[ ]`, `[/]` in progress, `[!]` important); `status` "questions" lists `[?]` open questions, "all_open" anything not done or cancelled, "done" finished ones.',
      inputSchema: {
        include_done: z.boolean().optional().describe('Deprecated: use status "all" instead'),
        status: z
          .enum(['todo', 'questions', 'all_open', 'done', 'all'])
          .optional()
          .describe('todo (default): [ ] [/] [!] · questions: [?] · all_open: anything not done or cancelled · done: [x] [-] · all'),
        path: z.string().optional().describe('Only tasks from this note'),
        due: z
          .enum(['overdue', 'today', 'next_7_days', 'any_date', 'no_date'])
          .optional()
          .describe('Filter by due date: overdue (before today), today, next_7_days (today to a week from now), any_date (has a due date), no_date'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ include_done, status, path, due }) => {
      const only = path ? vault.resolve(path) : null;
      const today = formatDate(new Date());
      const week = formatDate(new Date(Date.now() + 7 * 86400000));
      const mode = status ?? (include_done ? 'all' : 'todo');
      const isDone = (c: string) => c === 'x' || c === 'X' || c === '-';
      const keep = (c: string) =>
        mode === 'all' ? true : mode === 'done' ? isDone(c) : mode === 'questions' ? c === '?' : mode === 'all_open' ? !isDone(c) : c === ' ' || c === '/' || c === '!';
      let tasks = vault
        .tasks({ includeDone: mode === 'all' || mode === 'done' })
        .filter((t) => (!path || t.path === only) && keep(t.status));
      if (due) {
        tasks = tasks.filter((t) => {
          if (due === 'no_date') return !t.due;
          if (!t.due) return false;
          if (due === 'overdue') return t.due < today;
          if (due === 'today') return t.due === today;
          if (due === 'next_7_days') return t.due >= today && t.due <= week;
          return true;
        });
        tasks.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
      }
      if (!tasks.length) return text('No tasks found.');
      return text(`Today is ${today}.\n` + tasks.map((t) => `- [${t.status}] ${t.text}  (${t.path}:${t.line})`).join('\n'));
    }),
  );

  if (opts.readOnly) return server;

  server.registerTool(
    'manage_islands',
    {
      title: 'Islands: keep parts of the vault apart',
      description:
        'Islands keep a separate subject apart in the brain views: every note in an island\'s folder gets its own territory and colour instead of being mixed into the six regions (e.g. a "Theology" folder in a vault that is mostly about software). A single note elsewhere can join an island with `region: <island name>` in its properties. Actions: "list" shows the islands; "add" makes a folder an island (name defaults to the folder name, colour is picked automatically or given as #rrggbb); "remove" takes an island by name or folder. Up to 12 islands.',
      inputSchema: {
        action: z.enum(['list', 'add', 'remove']),
        folder: z.string().optional().describe('For add: the folder, e.g. "Theology"'),
        name: z.string().optional().describe('For add: display name; for remove: the island to remove (name or folder)'),
        color: z.string().optional().describe('For add: colour as #rrggbb'),
      },
    },
    safe(async ({ action, folder, name, color }) => {
      const current = vault.islands();
      const describe = (list: typeof current) =>
        list.length ? list.map((i) => `- ${i.name}: folder ${i.folder}/ (${vault.list({ folder: i.folder }).length} notes), colour ${i.color}`).join('\n') : '(none)';
      if (action === 'list') return text(`Islands:\n${describe(current)}`);
      if (action === 'add') {
        if (!folder) throw new Error('add needs a folder');
        const clean = folder.replace(/^\/+|\/+$/g, '');
        if (!vault.folders().some((f) => f.toLowerCase() === clean.toLowerCase())) throw new Error(`No folder called “${clean}” in the vault`);
        const saved = await vault.setIslands([...current, { folder: clean, name, color }]);
        return text(`Added. Islands:\n${describe(saved)}`);
      }
      const want = (name ?? folder ?? '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
      const keep = current.filter((i) => i.name.toLowerCase() !== want && i.folder.toLowerCase() !== want && i.id !== want);
      if (keep.length === current.length) throw new Error(`No island called “${name ?? folder}”`);
      const saved = await vault.setIslands(keep);
      return text(`Removed. Islands:\n${describe(saved)}`);
    }),
  );


  server.registerTool(
    'add_to_canvas',
    {
      title: 'Add cards and arrows to a canvas',
      description:
        'Add cards to a .canvas board (created if it doesn\'t exist) and connect them with arrows. Each card is one of: text (Markdown), note (a note path, shown live), url (a web link). Give cards a "key" so connections can refer to them; connections can also use ids from read_canvas. Cards are laid out automatically in a new column to the right unless x/y are given. Optionally wrap the new cards in a labelled group. Colours: "1" red, "2" orange, "3" yellow, "4" green, "5" cyan, "6" purple.',
      inputSchema: {
        canvas: z.string().describe('Canvas path or name'),
        cards: z
          .array(
            z.object({
              key: z.string().optional().describe('Your name for this card, for connections'),
              text: z.string().optional(),
              note: z.string().optional(),
              url: z.string().optional(),
              color: z.string().optional(),
              x: z.number().optional(),
              y: z.number().optional(),
              width: z.number().optional(),
              height: z.number().optional(),
            }),
          )
          .max(200)
          .optional(),
        connections: z
          .array(z.object({ from: z.string(), to: z.string(), label: z.string().optional(), color: z.string().optional() }))
          .max(400)
          .optional(),
        group: z.string().optional().describe('Put the new cards in a group with this label'),
      },
    },
    safe(async ({ canvas, cards = [], connections = [], group }) => {
      let rel: string;
      let data: CanvasData;
      try {
        const r = await vault.readCanvas(canvas);
        rel = r.path;
        data = r.data;
      } catch (err) {
        if (!(err instanceof Error) || err.name !== 'NoteNotFoundError') throw err;
        rel = canvas;
        data = { nodes: [], edges: [] };
      }
      const id = () => Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
      const keyToId = new Map<string, string>();
      const right = data.nodes.length ? Math.max(...data.nodes.map((n) => n.x + n.width)) + 120 : 0;
      const top = data.nodes.length ? Math.min(...data.nodes.map((n) => n.y)) : 0;
      let y = top;
      const added: CanvasNode[] = [];
      const skipped: string[] = [];
      for (const c of cards) {
        const kinds = [c.text !== undefined, !!c.note, !!c.url].filter(Boolean).length;
        if (kinds !== 1) {
          skipped.push(`${c.key ?? '(card)'}: give exactly one of text, note or url`);
          continue;
        }
        const width = c.width ?? (c.note ? 400 : c.url ? 360 : 300);
        const height = c.height ?? (c.note ? 320 : c.url ? 120 : Math.min(480, 80 + Math.ceil((c.text ?? '').length / 38) * 24));
        const base = { id: id(), x: c.x ?? right, y: c.y ?? y, width, height, ...(c.color ? { color: c.color } : {}) };
        let node: CanvasNode;
        if (c.note) {
          const p = vault.resolve(c.note);
          if (!p) {
            skipped.push(`${c.key ?? c.note}: no note called "${c.note}"`);
            continue;
          }
          node = { ...base, type: 'file', file: p };
        } else if (c.url) node = { ...base, type: 'link', url: c.url };
        else node = { ...base, type: 'text', text: c.text ?? '' };
        if (c.y === undefined) y += height + 60;
        if (c.key) keyToId.set(c.key, node.id);
        added.push(node);
      }
      const nodes = [...data.nodes, ...added];
      if (group && added.length) {
        const pad = 40;
        const minX = Math.min(...added.map((n) => n.x)) - pad;
        const minY = Math.min(...added.map((n) => n.y)) - pad;
        const maxX = Math.max(...added.map((n) => n.x + n.width)) + pad;
        const maxY = Math.max(...added.map((n) => n.y + n.height)) + pad;
        nodes.unshift({ id: id(), type: 'group', label: group, x: minX, y: minY, width: maxX - minX, height: maxY - minY });
      }
      const ids = new Set(nodes.map((n) => n.id));
      const edges = [...data.edges];
      for (const c of connections) {
        const from = keyToId.get(c.from) ?? c.from;
        const to = keyToId.get(c.to) ?? c.to;
        if (!ids.has(from) || !ids.has(to)) {
          skipped.push(`connection ${c.from} → ${c.to}: unknown card`);
          continue;
        }
        edges.push({ id: id(), fromNode: from, toNode: to, toEnd: 'arrow', ...(c.label ? { label: c.label } : {}), ...(c.color ? { color: c.color } : {}) });
      }
      const saved = await vault.writeCanvas(rel, { ...data, nodes, edges });
      const keys = [...keyToId].map(([k, v]) => `${k}=${v}`).join(', ');
      return text(
        `${saved.path}: added ${added.length} card(s) and ${edges.length - data.edges.length} arrow(s).${keys ? ` Ids: ${keys}.` : ''}${skipped.length ? `\nSkipped:\n- ${skipped.join('\n- ')}` : ''}`,
      );
    }),
  );


  server.registerTool(
    'set_property',
    {
      title: 'Set a note property',
      description:
        'Set one property (frontmatter field) on a note without rewriting the rest, e.g. status: done or due: 2026-12-01. Lists are fine (["a", "b"]). Pass null to remove the property. Keeps the existing spelling of the key.',
      inputSchema: {
        path: z.string().describe('Note path or name'),
        key: z.string().min(1).max(100).describe('Property name'),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()])), z.null()]).describe('New value, or null to remove'),
      },
    },
    safe(async ({ path: p, key, value }) => {
      const r = await vault.setProperty(p, key, value);
      return text(value === null ? `Removed "${key}" from ${r.path}` : `Set ${key}: ${JSON.stringify(value)} on ${r.path}`);
    }),
  );


  server.registerTool(
    'write_note',
    {
      title: 'Write note',
      description:
        'Create a note, or replace an existing note\'s entire content. Prefer append_to_note or edit_note for small changes to existing notes. Folders are created as needed.',
      inputSchema: {
        path: pathArg,
        content: z.string().describe('Full Markdown content. Use [[wikilinks]] and #tags to connect it to other notes.'),
        create_only: z.boolean().optional().describe('Fail instead of overwriting if the note already exists'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    safe(async ({ path, content, create_only }) => {
      if (vault.isEncrypted(path)) throw new Error(`${vault.resolve(path)} is a locked note; it can't be overwritten. Write to a different note.`);
      const existed = vault.has(path);
      const s = create_only ? await vault.create(path, content) : await vault.write(path, content);
      return text(`${existed ? 'Updated' : 'Created'} ${s.path}`);
    }),
  );

  server.registerTool(
    'append_to_note',
    {
      title: 'Append to note',
      description:
        'Append Markdown to the end of a note, or to the end of a specific section when `heading` is given (the heading is added if missing). Creates the note if it doesn\'t exist.',
      inputSchema: {
        path: pathArg,
        content: z.string().describe('Markdown to append'),
        heading: z.string().optional().describe('Section heading to append under, e.g. "Decisions"'),
      },
    },
    safe(async ({ path, content, heading }) => {
      const s = await vault.append(path, content, { heading });
      return text(`Appended to ${s.path}${heading ? ` under "${heading}"` : ''}`);
    }),
  );

  server.registerTool(
    'edit_note',
    {
      title: 'Edit note',
      description:
        'Replace an exact piece of text in a note. old_text must match exactly once unless replace_all is true. Read the note first to copy the text exactly.',
      inputSchema: {
        path: pathArg,
        old_text: z.string().describe('Exact text to find'),
        new_text: z.string().describe('Replacement text'),
        replace_all: z.boolean().optional(),
      },
      annotations: { destructiveHint: true },
    },
    safe(async ({ path, old_text, new_text, replace_all }) => {
      const s = await vault.edit(path, old_text, new_text, { replaceAll: replace_all });
      return text(`Edited ${s.path} (${s.replacements} replacement${s.replacements === 1 ? '' : 's'})`);
    }),
  );

  server.registerTool(
    'rename_note',
    {
      title: 'Rename or move note',
      description: 'Rename or move a note. All links pointing to it are updated automatically.',
      inputSchema: { from: pathArg, to: z.string().describe('New vault-relative path, e.g. "Archive/Old Project.md"') },
      annotations: { destructiveHint: true },
    },
    safe(async ({ from, to }) => {
      const r = await vault.rename(from, to);
      return text(`Moved ${r.from} → ${r.to}; updated ${r.updatedLinks} link(s) in ${r.updatedNotes.length} note(s).`);
    }),
  );

  server.registerTool(
    'set_note_region',
    {
      title: 'Set brain region of a note',
      description:
        'Pin notes to a brain region by setting `region:` in their properties, or pass "auto" to place them by folder and tags again. Give one `path`, a list of `paths`, or a whole `folder` (including subfolders). Prefer putting notes in the matching folder; use this when notes belong somewhere their folder doesn\'t suggest.',
      inputSchema: {
        path: pathArg.optional(),
        paths: z.array(z.string()).max(2000).optional().describe('Several notes at once'),
        folder: z.string().optional().describe('Every note in this folder and its subfolders'),
        region: z.union([regionArg, z.literal('auto')]),
      },
    },
    safe(async ({ path, paths, folder, region }) => {
      const targets = new Set<string>();
      if (path) targets.add(path);
      for (const p of paths ?? []) targets.add(p);
      if (folder) for (const n of vault.list({ folder })) targets.add(n.path);
      if (!targets.size) throw new Error('Give a path, a list of paths, or a folder.');
      const done: string[] = [];
      const skipped: string[] = [];
      for (const t of targets) {
        const rel = vault.resolve(t);
        if (!rel) skipped.push(`${t} (not found)`);
        else if (vault.isEncrypted(rel)) skipped.push(`${rel} (locked)`);
        else {
          try {
            await vault.setRegion(rel, region === 'auto' ? null : region);
            done.push(rel);
          } catch (err) {
            skipped.push(`${rel} (${(err as Error).message})`);
          }
        }
      }
      if (done.length === 1 && !skipped.length) {
        const r = vault.regionOf(done[0]);
        return text(`${done[0]} is now in the ${regionLabel(r.region)} region (${r.reason}).`);
      }
      const where = region === 'auto' ? 'placed automatically again' : `pinned to the ${regionLabel(region)} region`;
      return text(`${done.length} note(s) ${where}.${skipped.length ? `\nSkipped ${skipped.length}:\n${skipped.slice(0, 20).map((x) => `- ${x}`).join('\n')}` : ''}`);
    }),
  );

  server.registerTool(
    'restore_note',
    {
      title: 'Restore note from trash',
      description: 'Bring back a deleted note from the vault\'s .trash folder to where it was. Pass its old name or path (e.g. "Test" or "Projects/Test.md").',
      inputSchema: { path: z.string().describe('The deleted note\'s name or original path') },
    },
    safe(async ({ path }) => {
      const t = await vault.findInTrash(path);
      if (!t) throw new Error(`No deleted note called "${path}" is in the trash.`);
      const s = await vault.restore(t.trashPath);
      return text(`Restored ${s.path}.`);
    }),
  );

  server.registerTool(
    'merge_notes',
    {
      title: 'Merge notes',
      description:
        'Merge one note into another: the source\'s text is appended to the target under a heading, every link to the source is pointed at the target, and the source moves to .trash. Use to combine duplicate notes.',
      inputSchema: { from: pathArg.describe('Note to merge (it is removed afterwards)'), into: pathArg.describe('Note that receives the text') },
      annotations: { destructiveHint: true },
    },
    safe(async ({ from, into }) => {
      const r = await vault.merge(from, into);
      return text(`Merged ${r.from} into ${r.into}; updated ${r.updatedLinks} link(s) in ${r.updatedNotes.length} note(s). ${r.from} was moved to ${r.trashedTo}.`);
    }),
  );

  server.registerTool(
    'delete_note',
    {
      title: 'Delete note',
      description: 'Delete a note by moving it to the vault\'s .trash folder, where it can be recovered. Only do this when the user asks or the note is clearly obsolete.',
      inputSchema: { path: pathArg },
      annotations: { destructiveHint: true },
    },
    safe(async ({ path }) => {
      if (vault.isEncrypted(path)) throw new Error(`${vault.resolve(path)} is a locked note; only the user can delete it, from the Octavo app.`);
      const r = await vault.delete(path);
      return text(`Moved ${r.path} to ${r.trashedTo}`);
    }),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update task',
      description: 'Set the status of a task by note path and line number (from list_tasks). Status is one character: " " open, "x" done, "-" cancelled, "?" question, etc. Without status the task toggles between open and done.',
      inputSchema: {
        path: pathArg,
        line: z.number().int().min(1),
        status: z.string().length(1).optional(),
      },
    },
    safe(async ({ path, line, status }) => {
      const s = await vault.setTask(path, line, status);
      return text(`Updated task on line ${line} of ${s.path}`);
    }),
  );

  server.registerTool(
    'log_to_journal',
    {
      title: 'Log to journal',
      description:
        'Append a timestamped entry to today\'s daily journal note (Journal/YYYY-MM-DD.md). Use for a brief log of what was done, decided or learned in this session, with [[links]] to the relevant notes.',
      inputSchema: { entry: z.string().describe('What happened, in a sentence or a few lines') },
    },
    safe(async ({ entry }) => {
      const s = await vault.logToJournal(entry);
      return text(`Logged to ${s.path}`);
    }),
  );

  server.registerTool(
    'open_periodic_note',
    {
      title: 'Open daily, weekly or monthly note',
      description:
        'Return the note for today, this week or this month (Journal/YYYY-MM-DD.md, Journal/Weekly/YYYY-Www.md, Journal/Monthly/YYYY-MM.md), creating it from a template if needed. Use it to read or plan goals for the week or month; edit it with append_to_note or write_note.',
      inputSchema: { period: z.enum(['day', 'week', 'month']).describe('Which note: day, week or month') },
    },
    safe(async ({ period }) => {
      const s = await vault.ensurePeriodicNote(period);
      vault.noteAccessed(s.path);
      if (vault.isEncrypted(s.path)) return text(`${s.path} is a locked (encrypted) note; its contents are only readable in the Octavo app.`);
      const note = await vault.read(s.path);
      return text(`${s.path}\n\n${note.content}`);
    }),
  );

  return server;
}
