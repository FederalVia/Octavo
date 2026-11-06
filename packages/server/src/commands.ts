import { Vault } from '@octavo/core';
import { importEnex, importNotion } from './importers.js';

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
  octavo import notion <folder> [--into F]
                                       Import an unzipped Notion "Markdown & CSV" export
  octavo import evernote <file.enex> [--into F]
                                       Import an Evernote export

Add --json to tasks, search, tags, history or orphans for machine-readable output.`;

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
