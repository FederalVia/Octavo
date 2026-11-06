/** Editing GitHub-style Markdown tables: parse, change, and write back. */

export type Align = 'left' | 'center' | 'right' | null;

export interface Table {
  header: string[];
  align: Align[];
  rows: string[][];
  /** Leading whitespace of the table lines, kept when writing back. */
  indent: string;
}

/** Split one table line into cells, honouring escaped pipes (\|) and pipes inside `code`. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (ch === '`') {
      inCode = !inCode;
      cur += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

export function parseTable(raw: string): Table | null {
  const lines = raw.replace(/\s+$/, '').split('\n');
  if (lines.length < 2) return null;
  const indent = /^\s*/.exec(lines[0])![0];
  const header = splitRow(lines[0]);
  const delim = splitRow(lines[1]);
  if (!delim.every((c) => /^:?-+:?$/.test(c))) return null;
  const align: Align[] = header.map((_, i) => {
    const d = delim[i] ?? '---';
    return d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : null;
  });
  const rows = lines.slice(2).map((l) => {
    const cells = splitRow(l);
    return header.map((_, i) => cells[i] ?? '');
  });
  return { header, align, rows, indent };
}

const width = (s: string) => [...s].length;

export function formatTable(t: Table): string {
  const cols = t.header.length;
  const w = Array.from({ length: cols }, (_, i) => Math.max(3, width(t.header[i] ?? ''), ...t.rows.map((r) => width(r[i] ?? ''))));
  const pad = (s: string, i: number) => {
    const n = w[i] - width(s);
    if (t.align[i] === 'right') return ' '.repeat(n) + s;
    if (t.align[i] === 'center') return ' '.repeat(Math.floor(n / 2)) + s + ' '.repeat(Math.ceil(n / 2));
    return s + ' '.repeat(n);
  };
  const line = (cells: string[]) => `${t.indent}| ${cells.map((c, i) => pad(c, i)).join(' | ')} |`;
  const delim = `${t.indent}| ${w
    .map((n, i) => {
      const a = t.align[i];
      if (a === 'center') return ':' + '-'.repeat(n - 2) + ':';
      if (a === 'right') return '-'.repeat(n - 1) + ':';
      if (a === 'left') return ':' + '-'.repeat(n - 1);
      return '-'.repeat(n);
    })
    .join(' | ')} |`;
  return [line(t.header), delim, ...t.rows.map(line)].join('\n');
}

export type TableAction =
  | { type: 'sort'; col: number; desc: boolean }
  | { type: 'insertCol'; col: number; side: 'left' | 'right' }
  | { type: 'deleteCol'; col: number }
  | { type: 'moveCol'; col: number; by: -1 | 1 }
  | { type: 'align'; col: number; align: Align }
  | { type: 'insertRow'; row: number; side: 'above' | 'below' }
  | { type: 'deleteRow'; row: number }
  | { type: 'moveRow'; row: number; by: -1 | 1 };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Apply an action; `row` is a body row index (header = -1). Returns a new table. */
export function editTable(t: Table, a: TableAction): Table {
  const next: Table = { ...t, header: [...t.header], align: [...t.align], rows: t.rows.map((r) => [...r]) };
  const swap = <T>(arr: T[], i: number, j: number) => {
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  };
  switch (a.type) {
    case 'sort':
      next.rows.sort((x, y) => {
        const cx = x[a.col] ?? '';
        const cy = y[a.col] ?? '';
        if (!cx && cy) return 1; // empty cells last
        if (cx && !cy) return -1;
        return a.desc ? collator.compare(cy, cx) : collator.compare(cx, cy);
      });
      break;
    case 'insertCol': {
      const at = a.side === 'left' ? a.col : a.col + 1;
      next.header.splice(at, 0, 'Column');
      next.align.splice(at, 0, null);
      for (const r of next.rows) r.splice(at, 0, '');
      break;
    }
    case 'deleteCol':
      if (next.header.length <= 1) break;
      next.header.splice(a.col, 1);
      next.align.splice(a.col, 1);
      for (const r of next.rows) r.splice(a.col, 1);
      break;
    case 'moveCol':
      swap(next.header, a.col, a.col + a.by);
      swap(next.align, a.col, a.col + a.by);
      for (const r of next.rows) swap(r, a.col, a.col + a.by);
      break;
    case 'align':
      next.align[a.col] = a.align;
      break;
    case 'insertRow': {
      const at = a.row < 0 ? 0 : a.side === 'above' ? a.row : a.row + 1;
      next.rows.splice(at, 0, next.header.map(() => ''));
      break;
    }
    case 'deleteRow':
      if (a.row >= 0) next.rows.splice(a.row, 1);
      break;
    case 'moveRow':
      if (a.row >= 0) swap(next.rows, a.row, a.row + a.by);
      break;
  }
  return next;
}

/**
 * Apply an action to the table whose Markdown source is `raw` inside `content`.
 * Returns the new note content, or null if the table can't be found (e.g. inside a quote).
 */
export function editTableInContent(content: string, raw: string, action: TableAction): string | null {
  const src = raw.replace(/\s+$/, '');
  const at = content.indexOf(src);
  if (at === -1) return null;
  const t = parseTable(src);
  if (!t) return null;
  return content.slice(0, at) + formatTable(editTable(t, action)) + content.slice(at + src.length);
}
