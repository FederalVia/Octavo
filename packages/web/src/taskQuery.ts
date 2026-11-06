/**
 * ```tasks query blocks: a small, line-based filter language over the vault's tasks.
 *
 *   not done                      done
 *   due before 2026-12-01         due after today       due on tomorrow
 *   due before in 7 days          has due date          no due date
 *   path includes Projects        text includes urgent  tag includes #work
 *   sort by due | path            limit 10              group by note | due
 *
 * Lines starting with // are comments. Lines that aren't understood are reported back.
 */
import type { Task } from './api';

export interface TaskQuery {
  done?: boolean;
  filters: ((t: Task, today: string) => boolean)[];
  sort: 'due' | 'path' | null;
  limit: number | null;
  group: 'note' | 'due' | null;
  errors: string[];
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "2026-12-01", "today", "tomorrow", "yesterday", "in 7 days", "7 days ago" → YYYY-MM-DD */
export function resolveDate(word: string, now = new Date()): string | null {
  const w = word.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  const shift = (days: number) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
  if (w === 'today') return shift(0);
  if (w === 'tomorrow') return shift(1);
  if (w === 'yesterday') return shift(-1);
  let m = /^in (\d+) (day|week)s?$/.exec(w);
  if (m) return shift(Number(m[1]) * (m[2] === 'week' ? 7 : 1));
  m = /^(\d+) (day|week)s? ago$/.exec(w);
  if (m) return shift(-Number(m[1]) * (m[2] === 'week' ? 7 : 1));
  if (w === 'next week') return shift(7);
  return null;
}

const isDone = (t: Task) => t.status === 'x' || t.status === 'X' || t.status === '-';

export function parseTaskQuery(src: string, now = new Date()): TaskQuery {
  const q: TaskQuery = { filters: [], sort: null, limit: null, group: null, errors: [] };
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('%%')) continue; // blank lines and comments
    const l = line.toLowerCase();
    let m: RegExpExecArray | null;
    if (l === 'not done') q.done = false;
    else if (l === 'done') q.done = true;
    else if (l === 'has due date') q.filters.push((t) => !!t.due);
    else if (l === 'no due date') q.filters.push((t) => !t.due);
    else if ((m = /^due (before|after|on) (.+)$/.exec(l))) {
      const date = resolveDate(m[2], now);
      if (!date) q.errors.push(`Unknown date in “${line}”`);
      else if (m[1] === 'before') q.filters.push((t) => !!t.due && t.due < date);
      else if (m[1] === 'after') q.filters.push((t) => !!t.due && t.due > date);
      else q.filters.push((t) => t.due === date);
    } else if ((m = /^(path|text|tag) (includes|does not include) (.+)$/.exec(l))) {
      const needle = m[3].trim();
      const field = m[1];
      const has = (t: Task) => {
        if (field === 'path') return t.path.toLowerCase().includes(needle);
        if (field === 'tag') {
          const tag = needle.replace(/^#/, '');
          return new RegExp(`(^|\\s)#${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`, 'i').test(t.text);
        }
        return t.text.toLowerCase().includes(needle);
      };
      q.filters.push(m[2] === 'includes' ? has : (t) => !has(t));
    } else if ((m = /^sort by (due|path)$/.exec(l))) q.sort = m[1] as 'due' | 'path';
    else if ((m = /^group by (note|due)$/.exec(l))) q.group = m[1] as 'note' | 'due';
    else if ((m = /^limit (\d+)$/.exec(l))) q.limit = Number(m[1]);
    else q.errors.push(`Not understood: “${line}”`);
  }
  return q;
}

export function runTaskQuery(q: TaskQuery, tasks: Task[], now = new Date()): Task[] {
  const today = iso(now);
  let out = tasks.filter((t) => (q.done === undefined ? true : isDone(t) === q.done) && q.filters.every((f) => f(t, today)));
  if (q.sort === 'due') out = [...out].sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.path.localeCompare(b.path) || a.line - b.line);
  else if (q.sort === 'path') out = [...out].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  if (q.limit != null) out = out.slice(0, q.limit);
  return out;
}
