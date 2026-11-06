/**
 * ```query / ```dataview / ```base blocks in the reading view: a live table, list or cards of notes.
 * Property columns are editable in place (click a cell), headers sort, and the block refreshes
 * whenever the vault changes.
 */
import { api, type QueryResult, type QueryValue } from '../api';

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function text(v: QueryValue): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(text).join(', ');
  return String(v);
}

/** A value as HTML: [[links]] become links, lists become chips, true/false become marks. */
function valueHtml(v: QueryValue): string {
  if (v == null || v === '') return '<span class="nq-empty">—</span>';
  if (Array.isArray(v)) return v.map((x) => `<span class="nq-chip">${valueHtml(x)}</span>`).join('');
  if (typeof v === 'boolean') return v ? '<span class="nq-yes" title="true">✓</span>' : '<span class="nq-no" title="false">✗</span>';
  const s = String(v);
  const parts: string[] = [];
  let last = 0;
  for (const m of s.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)) {
    parts.push(esc(s.slice(last, m.index)));
    parts.push(`<a class="wikilink" href="#" data-target="${esc(m[1].trim())}">${esc((m[2] ?? m[1]).trim())}</a>`);
    last = m.index! + m[0].length;
  }
  parts.push(esc(s.slice(last)));
  return parts.join('');
}

const noteLink = (row: { path: string; name: string }) => `<a class="wikilink nq-name" href="#" data-target="${esc(row.path)}">${esc(row.name)}</a>`;

type Row = QueryResult['rows'][number];

interface State {
  result: QueryResult;
  sortCol: number | null; // -1 = note name
  sortDesc: boolean;
}

const states = new WeakMap<HTMLElement, State>();

function cmp(a: QueryValue, b: QueryValue): number {
  const ea = a == null || a === '';
  const eb = b == null || b === '';
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: 'base' });
}

function sortedRows(st: State): Row[] {
  const rows = [...st.result.rows];
  if (st.sortCol == null) return rows;
  const col = st.sortCol;
  rows.sort((x, y) => {
    const e = (v: QueryValue) => v == null || v === '';
    const a = col < 0 ? x.name : x.values[col];
    const b = col < 0 ? y.name : y.values[col];
    if (e(a) !== e(b)) return e(a) ? 1 : -1; // empty last either way
    const c = cmp(a, b);
    return st.sortDesc ? -c : c;
  });
  return rows;
}

function cell(row: Row, i: number, r: QueryResult): string {
  const col = r.columns[i];
  const v = row.values[i];
  const short = typeof v === 'number' || (typeof v === 'string' && v.length <= 20 && !/\s/.test(v)) ? ' nq-nowrap' : '';
  if (!col.property) return `<td class="${short.trim()}">${valueHtml(v)}</td>`;
  return `<td class="nq-editable${short}" tabindex="0" title="Click to edit" data-path="${esc(row.path)}" data-key="${esc(col.property)}" data-kind="${Array.isArray(v) ? 'list' : typeof v}" data-raw="${esc(text(v))}">${valueHtml(v)}</td>`;
}

function draw(el: HTMLElement) {
  const st = states.get(el);
  if (!st) return;
  const r = st.result;
  const errors = r.errors.length ? `<div class="tq-errors">${r.errors.map(esc).join('<br>')}</div>` : '';
  if (!r.rows.length) {
    el.innerHTML = errors + (r.errors.length ? '' : '<div class="muted small">No matching notes.</div>');
    return;
  }
  const rows = r.grouped ? r.rows : sortedRows(st);
  const groups: { key: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const key = r.grouped ? (row.group == null || row.group === '' ? '(none)' : text(row.group)) : '';
    if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, rows: [] });
    groups[groups.length - 1].rows.push(row);
  }
  const arrow = (i: number) => (st.sortCol === i ? (st.sortDesc ? ' ↓' : ' ↑') : '');
  const body = groups
    .map((g) => {
      const head = r.grouped ? `<div class="tq-group">${esc(g.key)} <span class="nq-count">${g.rows.length}</span></div>` : '';
      if (r.view === 'list') {
        return `${head}<ul class="nq-list">${g.rows
          .map((row) => {
            const extra = row.values.map((v) => valueHtml(v)).filter((h) => !h.includes('nq-empty'));
            return `<li>${r.showName ? noteLink(row) : ''}${extra.length ? `${r.showName ? '<span class="nq-sep">·</span>' : ''}${extra.join('<span class="nq-sep">·</span>')}` : ''}</li>`;
          })
          .join('')}</ul>`;
      }
      if (r.view === 'cards') {
        return `${head}<div class="nq-cards">${g.rows
          .map(
            (row) =>
              `<div class="nq-card">${r.showName ? `<div class="nq-card-title">${noteLink(row)}</div>` : ''}${r.columns
                .map((c, i) => `<div class="nq-card-field"><span class="nq-card-label">${esc(c.label)}</span>${valueHtml(row.values[i])}</div>`)
                .join('')}</div>`,
          )
          .join('')}</div>`;
      }
      const ths = `${r.showName ? `<th data-col="-1">Note${arrow(-1)}</th>` : ''}${r.columns.map((c, i) => `<th data-col="${i}">${esc(c.label)}${arrow(i)}</th>`).join('')}`;
      const trs = g.rows.map((row) => `<tr>${r.showName ? `<td>${noteLink(row)}</td>` : ''}${row.values.map((_, i) => cell(row, i, r)).join('')}</tr>`).join('');
      return `${head}<div class="nq-table-wrap"><table class="nq-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
    })
    .join('');
  const more = r.total > r.rows.length ? ` (showing ${r.rows.length})` : '';
  el.innerHTML = `${errors}${body}<div class="nq-foot">${r.total} note${r.total === 1 ? '' : 's'}${more}</div>`;
}

function parseInput(raw: string, kind: string): unknown {
  const t = raw.trim();
  if (t === '') return null;
  if (kind === 'list') return t.split(',').map((x) => x.trim()).filter(Boolean);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  return t;
}

function startEdit(el: HTMLElement, td: HTMLElement) {
  if (td.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'nq-input';
  input.value = td.dataset.raw ?? '';
  if (td.dataset.kind === 'list') input.placeholder = 'a, b, c';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save: boolean) => {
    if (finished) return;
    finished = true;
    if (save && input.value !== (td.dataset.raw ?? '')) {
      td.classList.add('nq-saving');
      try {
        await api.setProperty(td.dataset.path ?? '', td.dataset.key ?? '', parseInput(input.value, td.dataset.kind ?? ''));
      } catch (err) {
        alert(`Couldn't save: ${(err as Error).message}`);
      }
    }
    await refresh(el);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') void finish(true);
    if (e.key === 'Escape') {
      e.preventDefault();
      void finish(false);
    }
  });
  input.addEventListener('blur', () => void finish(true));
}

function wire(el: HTMLElement) {
  if (el.dataset.wired) return;
  el.dataset.wired = '1';
  el.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const th = target.closest('th[data-col]') as HTMLElement | null;
    if (th) {
      const st = states.get(el);
      if (!st) return;
      const col = Number(th.dataset.col);
      if (st.sortCol === col) {
        if (st.sortDesc) st.sortCol = null; // third click: back to the query's order
        st.sortDesc = !st.sortDesc;
      } else {
        st.sortCol = col;
        st.sortDesc = false;
      }
      draw(el);
      return;
    }
    if (target.closest('a')) return; // links open notes (handled by the reading view)
    const td = target.closest('td.nq-editable') as HTMLElement | null;
    if (td) {
      e.stopPropagation();
      startEdit(el, td);
    }
  });
  el.addEventListener('keydown', (e) => {
    const td = (e.target as HTMLElement).closest?.('td.nq-editable') as HTMLElement | null;
    if (td && e.key === 'Enter' && !td.querySelector('input')) {
      e.preventDefault();
      startEdit(el, td);
    }
  });
}

async function refresh(el: HTMLElement) {
  const q = decodeURIComponent(el.dataset.q ?? '');
  const lang = el.dataset.lang === 'base' ? 'base' : 'dql';
  try {
    const result = await api.query(q, { lang, from: el.dataset.from || undefined });
    const prev = states.get(el);
    states.set(el, { result, sortCol: prev?.sortCol ?? null, sortDesc: prev?.sortDesc ?? false });
  } catch {
    el.innerHTML = '<div class="muted small">Couldn’t run the query.</div>';
    return;
  }
  draw(el);
}

/** Render one block (called by the reading view after it renders Markdown). */
export async function renderNoteQuery(el: HTMLElement, fromPath: string) {
  el.dataset.from = fromPath;
  wire(el);
  live.add(el);
  await refresh(el);
}

// Keep every visible block up to date when notes change (debounced; skipped while a cell is being edited).
const live = new Set<HTMLElement>();
let timer: ReturnType<typeof setTimeout> | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('octavo:vault-change', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      for (const el of [...live]) {
        if (!el.isConnected) {
          live.delete(el);
          continue;
        }
        if (el.querySelector('input.nq-input')) continue;
        void refresh(el);
      }
    }, 500);
  });
}
