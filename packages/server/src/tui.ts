/**
 * `octavo tui`: browse the vault in a terminal. Type to search, ↑/↓ and Enter to open a note, number
 * keys to follow its links, `e` to edit it in $EDITOR, `d` for today's journal, Esc/Backspace to go
 * back, `q` (or Ctrl+C) to quit. No dependencies: plain ANSI escapes and raw keyboard input.
 */
import { spawnSync } from 'node:child_process';
import readline from 'node:readline';
import type { Vault, NoteSummary } from '@octavo/core';

const ESC = '\x1b[';
const style = {
  bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
  dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
  inverse: (s: string) => `${ESC}7m${s}${ESC}27m`,
  accent: (s: string) => `${ESC}33m${s}${ESC}39m`,
  link: (s: string) => `${ESC}36m${s}${ESC}39m`,
};

/** Visible length of a string with ANSI escapes. */
export function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * Text from the vault with terminal control characters removed. Notes can be written by other devices or
 * Claude, and an escape sequence printed raw could retitle the terminal, write the clipboard (OSC 52) and so on.
 * Tabs become spaces; newlines are kept for multi-line text.
 */
export function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\t/g, '    ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/g, '');
}

/** Notes matching a query: name matches first (prefix, then substring), then full-text hits. */
export function findNotes(vault: Vault, query: string, limit = 200): NoteSummary[] {
  const all = vault.list();
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit); // most recently updated first
  const byName = all
    .map((n) => ({ n, at: n.name.toLowerCase().indexOf(q) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => (a.at === 0 ? 0 : 1) - (b.at === 0 ? 0 : 1) || a.n.name.length - b.n.name.length)
    .map((x) => x.n);
  const seen = new Set(byName.map((n) => n.path));
  const byText = vault
    .search(query, limit)
    .map((r) => all.find((n) => n.path === r.path))
    .filter((n): n is NoteSummary => !!n && !seen.has(n.path));
  return [...byName, ...byText].slice(0, limit);
}

/** Wrap one line of text to a width, keeping words together where possible. */
function wrap(line: string, width: number): string[] {
  if (visibleLength(line) <= width) return [line];
  const out: string[] = [];
  let cur = '';
  for (const word of line.split(/(\s+)/)) {
    if (visibleLength(cur + word) > width && cur.trim()) {
      out.push(cur.trimEnd());
      cur = word.trimStart();
    } else cur += word;
    while (visibleLength(cur) > width) {
      out.push(cur.slice(0, width));
      cur = cur.slice(width);
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * A note as terminal lines: headings bold, [[links]] numbered so they can be followed with number keys,
 * tasks as ☐/☑, frontmatter dimmed, wrapped to the width.
 */
export function renderNote(content: string, width: number): { lines: string[]; links: string[] } {
  const links: string[] = [];
  const lines: string[] = [];
  content = plain(content.replace(/\r\n/g, '\n'));
  let body = content;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (fm) {
    for (const l of fm[1].split('\n')) lines.push(...wrap(style.dim(l), width));
    lines.push('');
    body = content.slice(fm[0].length);
  }
  let fence = false;
  for (const raw of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      lines.push(style.dim(raw));
      continue;
    }
    if (fence) {
      lines.push(...wrap(style.dim(raw), width));
      continue;
    }
    let line = raw.replace(/(!?)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, bang: string, target: string, _h, alias?: string) => {
      const t = target.trim();
      // Embedded files (images, audio, PDFs, drawings) aren't notes to follow.
      if (bang && /\.(?!md$)[a-z0-9]{2,10}$/i.test(t)) return style.dim(`[${/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(t) ? 'image' : 'file'}: ${t}]`);
      let i = links.indexOf(t);
      if (i < 0) {
        links.push(t);
        i = links.length - 1;
      }
      return style.link(`${alias ?? t}`) + style.dim(`[${i + 1}]`);
    });
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) line = style.bold(h[1].length <= 2 ? style.accent(h[2]) : h[2]);
    line = line.replace(/^(\s*)[-*+] \[ \] /, '$1☐ ').replace(/^(\s*)[-*+] \[[xX]\] /, '$1☑ ');
    line = line.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => style.bold(t));
    lines.push(...wrap(line, width));
  }
  return { lines, links };
}

/** Pick an editor command for `e`. */
function editorCommand(): string {
  return process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
}

export async function runTui(vault: Vault): Promise<void> {
  const out = process.stdout;
  const input = process.stdin;
  if (!input.isTTY || !out.isTTY) throw new Error('octavo tui needs an interactive terminal');

  type Screen = { kind: 'list' } | { kind: 'note'; path: string; scroll: number; lines: string[]; links: string[] };
  let query = '';
  let results = findNotes(vault, query);
  let selected = 0;
  let listScroll = 0;
  const history: Screen[] = [];
  let screen: Screen = { kind: 'list' };
  let message = '';

  const size = () => ({ w: Math.max(40, out.columns || 80), h: Math.max(10, out.rows || 24) });
  const fit = (s: string, w: number) => {
    const vis = visibleLength(s);
    return vis > w ? s.slice(0, w - 1) + '…' : s + ' '.repeat(w - vis);
  };

  const draw = () => {
    const { w, h } = size();
    const rows: string[] = [];
    if (screen.kind === 'list') {
      rows.push(style.bold(` Octavo · ${plain(vault.name)} `) + style.dim(`${vault.list().length} notes`));
      rows.push(` Search: ${query}${style.inverse(' ')}`);
      rows.push(style.dim('─'.repeat(w)));
      const space = h - 5;
      if (selected < listScroll) listScroll = selected;
      if (selected >= listScroll + space) listScroll = selected - space + 1;
      for (let i = listScroll; i < Math.min(results.length, listScroll + space); i++) {
        const n = results[i];
        const label = `${plain(n.name)}${n.folder ? style.dim(`  ${plain(n.folder)}`) : ''}`;
        rows.push(i === selected ? style.inverse(fit(` ${label} `, w)) : ` ${label}`);
      }
      if (!results.length) rows.push(style.dim(' No matching notes.'));
      while (rows.length < h - 1) rows.push('');
      rows.push(style.dim(plain(message) || ' type to search · ↑↓ move · Enter open · Ctrl+D today · Esc clear · Ctrl+C quit'));
    } else {
      const s = screen;
      rows.push(style.bold(` ${plain(s.path.replace(/\.md$/, ''))} `));
      rows.push(style.dim('─'.repeat(w)));
      const space = h - 3;
      for (const l of s.lines.slice(s.scroll, s.scroll + space)) rows.push(` ${l}`);
      while (rows.length < h - 1) rows.push('');
      const more = s.lines.length > space ? ` ${Math.min(100, Math.round(((s.scroll + space) / s.lines.length) * 100))}%` : '';
      rows.push(style.dim(plain(message) || ` ↑↓/Space scroll · 1-9 follow link · e edit · d today · Esc back · q quit${more}`));
    }
    out.write(`${ESC}H${ESC}2J` + rows.map((r) => r).join('\n'));
    message = '';
  };

  const open = async (target: string, pushHistory = true) => {
    const path = vault.resolve(target);
    if (!path) {
      message = ` “${target}” doesn’t exist yet`;
      return;
    }
    const note = await vault.read(path);
    if (note.encrypted) {
      message = ' That note is locked; open it in the app to unlock it.';
      return;
    }
    const { w } = size();
    const r = renderNote(note.content, w - 2);
    if (pushHistory) history.push(screen);
    screen = { kind: 'note', path, scroll: 0, lines: r.lines, links: r.links };
    vault.noteAccessed?.(path);
  };

  const edit = (path: string) => {
    input.setRawMode(false);
    out.write(`${ESC}?1049l`);
    // Windows runs the editor through cmd.exe (for .cmd editors), which would read & | ^ in a note's file name
    // as commands: quote it there (file names can't contain "). Elsewhere there's no shell.
    const file = vault.filePath(path);
    const win = process.platform === 'win32';
    spawnSync(editorCommand(), [win ? `"${file}"` : file], { stdio: 'inherit', shell: win });
    out.write(`${ESC}?1049h`);
    input.setRawMode(true);
  };

  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  out.write(`${ESC}?1049h${ESC}?25l`); // alternate screen, hide cursor
  const restore = () => {
    out.write(`${ESC}?25h${ESC}?1049l`);
    try {
      input.setRawMode(false);
    } catch {
      /* already closed */
    }
  };

  await new Promise<void>((resolve) => {
    const quit = () => {
      input.off('keypress', onKey);
      out.off('resize', draw);
      restore();
      input.pause();
      resolve();
    };
    const onKey = async (str: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (key.ctrl && key.name === 'c') return quit();
      try {
        if (screen.kind === 'list') {
          if (key.ctrl && key.name === 'd') await open((await vault.ensurePeriodicNote('day')).path);
          else if (key.name === 'up') selected = Math.max(0, selected - 1);
          else if (key.name === 'down') selected = Math.min(results.length - 1, selected + 1);
          else if (key.name === 'pageup') selected = Math.max(0, selected - (size().h - 5));
          else if (key.name === 'pagedown') selected = Math.min(results.length - 1, selected + (size().h - 5));
          else if (key.name === 'return') {
            if (results[selected]) await open(results[selected].path);
          } else if (key.name === 'escape') {
            query = '';
            results = findNotes(vault, query);
            selected = 0;
          } else if (key.name === 'backspace') {
            query = query.slice(0, -1);
            results = findNotes(vault, query);
            selected = 0;
          } else if (str && !key.ctrl && str >= ' ' && str.length === 1) {
            query += str;
            results = findNotes(vault, query);
            selected = 0;
          }
        } else {
          const s = screen;
          const page = size().h - 3;
          const max = Math.max(0, s.lines.length - page);
          if (key.name === 'q') return quit();
          if (key.name === 'escape' || key.name === 'backspace' || key.name === 'left') screen = history.pop() ?? { kind: 'list' };
          else if (key.name === 'up') s.scroll = Math.max(0, s.scroll - 1);
          else if (key.name === 'down') s.scroll = Math.min(max, s.scroll + 1);
          else if (key.name === 'pageup') s.scroll = Math.max(0, s.scroll - page);
          else if (key.name === 'pagedown' || key.name === 'space') s.scroll = Math.min(max, s.scroll + page);
          else if (key.name === 'e') {
            edit(s.path);
            await open(s.path, false);
          } else if (key.name === 'd') await open((await vault.ensurePeriodicNote('day')).path);
          else if (str && /^[1-9]$/.test(str)) {
            const target = s.links[Number(str) - 1];
            if (target) await open(target);
            else message = ` No link ${str} on this page`;
          }
        }
      } catch (err) {
        message = ` ${(err as Error).message}`;
      }
      draw();
    };
    input.on('keypress', onKey);
    out.on('resize', draw);
    draw();
  });
}
