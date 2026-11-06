import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VERSION } from './version.js';
import { formatDate, REGION_INFO, type NoteSummary, type RegionKey, type Vault } from '@octavo/core';

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
    for (const n of vault.list()) {
      const r = vault.regionOf(n.path).region;
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    return REGION_INFO.filter((r) => counts.get(r.key)).map((r) => `${r.label} ${counts.get(r.key)}`).join(', ') || 'none';
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
