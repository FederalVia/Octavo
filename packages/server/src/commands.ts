import { Vault, formatQueryResult } from '@octavo/core';
import path from 'node:path';
import { importEnex, importNotion } from './importers.js';
import { buildSite, writeSite } from './publish.js';
import { backupName, buildBackup } from './backup.js';
import fs from 'node:fs/promises';
import { parseSince } from './mcp.js';
import { defaultInto, syncFolder } from './folderSync.js';
import { connectClients } from './connect.js';
import { fileURLToPath } from 'node:url';

export const NOTE_COMMANDS_HELP = `Note commands (work directly on the vault folder; no server needed):
  octavo new <path> [--content TEXT]   Create a note (content from --content or stdin)
  octavo read <note>                   Print a note
  octavo append <note> <text…> [--heading H]
                                       Append text (under a heading if given)
  octavo search <query…> [--limit N]   Full-text search ("phrases", tag:x, path:y)
  octavo daily [text…]                 Print today's journal path, or log an entry to it
  octavo weekly | monthly               Print this week's / this month's note path (creating it)
  octavo task <text…>                  Add "- [ ] text" to today's journal
  octavo tasks [--done]                List open (or all) tasks across the vault
  octavo done <note> <line>            Toggle a task between open and done
  octavo tags                          List tags with counts
  octavo move <from> <to>              Rename or move a note, updating links
  octavo history <note>                List saved versions of a note
  octavo restore <note> <version-id>   Restore a saved version
  octavo orphans                       Notes nothing links to, and dead ends
  octavo recent [span|date]            Notes changed recently (default 1d; e.g. 12h, 3d, 2w, 2026-11-01)
  octavo query <query…>                Query notes, e.g. 'TABLE status FROM #project WHERE status != "done"'
  octavo set <note> <key> [value]      Set a property (no value removes it)
  octavo backup [file.zip] [--history] The whole vault as one zip (default: "<vault> backup <date>.zip")
  octavo theme [add <file.css|https-url> [--title NAME] | on | off | remove <name>]
                                       List CSS themes/snippets, install one (switched on), or toggle it
  octavo islands [add <folder> [--title NAME] | remove <name-or-folder>]
                                       List islands, or keep a folder apart in the brain views
  octavo publish <folder> [--all | --folder F | --tag T] [--title T]
                                       Build a static website from notes marked "publish: true"
                                       (or everything, a folder or a tag) into <folder>
  octavo connect [tool]                Setup for an AI tool: claude-code, claude-desktop, codex, cursor,
                                       windsurf, gemini, vscode, chatgpt (none: all of them)
  octavo sync-folder <folder> [--into F]
                                       Mirror a folder from another app (PDFs, images, Markdown) into the
                                       vault once; run again to bring in only what changed
  octavo import notion <folder> [--into F]
                                       Import an unzipped Notion "Markdown & CSV" export
  octavo import evernote <file.enex> [--into F]
                                       Import an Evernote export

Add --json to tasks, search, tags, history, orphans, recent or query for machine-readable output.`;

export const NOTE_COMMANDS = new Set([
  'new',
  'read',
  'append',
  'search',
  'daily',
  'weekly',
  'monthly',
  'import',
  'task',
  'tasks',
  'done',
  'tags',
  'move',
  'history',
  'restore',
  'orphans',
  'recent',
  'query',
  'set',
  'publish',
  'islands',
  'backup',
  'theme',
  'sync-folder',
  'connect',
]);

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function need(args: string[], n: number, usage: string): void {
  if (args.length < n) throw new Error(`Usage: octavo ${usage}`);
}

export interface NoteCommandOptions {
  content?: string;
  heading?: string;
  limit?: string;
  done?: boolean;
  json?: boolean;
  daily?: string;
  into?: string;
  port?: number;
  token?: string;
  all?: boolean;
  folder?: string;
  tag?: string;
  title?: string;
  history?: boolean;
}

/** Run a note command against the vault and print the result. */
export async function runNoteCommand(
  vaultPath: string,
  command: string,
  args: string[],
  opts: NoteCommandOptions,
): Promise<void> {
  const vault = await Vault.open(vaultPath, { watch: false, dailyFolder: opts.daily });
  const out = (v: unknown, plain: () => string) => console.log(opts.json ? JSON.stringify(v, null, 2) : plain());
  try {
    switch (command) {
      case 'new': {
        need(args, 1, 'new <path> [--content TEXT]');
        const content = opts.content ?? (await readStdin());
        const s = await vault.create(args[0], content || `# ${args[0].split('/').pop()!.replace(/\.md$/i, '')}\n\n`);
        console.log(s.path);
        break;
      }
      case 'read': {
        need(args, 1, 'read <note>');
        if (vault.isEncrypted(args.join(' '))) throw new Error(`${vault.resolve(args.join(' '))} is locked (encrypted). Unlock it in the Octavo app to read it.`);
        process.stdout.write((await vault.read(args.join(' '))).content);
        break;
      }
      case 'append': {
        need(args, 2, 'append <note> <text…>');
        const s = await vault.append(args[0], args.slice(1).join(' '), { heading: opts.heading });
        console.log(`Appended to ${s.path}`);
        break;
      }
      case 'search': {
        need(args, 1, 'search <query…>');
        const results = vault.search(args.join(' '), Number(opts.limit) || 20);
        out(results, () =>
          results.length
            ? results.map((r) => [r.path, ...r.snippets.map((sn) => `  ${sn.line}: ${sn.text}`)].join('\n')).join('\n')
            : 'No results.',
        );
        break;
      }
      case 'daily': {
        const s = args.length ? await vault.logToJournal(args.join(' ')) : await vault.ensureDailyNote();
        console.log(s.path);
        break;
      }
      case 'import': {
        need(args, 2, 'import notion <folder> | import evernote <file.enex> [--into Folder]');
        const [kind, source] = args;
        let r;
        if (kind === 'notion') r = await importNotion(vault, source, opts.into);
        else if (kind === 'evernote' || kind === 'enex') r = await importEnex(vault, source, opts.into);
        else throw new Error('Usage: octavo import notion <folder> | import evernote <file.enex> [--into Folder]');
        out(r, () => `Imported ${r.notes} note(s) and ${r.attachments} attachment(s) into ${r.folder || 'the vault'}.${r.skipped.length ? `\nSkipped:\n  ${r.skipped.join('\n  ')}` : ''}`);
        break;
      }
      case 'weekly':
      case 'monthly': {
        const s = await vault.ensurePeriodicNote(command === 'weekly' ? 'week' : 'month');
        console.log(s.path);
        break;
      }
      case 'task': {
        need(args, 1, 'task <text…>');
        const daily = await vault.ensureDailyNote();
        await vault.append(daily.path, `- [ ] ${args.join(' ')}`, { separator: 'line' });
        console.log(`Added task to ${daily.path}`);
        break;
      }
      case 'tasks': {
        const tasks = vault.tasks({ includeDone: opts.done });
        out(tasks, () => (tasks.length ? tasks.map((t) => `[${t.status}] ${t.text}  (${t.path}:${t.line})`).join('\n') : 'No tasks.'));
        break;
      }
      case 'done': {
        need(args, 2, 'done <note> <line>');
        const s = await vault.setTask(args[0], Number(args[1]));
        console.log(`Toggled task on line ${args[1]} of ${s.path}`);
        break;
      }
      case 'tags': {
        const tags = vault.tags();
        out(tags, () => tags.map((t) => `#${t.tag}  ${t.count}`).join('\n') || 'No tags.');
        break;
      }
      case 'move': {
        need(args, 2, 'move <from> <to>');
        const r = await vault.rename(args[0], args[1]);
        console.log(`Moved ${r.from} → ${r.to} (${r.updatedLinks} links updated)`);
        break;
      }
      case 'history': {
        need(args, 1, 'history <note>');
        const versions = await vault.history(args.join(' '));
        out(versions, () =>
          versions.length
            ? versions.map((v) => `${v.id}  ${new Date(v.time).toLocaleString()}  ${v.size} bytes`).join('\n')
            : 'No saved versions yet.',
        );
        break;
      }
      case 'restore': {
        need(args, 2, 'restore <note> <version-id>');
        const s = await vault.restoreVersion(args[0], args[1]);
        console.log(`Restored ${s.path} to version ${args[1]}`);
        break;
      }
      case 'backup': {
        const b = await buildBackup(vault, { history: opts.history });
        const file = path.resolve(args[0] ?? backupName(vault));
        const root = path.resolve(vault.root);
        if (file === root || file.startsWith(root + path.sep)) throw new Error('Save the backup outside the vault folder');
        await fs.writeFile(file, b.zip);
        console.log(`Backed up ${b.files} files (${(b.bytes / 1024 / 1024).toFixed(1)} MB) to ${file}`);
        break;
      }
      case 'connect': {
        const cliPath = path.resolve(fileURLToPath(import.meta.url), '..', 'cli.js');
        const info = {
          name: 'octavo',
          stdio: { command: 'node', args: [cliPath, 'mcp', '--vault', path.resolve(vault.root)] },
          httpUrl: `http://127.0.0.1:${opts.port ?? 4321}/mcp`,
          token: opts.token,
        };
        const want = (args[0] ?? '').toLowerCase();
        const clients = connectClients(info).filter((c) => !want || c.id === want || c.label.toLowerCase().includes(want));
        if (!clients.length) throw new Error(`No tool called "${args[0]}". Try: ${connectClients(info).map((c) => c.id).join(', ')}`);
        out(clients, () =>
          clients
            .map((c) => [`== ${c.label} ==`, c.about, ...c.snippets.flatMap((s) => ['', `-- ${s.title}${s.file ? ` (${s.file})` : ''}`, s.text])].join('\n'))
            .join('\n\n'),
        );
        break;
      }
      case 'sync-folder': {
        need(args, 1, 'sync-folder <folder> [--into F]');
        const source = path.resolve(args.join(' '));
        const root = path.resolve(vault.root);
        const rel = path.relative(root, source);
        if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('That folder is inside the vault already');
        const into = opts.into ?? defaultInto(source);
        const r = await syncFolder(vault, source, into);
        out(r, () =>
          [
            `Synced ${source} → ${into}/: ${r.added.length} added, ${r.updated.length} updated, ${r.unchanged} unchanged.`,
            ...r.errors.map((e) => `  ! ${e}`),
          ].join('\n'),
        );
        break;
      }
      case 'theme': {
        const [action, ...rest] = args;
        const target = rest.join(' ').trim();
        const dir = path.join(vault.root, '.octavo', 'snippets');
        const installed = async () => (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => /^[^./\\][^/\\]*\.css$/i.test(n)).sort();
        const enabled = async () => ((await vault.getConfig<string[] | null>('snippets', null)) ?? []).filter((n) => typeof n === 'string');
        const find = async (name: string) => {
          const want = name.toLowerCase().replace(/\.css$/, '');
          const hit = (await installed()).find((n) => n.toLowerCase().replace(/\.css$/, '') === want);
          if (!hit) throw new Error(`No theme called "${name}". Run "octavo theme" to list them.`);
          return hit;
        };
        if (!action || action === 'list') {
          const names = await installed();
          const on = new Set(await enabled());
          out(
            names.map((name) => ({ name, on: on.has(name) })),
            () => (names.length ? `Themes and CSS snippets (.octavo/snippets):\n${names.map((n) => `  ${on.has(n) ? '●' : '○'} ${n}`).join('\n')}` : 'No themes yet. Install one with: octavo theme add <file.css or https URL>'),
          );
          break;
        }
        if (action === 'add') {
          if (!target) throw new Error('Usage: octavo theme add <file.css | https://…/theme.css> [--title NAME]');
          let css: string;
          let base: string;
          if (/^https?:\/\//i.test(target)) {
            const url = new URL(target);
            if (url.protocol !== 'https:') throw new Error('Use an https:// address');
            const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
            if (!res.ok) throw new Error(`Couldn’t download it (${res.status} ${res.statusText})`);
            // Redirects are followed, but not down to plain http, where anyone on the way could change the stylesheet.
            if (res.url && new URL(res.url).protocol !== 'https:') throw new Error('That address redirects to a plain http:// address; use an https:// one');
            css = await res.text();
            base = decodeURIComponent(url.pathname.split('/').pop() || 'theme');
          } else {
            css = await fs.readFile(path.resolve(target), 'utf8');
            base = path.basename(target);
          }
          if (css.length > 200_000) throw new Error('That stylesheet is over 200 KB; Octavo only loads snippets up to 200 KB');
          if (/^\s*</.test(css)) throw new Error('That isn’t a CSS file (it looks like a web page). Link to the raw .css file.');
          const name = `${(opts.title ?? base).replace(/\.css$/i, '').replace(/[\\/:*?"<>|]+/g, '_').replace(/^[.\s]+/, '').trim() || 'theme'}.css`;
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, name), css);
          const on = await enabled();
          if (!on.includes(name)) await vault.setConfig('snippets', [...on, name]);
          console.log(`Installed and switched on ${name}. Reload Octavo to see it (or toggle it in Settings → Appearance).`);
          break;
        }
        if (action === 'on' || action === 'off') {
          if (!target) throw new Error(`Usage: octavo theme ${action} <name>`);
          const name = await find(target);
          const on = (await enabled()).filter((n) => n !== name);
          await vault.setConfig('snippets', action === 'on' ? [...on, name] : on);
          console.log(`${name} is ${action}.`);
          break;
        }
        if (action === 'remove') {
          if (!target) throw new Error('Usage: octavo theme remove <name>');
          const name = await find(target);
          await fs.rm(path.join(dir, name));
          await vault.setConfig('snippets', (await enabled()).filter((n) => n !== name));
          console.log(`Removed ${name}.`);
          break;
        }
        throw new Error('Usage: octavo theme [add <file|url> | on <name> | off <name> | remove <name>]');
      }
      case 'islands': {
        const [action, ...rest] = args;
        const target = rest.join(' ').trim();
        const show = (list: { name: string; folder: string; color: string }[]) =>
          list.length ? list.map((i) => `  ${i.name}  (${i.folder}/, ${vault.list({ folder: i.folder }).length} notes, ${i.color})`).join('\n') : '  (none)';
        if (!action || action === 'list') {
          out(vault.islands(), () => `Islands:\n${show(vault.islands())}`);
          break;
        }
        if (action === 'add') {
          if (!target) throw new Error('Usage: octavo islands add <folder> [--title NAME]');
          const folder = target.replace(/^\/+|\/+$/g, '');
          if (!vault.folders().some((f) => f.toLowerCase() === folder.toLowerCase())) throw new Error(`No folder called "${folder}" in the vault`);
          const saved = await vault.setIslands([...vault.islands(), { folder, name: opts.title }]);
          out(saved, () => `Islands:\n${show(saved)}`);
          break;
        }
        if (action === 'remove') {
          const want = target.toLowerCase().replace(/^\/+|\/+$/g, '');
          const current = vault.islands();
          const keep = current.filter((i) => i.name.toLowerCase() !== want && i.folder.toLowerCase() !== want && i.id !== want);
          if (!want || keep.length === current.length) throw new Error(`No island called "${target}"`);
          const saved = await vault.setIslands(keep);
          out(saved, () => `Islands:\n${show(saved)}`);
          break;
        }
        throw new Error('Usage: octavo islands [list | add <folder> [--title NAME] | remove <name-or-folder>]');
      }
      case 'publish': {
        need(args, 1, 'publish <output-folder> [--all | --folder F | --tag T] [--title T]');
        const out = path.resolve(args[0]);
        const root = path.resolve(vault.root);
        if (out === root || out.startsWith(root + path.sep)) throw new Error('Publish to a folder outside the vault');
        const site = await buildSite(vault, { scope: opts.all ? 'all' : 'marked', folder: opts.folder, tag: opts.tag, title: opts.title });
        await writeSite(site, out);
        console.log(`Published ${site.pages} note${site.pages === 1 ? '' : 's'} and ${site.attachments} attachment${site.attachments === 1 ? '' : 's'} to ${out}`);
        if (!site.pages) console.log('No notes matched. Add "publish: true" to a note\'s properties, or use --all, --folder or --tag.');
        if (site.skippedLocked) console.log(`Skipped ${site.skippedLocked} locked note(s).`);
        console.log('Open index.html, or upload the folder to any static host (GitHub Pages, Netlify, Cloudflare Pages…).');
        break;
      }
      case 'query': {
        const src = args.join(' ').trim() || (await readStdin());
        if (!src.trim()) throw new Error('Usage: octavo query <query…>  (or pipe one in)');
        const r = vault.query(src);
        out(r, () => formatQueryResult(r, { maxRows: Number(opts.limit) || 1000 }));
        if (r.errors.length) process.exitCode = 1;
        break;
      }
      case 'set': {
        need(args, 2, 'set <note> <key> [value]');
        const raw = args.slice(2).join(' ');
        let value: unknown = raw === '' ? null : raw;
        if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
        else if (raw === 'true' || raw === 'false') value = raw === 'true';
        else if (/^\[.*\]$/.test(raw)) {
          try {
            value = JSON.parse(raw);
          } catch {
            /* keep as text */
          }
        }
        const s = await vault.setProperty(args[0], args[1], value);
        console.log(value === null ? `Removed ${args[1]} from ${s.path}` : `Set ${args[1]} on ${s.path}`);
        break;
      }
      case 'recent': {
        const after = parseSince(args[0] ?? '1d');
        const notes = vault
          .list()
          .filter((n) => n.mtime >= after)
          .sort((a, b) => b.mtime - a.mtime);
        out(
          notes.map((n) => ({ path: n.path, updated: new Date(n.mtime).toISOString() })),
          () => (notes.length ? notes.map((n) => `  ${new Date(n.mtime).toLocaleString()}  ${n.path}`).join('\n') : `Nothing changed in the last ${args[0] ?? '1d'}.`),
        );
        break;
      }
      case 'orphans': {
        const i = vault.insights();
        out({ orphans: i.orphans.map((n) => n.path), deadEnds: i.deadEnds.map((n) => n.path) }, () =>
          [
            `Orphans (nothing links here): ${i.orphans.length}`,
            ...i.orphans.map((n) => `  ${n.path}`),
            `Dead ends (link nowhere): ${i.deadEnds.length}`,
            ...i.deadEnds.map((n) => `  ${n.path}`),
          ].join('\n'),
        );
        break;
      }
    }
  } finally {
    vault.close();
  }
}
