/**
 * Note queries: live tables, lists and cards of notes filtered by folder, tag, links and properties.
 *
 * Two ways to write one, both compiled to the same {@link NoteQuery}:
 *
 * A Dataview-style line (```query or ```dataview blocks, the MCP tool, the CLI):
 *
 *     TABLE status, due AS "Due date" FROM "Projects" AND #active WHERE status != "done" SORT due ASC LIMIT 20
 *     LIST FROM [[Octavo]]
 *     CARDS summary FROM #person
 *
 * Or YAML (```base blocks):
 *
 *     from: '"Projects" and #active'
 *     where: status != "done"
 *     columns: [status, due]
 *     sort: due asc
 *     view: table
 *
 * Fields are the note's properties (frontmatter) and inline `key:: value` fields, plus `file.name`,
 * `file.path`, `file.folder`, `file.tags`, `file.mtime`, `file.ctime`, `file.size`, `file.links` and
 * `file.inlinks`. `this.<field>` reads the note the query is in.
 */
import YAML from 'yaml';
import type { IndexedNote } from './types.js';

export type QueryView = 'table' | 'list' | 'cards';

export interface QueryColumn {
  label: string;
  /** Set when the column is a plain property name, so the app can offer to edit it. */
  property?: string;
  expr: Expr;
}

export interface NoteQuery {
  view: QueryView;
  /** Show the note name column (TABLE WITHOUT ID hides it). */
  showName: boolean;
  columns: QueryColumn[];
  from: Source | null;
  where: Expr | null;
  sort: { expr: Expr; desc: boolean }[];
  group: Expr | null;
  limit: number | null;
  errors: string[];
}

export type QueryValue = string | number | boolean | null | QueryValue[];

export interface QueryRow {
  path: string;
  name: string;
  values: QueryValue[];
  group?: QueryValue;
}

export interface QueryResult {
  view: QueryView;
  showName: boolean;
  columns: { label: string; property?: string }[];
  rows: QueryRow[];
  /** Matches before LIMIT. */
  total: number;
  grouped: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------------------------
// Tokens

type Tok =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'tag'; v: string }
  | { t: 'link'; v: string }
  | { t: 'op'; v: string };

const KEYWORDS = new Set(['table', 'list', 'cards', 'from', 'where', 'sort', 'group', 'by', 'limit', 'as', 'asc', 'desc', 'ascending', 'descending', 'without', 'id', 'and', 'or', 'not']);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        v += src[j++];
      }
      if (j >= src.length) throw new Error(`Unclosed quote in: ${src.slice(i, i + 30)}`);
      out.push({ t: 'str', v });
      i = j + 1;
      continue;
    }
    if (src.startsWith('[[', i)) {
      const j = src.indexOf(']]', i + 2);
      if (j < 0) throw new Error('Unclosed [[link]]');
      out.push({ t: 'link', v: src.slice(i + 2, j).split('|')[0].trim() });
      i = j + 2;
      continue;
    }
    if (c === '#' && /[\p{L}\p{N}_/-]/u.test(src[i + 1] ?? '')) {
      const m = /^#([\p{L}\p{N}_/-]+)/u.exec(src.slice(i))!;
      out.push({ t: 'tag', v: m[1] });
      i += m[0].length;
      continue;
    }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j < 0) throw new Error('Unclosed `');
      out.push({ t: 'id', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const day = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/.exec(src.slice(i));
    if (day) {
      out.push({ t: 'str', v: day[0] });
      i += day[0].length;
      continue;
    }
    const num = /^\d+(\.\d+)?(?![\p{L}_-])/u.exec(src.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[\p{L}_][\p{L}\p{N}_.-]*/u.exec(src.slice(i));
    if (id) {
      // A trailing "-" belongs to an operator, not the name.
      const v = id[0].replace(/[.-]+$/, '');
      out.push({ t: 'id', v });
      i += v.length;
      continue;
    }
    const op = /^(==|!=|<>|<=|>=|&&|\|\||[=<>!+\-*/(),])/.exec(src.slice(i));
    if (op) {
      out.push({ t: 'op', v: op[0] });
      i += op[0].length;
      continue;
    }
    throw new Error(`Unexpected “${c}”`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Expressions

export type Expr =
  | { k: 'lit'; v: QueryValue }
  | { k: 'field'; path: string; self?: boolean }
  | { k: 'not'; e: Expr }
  | { k: 'neg'; e: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'call'; fn: string; args: Expr[] };

export type Source =
  | { k: 'folder'; v: string }
  | { k: 'tag'; v: string }
  | { k: 'link'; v: string }
  | { k: 'and' | 'or'; a: Source; b: Source }
  | { k: 'not'; s: Source };

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  done(): boolean {
    return this.i >= this.toks.length;
  }
  isKw(...kws: string[]): boolean {
    const t = this.peek();
    return !!t && t.t === 'id' && kws.includes(t.v.toLowerCase());
  }
  isOp(...ops: string[]): boolean {
    const t = this.peek();
    return !!t && t.t === 'op' && ops.includes(t.v);
  }
  next(): Tok {
    const t = this.toks[this.i++];
    if (!t) throw new Error('The query ends too early');
    return t;
  }
  expectOp(v: string) {
    if (!this.isOp(v)) throw new Error(`Expected “${v}”`);
    this.i++;
  }

  expr(): Expr {
    return this.or();
  }
  or(): Expr {
    let a = this.and();
    while (this.isKw('or') || this.isOp('||')) {
      this.i++;
      a = { k: 'bin', op: 'or', a, b: this.and() };
    }
    return a;
  }
  and(): Expr {
    let a = this.not();
    while (this.isKw('and') || this.isOp('&&')) {
      this.i++;
      a = { k: 'bin', op: 'and', a, b: this.not() };
    }
    return a;
  }
  not(): Expr {
    if (this.isKw('not') || this.isOp('!')) {
      this.i++;
      return { k: 'not', e: this.not() };
    }
    return this.cmp();
  }
  cmp(): Expr {
    const a = this.add();
    if (this.isOp('=', '==', '!=', '<>', '<', '<=', '>', '>=')) {
      let op = (this.next() as { v: string }).v;
      if (op === '==') op = '=';
      if (op === '<>') op = '!=';
      return { k: 'bin', op, a, b: this.add() };
    }
    return a;
  }
  add(): Expr {
    let a = this.mul();
    while (this.isOp('+', '-')) {
      const op = (this.next() as { v: string }).v;
      a = { k: 'bin', op, a, b: this.mul() };
    }
    return a;
  }
  mul(): Expr {
    let a = this.unary();
    while (this.isOp('*', '/')) {
      const op = (this.next() as { v: string }).v;
      a = { k: 'bin', op, a, b: this.unary() };
    }
    return a;
  }
  unary(): Expr {
    if (this.isOp('-')) {
      this.i++;
      return { k: 'neg', e: this.unary() };
    }
    return this.primary();
  }
  primary(): Expr {
    const t = this.next();
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'link') return { k: 'lit', v: t.v };
    if (t.t === 'tag') return { k: 'lit', v: t.v };
    if (t.t === 'op' && t.v === '(') {
      const e = this.expr();
      this.expectOp(')');
      return e;
    }
    if (t.t === 'id') {
      const low = t.v.toLowerCase();
      if (low === 'true' || low === 'false') return { k: 'lit', v: low === 'true' };
      if (low === 'null' || low === 'none') return { k: 'lit', v: null };
      if (this.isOp('(')) {
        this.i++;
        const args: Expr[] = [];
        if (!this.isOp(')')) {
          do {
            // date(today) / dur(7 days): bare words are text here.
            if ((low === 'date' || low === 'dur') && this.peek()?.t !== 'str') {
              const words: string[] = [];
              while (!this.isOp(')') && !this.isOp(',')) {
                const w = this.next();
                words.push(String((w as { v: unknown }).v));
              }
              args.push({ k: 'lit', v: words.join(' ') });
            } else args.push(this.expr());
          } while (this.isOp(',') && ++this.i);
        }
        this.expectOp(')');
        return { k: 'call', fn: low, args };
      }
      if (low.startsWith('this.')) return { k: 'field', path: t.v.slice(5), self: true };
      return { k: 'field', path: t.v };
    }
    throw new Error(`Unexpected “${(t as { v: unknown }).v}”`);
  }

  source(): Source {
    let a = this.sourceAnd();
    while (this.isKw('or')) {
      this.i++;
      a = { k: 'or', a, b: this.sourceAnd() };
    }
    return a;
  }
  sourceAnd(): Source {
    let a = this.sourceNot();
    while (this.isKw('and')) {
      this.i++;
      a = { k: 'and', a, b: this.sourceNot() };
    }
    return a;
  }
  sourceNot(): Source {
    if (this.isKw('not') || this.isOp('-', '!')) {
      this.i++;
      return { k: 'not', s: this.sourceNot() };
    }
    const t = this.next();
    if (t.t === 'str') return { k: 'folder', v: t.v.replace(/^\/+|\/+$/g, '') };
    if (t.t === 'tag') return { k: 'tag', v: t.v };
    if (t.t === 'link') return { k: 'link', v: t.v };
    if (t.t === 'op' && t.v === '(') {
      const s = this.source();
      this.expectOp(')');
      return s;
    }
    throw new Error('FROM takes "Folder", #tag or [[Note]] (combine with and / or / not)');
  }
}

function parseExpr(src: string): Expr {
  const p = new Parser(tokenize(src));
  const e = p.expr();
  if (!p.done()) throw new Error(`Didn't understand “${src}” after the start`);
  return e;
}

function parseSource(src: string): Source {
  const p = new Parser(tokenize(src));
  const s = p.source();
  if (!p.done()) throw new Error(`Didn't understand the source “${src}”`);
  return s;
}

function exprLabel(e: Expr): string {
  switch (e.k) {
    case 'field':
      return (e.self ? 'this.' : '') + e.path;
    case 'lit':
      return JSON.stringify(e.v);
    case 'call':
      return `${e.fn}(${e.args.map(exprLabel).join(', ')})`;
    case 'not':
      return `not ${exprLabel(e.e)}`;
    case 'neg':
      return `-${exprLabel(e.e)}`;
    case 'bin':
      return `${exprLabel(e.a)} ${e.op} ${exprLabel(e.b)}`;
  }
}

const FILE_LABELS: Record<string, string> = {
  'file.name': 'Name',
  'file.path': 'Path',
  'file.folder': 'Folder',
  'file.tags': 'Tags',
  'file.mtime': 'Modified',
  'file.mday': 'Modified',
  'file.ctime': 'Created',
  'file.cday': 'Created',
  'file.size': 'Size',
  'file.links': 'Links out',
  'file.inlinks': 'Links in',
  'file.aliases': 'Aliases',
};

function column(e: Expr, label?: string): QueryColumn {
  return {
    expr: e,
    label: label ?? (e.k === 'field' && !e.self ? FILE_LABELS[e.path.toLowerCase()] : undefined) ?? exprLabel(e),
    property: e.k === 'field' && !e.self && !e.path.startsWith('file.') ? e.path : undefined,
  };
}

function emptyQuery(view: QueryView): NoteQuery {
  return { view, showName: true, columns: [], from: null, where: null, sort: [], group: null, limit: null, errors: [] };
}

/** Parse a Dataview-style query: `TABLE a, b FROM … WHERE … SORT … GROUP BY … LIMIT n`. */
export function parseDql(src: string): NoteQuery {
  const text = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|%%)/.test(l))
    .join(' ')
    .trim();
  const q = emptyQuery('table');
  let p: Parser;
  try {
    p = new Parser(tokenize(text));
  } catch (err) {
    q.errors.push((err as Error).message);
    return q;
  }
  try {
    if (p.isKw('table', 'list', 'cards')) {
      q.view = (p.next() as { v: string }).v.toLowerCase() as QueryView;
    } else if (!p.done() && !p.isKw('from', 'where', 'sort', 'group', 'limit')) {
      throw new Error('Start with TABLE, LIST or CARDS');
    }
    if (p.isKw('without')) {
      p.i++;
      if (!p.isKw('id')) throw new Error('Expected WITHOUT ID');
      p.i++;
      q.showName = false;
    }
    const clause = () => p.isKw('from', 'where', 'sort', 'group', 'limit');
    if (!p.done() && !clause()) {
      do {
        const e = p.expr();
        let label: string | undefined;
        if (p.isKw('as')) {
          p.i++;
          const t = p.next();
          label = String((t as { v: unknown }).v);
        }
        q.columns.push(column(e, label));
      } while (p.isOp(',') && ++p.i);
    }
    while (!p.done()) {
      const kw = (p.next() as { v: string }).v.toLowerCase();
      if (kw === 'from') q.from = q.from ? { k: 'and', a: q.from, b: p.source() } : p.source();
      else if (kw === 'where') q.where = q.where ? { k: 'bin', op: 'and', a: q.where, b: p.expr() } : p.expr();
      else if (kw === 'sort') {
        do {
          const e = p.expr();
          let desc = false;
          if (p.isKw('asc', 'ascending')) p.i++;
          else if (p.isKw('desc', 'descending')) {
            p.i++;
            desc = true;
          }
          q.sort.push({ expr: e, desc });
        } while (p.isOp(',') && ++p.i);
      } else if (kw === 'group') {
        if (p.isKw('by')) p.i++;
        q.group = p.expr();
      } else if (kw === 'limit') {
        const t = p.next();
        if (t.t !== 'num') throw new Error('LIMIT takes a number');
        q.limit = t.v;
      } else throw new Error(`Didn't expect “${kw}” here`);
    }
  } catch (err) {
    q.errors.push((err as Error).message);
  }
  return q;
}

/** Parse a YAML `base` block. */
export function parseBase(src: string): NoteQuery {
  const q = emptyQuery('table');
  let data: Record<string, unknown>;
  try {
    const v = YAML.parse(src, { logLevel: 'error' }) ?? {};
    if (typeof v !== 'object' || Array.isArray(v)) throw new Error('A base is a list of settings like “from: …” and “where: …”');
    data = v as Record<string, unknown>;
  } catch (err) {
    q.errors.push((err as Error).message);
    return q;
  }
  const list = (v: unknown): string[] =>
    v == null ? [] : Array.isArray(v) ? v.map(String) : String(v).split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/).map((s) => s.trim()).filter(Boolean);
  const attempt = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      q.errors.push(`${what}: ${(err as Error).message}`);
    }
  };
  const view = String(data.view ?? 'table').toLowerCase();
  if (view === 'table' || view === 'list' || view === 'cards') q.view = view;
  else q.errors.push(`view: use table, list or cards`);
  const sources: Source[] = [];
  attempt('from', () => {
    if (data.from == null) return;
    const f = String(data.from);
    // YAML eats the quotes of from: "Projects", so plain text means a folder.
    sources.push(/["'#]|\[\[|\b(and|or|not)\b/i.test(f) ? parseSource(f) : { k: 'folder', v: f.trim().replace(/^\/+|\/+$/g, '') });
  });
  for (const f of list(data.folder)) sources.push({ k: 'folder', v: f.replace(/^\/+|\/+$/g, '') });
  for (const t of list(data.tag ?? data.tags)) sources.push({ k: 'tag', v: t.replace(/^#/, '') });
  q.from = sources.reduce<Source | null>((a, s) => (a ? { k: 'and', a, b: s } : s), null);
  const wheres = Array.isArray(data.where) ? data.where.map(String) : data.where != null ? [String(data.where)] : [];
  for (const w of wheres) attempt('where', () => {
    const e = parseExpr(w);
    q.where = q.where ? { k: 'bin', op: 'and', a: q.where, b: e } : e;
  });
  for (const c of list(data.columns ?? data.fields)) attempt('columns', () => {
    const m = /^(.*?)\s+as\s+(?:"([^"]*)"|'([^']*)'|(.+))$/i.exec(c);
    q.columns.push(m ? column(parseExpr(m[1]), m[2] ?? m[3] ?? m[4]) : column(parseExpr(c)));
  });
  for (const s of Array.isArray(data.sort) ? data.sort.map(String) : list(data.sort)) attempt('sort', () => {
    const m = /^(.*?)(?:\s+(asc|ascending|desc|descending))?$/i.exec(s.trim())!;
    q.sort.push({ expr: parseExpr(m[1]), desc: !!m[2] && m[2].toLowerCase().startsWith('desc') });
  });
  if (data.group != null) attempt('group', () => (q.group = parseExpr(String(data.group))));
  if (data.limit != null) {
    const n = Number(data.limit);
    if (Number.isFinite(n) && n > 0) q.limit = Math.floor(n);
    else q.errors.push('limit: use a number');
  }
  if (data.name === false || data.showName === false) q.showName = false;
  return q;
}

/** Parse either form: YAML if it looks like `key: value` lines, otherwise Dataview-style. */
export function parseNoteQuery(src: string, lang?: 'base' | 'dql'): NoteQuery {
  if (lang === 'base') return parseBase(src);
  if (lang === 'dql') return parseDql(src);
  const first = src.trim().split('\n')[0] ?? '';
  return /^(from|where|columns|fields|sort|view|folder|tags?|group|limit)\s*:/i.test(first) ? parseBase(src) : parseDql(src);
}

// ---------------------------------------------------------------------------------------------
// Evaluation

export interface QueryEnv {
  notes: IndexedNote[];
  /** Resolve a [[link]] target to a note path. */
  resolve: (target: string, fromPath?: string) => string | null;
  /** Notes linking to a path. */
  inlinks: (path: string) => string[];
  /** The note the query lives in, for `this.` and `[[]]`. */
  thisPath?: string;
  now?: Date;
}

interface Dur {
  days: number;
}

type Val = QueryValue | Dur;

const INLINE_FIELD = /^\s*(?:[-*+]\s+)?\[?([\p{L}\p{N}_ -]{1,40}?)::\s*(.*?)\]?\s*$/u;

function inlineFields(content: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let fence = false;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence || !line.includes('::')) continue;
    const m = INLINE_FIELD.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    if (key in out) continue;
    const raw = m[2].trim();
    out[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  return out;
}

function iso(d: Date, withTime = false): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${day}T${p(d.getHours())}:${p(d.getMinutes())}` : day;
}

const normKey = (k: string) => k.toLowerCase().replace(/[\s_-]+/g, '');

function toValue(v: unknown): QueryValue {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return iso(v);
  if (Array.isArray(v)) return v.map(toValue);
  return JSON.stringify(v);
}

class Row {
  private fields: Record<string, unknown> | null = null;
  constructor(
    readonly note: IndexedNote,
    private env: QueryEnv,
  ) {}
  private props(): Record<string, unknown> {
    if (!this.fields) {
      this.fields = { ...(this.note.encrypted ? {} : inlineFields(this.note.content)), ...this.note.frontmatter };
    }
    return this.fields;
  }
  get(path: string): QueryValue {
    const n = this.note;
    const low = path.toLowerCase();
    if (low.startsWith('file.')) {
      switch (low.slice(5)) {
        case 'name':
          return n.name;
        case 'path':
          return n.path;
        case 'folder':
          return n.folder;
        case 'tags':
          return n.tags;
        case 'mtime':
        case 'mday':
          return iso(new Date(n.mtime), low.endsWith('mtime'));
        case 'ctime':
        case 'cday':
          return iso(new Date(n.ctime), low.endsWith('ctime'));
        case 'size':
          return n.size;
        case 'links':
          return n.links.length;
        case 'inlinks':
          return this.env.inlinks(n.path).length;
        case 'aliases':
          return n.aliases;
        default:
          return null;
      }
    }
    const props = this.props();
    if (path in props) return toValue(props[path]);
    const want = normKey(path);
    for (const k of Object.keys(props)) if (normKey(k) === want) return toValue(props[k]);
    return null;
  }
}

function isDur(v: Val): v is Dur {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'days' in v;
}

function truthy(v: Val): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return !!v || v === 0;
}

function textOf(v: Val): string {
  if (v == null) return '';
  if (isDur(v)) return `${v.days} days`;
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return String(v);
}

const linkName = (s: string) => s.replace(/^\[\[|\]\]$/g, '').split('|')[0].replace(/^#/, '').trim().toLowerCase();

function looseEq(a: Val, b: Val): boolean {
  if (a == null || b == null) return (a == null || a === '') && (b == null || b === '');
  if (Array.isArray(a)) return Array.isArray(b) ? a.length === b.length && a.every((x, i) => looseEq(x, b[i])) : a.some((x) => looseEq(x, b));
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  return linkName(textOf(a)) === linkName(textOf(b));
}

function compare(a: Val, b: Val): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // empty values go last
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const na = Number(a);
  const nb = Number(b);
  if (typeof a !== 'boolean' && typeof b !== 'boolean' && textOf(a) !== '' && textOf(b) !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return textOf(a).localeCompare(textOf(b), undefined, { sensitivity: 'base', numeric: true });
}

function shiftDate(date: string, days: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(date);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  d.setTime(d.getTime() + days * 86400000);
  return iso(d, !!m[4]);
}

function parseDur(s: string): Dur | null {
  let days = 0;
  let any = false;
  for (const m of s.toLowerCase().matchAll(/(-?\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|w|months?|mo|years?|y)\b/g)) {
    any = true;
    const n = Number(m[1]);
    const u = m[2];
    days += u.startsWith('mi') ? n / 1440 : u.startsWith('h') ? n / 24 : u.startsWith('w') ? n * 7 : u.startsWith('mo') ? n * 30 : u.startsWith('y') ? n * 365 : n;
  }
  return any ? { days } : null;
}

function evaluate(e: Expr, row: Row, self: Row | null, env: QueryEnv): Val {
  switch (e.k) {
    case 'lit':
      return e.v;
    case 'field':
      return e.self ? (self ? self.get(e.path) : null) : row.get(e.path);
    case 'not':
      return !truthy(evaluate(e.e, row, self, env));
    case 'neg': {
      const v = evaluate(e.e, row, self, env);
      return typeof v === 'number' ? -v : null;
    }
    case 'bin': {
      if (e.op === 'and') return truthy(evaluate(e.a, row, self, env)) && truthy(evaluate(e.b, row, self, env));
      if (e.op === 'or') return truthy(evaluate(e.a, row, self, env)) || truthy(evaluate(e.b, row, self, env));
      const a = evaluate(e.a, row, self, env);
      const b = evaluate(e.b, row, self, env);
      switch (e.op) {
        case '=':
          return looseEq(a, b);
        case '!=':
          return !looseEq(a, b);
        case '<':
        case '<=':
        case '>':
        case '>=': {
          if (a == null || b == null || isDur(a) || isDur(b)) return false;
          const c = compare(a, b);
          return e.op === '<' ? c < 0 : e.op === '<=' ? c <= 0 : e.op === '>' ? c > 0 : c >= 0;
        }
        case '+':
        case '-': {
          const sign = e.op === '+' ? 1 : -1;
          if (typeof a === 'string' && isDur(b)) return shiftDate(a, sign * b.days);
          if (typeof a === 'number' && typeof b === 'number') return a + sign * b;
          if (e.op === '+' && (typeof a === 'string' || typeof b === 'string')) return textOf(a) + textOf(b);
          if (e.op === '-' && typeof a === 'string' && typeof b === 'string') {
            const da = Date.parse(a);
            const db = Date.parse(b);
            if (!Number.isNaN(da) && !Number.isNaN(db)) return { days: (da - db) / 86400000 };
          }
          return null;
        }
        case '*':
          return typeof a === 'number' && typeof b === 'number' ? a * b : null;
        case '/':
          return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a / b : null;
      }
      return null;
    }
    case 'call': {
      const args = e.args.map((x) => evaluate(x, row, self, env));
      const [a, b] = args;
      switch (e.fn) {
        case 'contains':
        case 'icontains': {
          if (Array.isArray(a)) return a.some((x) => looseEq(x, b) || (e.fn === 'icontains' && textOf(x).toLowerCase().includes(textOf(b).toLowerCase())));
          return textOf(a).toLowerCase().includes(textOf(b).toLowerCase());
        }
        case 'startswith':
          return textOf(a).toLowerCase().startsWith(textOf(b).toLowerCase());
        case 'endswith':
          return textOf(a).toLowerCase().endsWith(textOf(b).toLowerCase());
        case 'length':
          return Array.isArray(a) ? a.length : a == null ? 0 : textOf(a).length;
        case 'lower':
          return textOf(a).toLowerCase();
        case 'upper':
          return textOf(a).toUpperCase();
        case 'default':
          return a == null || a === '' ? b : a;
        case 'number': {
          const n = Number(textOf(a));
          return Number.isNaN(n) ? null : n;
        }
        case 'round': {
          if (typeof a !== 'number') return null;
          const f = 10 ** (typeof b === 'number' ? b : 0);
          return Math.round(a * f) / f;
        }
        case 'exists':
          return a != null && a !== '';
        case 'date': {
          const now = env.now ?? new Date();
          const s = textOf(a).trim().toLowerCase();
          if (s === 'today' || s === '') return iso(now);
          if (s === 'now') return iso(now, true);
          if (s === 'yesterday') return shiftDate(iso(now), -1);
          if (s === 'tomorrow') return shiftDate(iso(now), 1);
          if (s === 'sow') return shiftDate(iso(now), -((now.getDay() + 6) % 7));
          const m = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.exec(textOf(a).trim());
          return m ? m[0] : null;
        }
        case 'dur':
          return parseDur(textOf(a));
        case 'days': // days between a date and today, e.g. days(due) < 0 for overdue
        {
          const t = Date.parse(textOf(a));
          if (Number.isNaN(t)) return null;
          const now = env.now ?? new Date();
          const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
          return Math.round((t - today) / 86400000);
        }
        case 'link':
          return textOf(a);
        default:
          throw new Error(`Unknown function ${e.fn}()`);
      }
    }
  }
}

function inSource(s: Source, n: IndexedNote, env: QueryEnv): boolean {
  switch (s.k) {
    case 'folder':
      return s.v === '' || n.folder === s.v || n.folder.startsWith(s.v + '/') || n.path === s.v || n.path === `${s.v}.md`;
    case 'tag': {
      const t = s.v.toLowerCase();
      return n.tags.some((x) => {
        const l = x.toLowerCase();
        return l === t || l.startsWith(t + '/');
      });
    }
    case 'link': {
      const target = s.v === '' || s.v === '#' ? env.thisPath ?? null : env.resolve(s.v, env.thisPath);
      if (!target) return false;
      return n.links.some((l) => env.resolve(l.target, n.path) === target);
    }
    case 'and':
      return inSource(s.a, n, env) && inSource(s.b, n, env);
    case 'or':
      return inSource(s.a, n, env) || inSource(s.b, n, env);
    case 'not':
      return !inSource(s.s, n, env);
  }
}

const finalValue = (v: Val): QueryValue => (isDur(v) ? `${Math.round(v.days * 10) / 10} days` : v);

export function runQuery(q: NoteQuery, env: QueryEnv): QueryResult {
  const errors = [...q.errors];
  const result: QueryResult = {
    view: q.view,
    showName: q.showName || q.columns.length === 0,
    columns: q.columns.map((c) => ({ label: c.label, property: c.property })),
    rows: [],
    total: 0,
    grouped: !!q.group,
    errors,
  };
  if (q.errors.length) return result;
  const selfNote = env.thisPath ? env.notes.find((n) => n.path === env.thisPath) : undefined;
  const self = selfNote ? new Row(selfNote, env) : null;
  try {
    let rows = env.notes
      .filter((n) => !n.path.startsWith('.') && (!q.from || inSource(q.from, n, env)))
      .map((n) => new Row(n, env))
      .filter((r) => !q.where || truthy(evaluate(q.where, r, self, env)));
    const keyed = rows.map((r) => ({
      r,
      sort: q.sort.map((s) => evaluate(s.expr, r, self, env)),
      group: q.group ? finalValue(evaluate(q.group, r, self, env)) : undefined,
    }));
    keyed.sort((x, y) => {
      if (q.group) {
        const g = compare(x.group ?? null, y.group ?? null);
        if (g) return g;
      }
      for (let i = 0; i < q.sort.length; i++) {
        const xa = x.sort[i] as QueryValue;
        const ya = y.sort[i] as QueryValue;
        const xe = xa == null || xa === '';
        const ye = ya == null || ya === '';
        if (xe !== ye) return xe ? 1 : -1; // empty values last, whichever the direction
        const c = compare(xa, ya);
        if (c) return q.sort[i].desc ? -c : c;
      }
      return q.sort.length ? 0 : x.r.note.name.localeCompare(y.r.note.name, undefined, { sensitivity: 'base', numeric: true });
    });
    result.total = keyed.length;
    const limited = q.limit != null ? keyed.slice(0, q.limit) : keyed;
    rows = limited.map((k) => k.r);
    result.rows = limited.map((k) => ({
      path: k.r.note.path,
      name: k.r.note.name,
      values: q.columns.map((c) => finalValue(evaluate(c.expr, k.r, self, env))),
      ...(q.group ? { group: k.group ?? null } : {}),
    }));
  } catch (err) {
    errors.push((err as Error).message);
  }
  return result;
}

/** A plain-text rendering, for Claude and the terminal. */
export function formatQueryResult(r: QueryResult, opts: { maxRows?: number } = {}): string {
  const lines: string[] = [];
  if (r.errors.length) lines.push(...r.errors.map((e) => `Error: ${e}`));
  if (!r.rows.length) {
    if (!r.errors.length) lines.push('No matching notes.');
    return lines.join('\n');
  }
  const max = opts.maxRows ?? 200;
  const cell = (v: QueryValue) => (v == null ? '' : textOf(v)).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  let lastGroup: string | undefined;
  const header = [...(r.showName ? ['Note'] : []), ...r.columns.map((c) => c.label)];
  const shown = r.rows.slice(0, max);
  const tableHead = () => {
    if (r.view === 'table' && header.length > 1) lines.push(`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`);
  };
  if (!r.grouped) tableHead();
  for (const row of shown) {
    if (r.grouped) {
      const g = row.group == null ? '(none)' : textOf(row.group);
      if (g !== lastGroup) {
        lines.push('', `## ${g}`);
        tableHead();
        lastGroup = g;
      }
    }
    const name = `[[${row.path.replace(/\.md$/, '')}]]`;
    if (r.view === 'table' && header.length > 1) lines.push(`| ${[...(r.showName ? [name] : []), ...row.values.map(cell)].join(' | ')} |`);
    else {
      const extra = row.values.map(cell).filter(Boolean).join(' · ');
      lines.push(`- ${r.showName ? name : ''}${extra ? `${r.showName ? ': ' : ''}${extra}` : ''}`);
    }
  }
  lines.push('', `${r.total} note${r.total === 1 ? '' : 's'}${r.total > shown.length ? ` (showing ${shown.length})` : ''}`);
  return lines.join('\n').trim();
}
