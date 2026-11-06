import { useEffect, useState } from 'react';
import YAML from 'yaml';

type PropType = 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'other';

interface Row {
  id: number;
  key: string;
  type: PropType;
  /** Text for text/number/date/list (comma-separated); "true"/"false" for checkbox. */
  value: string;
  /** Original value for "other" (nested YAML), kept as-is. */
  raw?: unknown;
}

const LIST_KEYS = new Set(['tags', 'aliases', 'cssclasses']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function inferRow(key: string, v: unknown, id: number): Row {
  if (Array.isArray(v) && v.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) return { id, key, type: 'list', value: v.join(', ') };
  if (typeof v === 'boolean') return { id, key, type: 'checkbox', value: String(v) };
  if (typeof v === 'number') return { id, key, type: 'number', value: String(v) };
  if (typeof v === 'string') return { id, key, type: DATE_RE.test(v) ? 'date' : LIST_KEYS.has(key) ? 'list' : 'text', value: v };
  if (v == null) return { id, key, type: LIST_KEYS.has(key) ? 'list' : 'text', value: '' };
  return { id, key, type: 'other', value: YAML.stringify(v).trim(), raw: v };
}

function rowValue(r: Row): unknown {
  switch (r.type) {
    case 'list':
      return r.value
        .split(',')
        .map((s) => (r.key === 'tags' ? s.trim().replace(/^#/, '') : s.trim()))
        .filter(Boolean);
    case 'number':
      return r.value.trim() === '' || Number.isNaN(Number(r.value)) ? r.value : Number(r.value);
    case 'checkbox':
      return r.value === 'true';
    case 'other':
      return r.raw;
    default:
      return r.value;
  }
}

/** Replace (or add, or remove) the YAML frontmatter of a note. */
export function setFrontmatter(content: string, data: Record<string, unknown>): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  const body = m ? content.slice(m[0].length) : content;
  if (!Object.keys(data).length) return body.replace(/^\r?\n/, '');
  const yaml = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${m ? body : body.startsWith('\n') ? body : `\n${body}`}`;
}

function renderValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(renderValue).join(', ');
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v ?? '');
}

let nextId = 1;

export function Properties({
  frontmatter,
  content,
  onEditContent,
  openSignal,
}: {
  frontmatter: Record<string, unknown> | null;
  content: string;
  onEditContent?: (content: string) => void;
  /** Changes to open the editor from outside (command palette). */
  openSignal?: number;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const editing = rows !== null;
  const start = () => {
    const list = Object.entries(frontmatter ?? {}).map(([k, v]) => inferRow(k, v, nextId++));
    setRows(list.length ? list : [{ id: nextId++, key: '', type: 'text', value: '' }]);
  };
  useEffect(() => {
    if (openSignal && onEditContent) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);

  const entries = Object.entries(frontmatter ?? {});
  if (!editing) {
    if (!entries.length) return null;
    return (
      <div className="properties-wrap">
        <table className="properties">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{renderValue(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {onEditContent && (
          <button type="button" className="properties-edit" onClick={start} title="Edit properties">
            Edit
          </button>
        )}
      </div>
    );
  }

  const update = (id: number, patch: Partial<Row>) => setRows((rs) => rs!.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const keys = rows.map((r) => r.key.trim()).filter(Boolean);
  const duplicate = keys.find((k, i) => keys.indexOf(k) !== i);
  const save = () => {
    const data: Record<string, unknown> = {};
    for (const r of rows) if (r.key.trim()) data[r.key.trim()] = rowValue(r);
    onEditContent?.(setFrontmatter(content, data));
    setRows(null);
  };

  return (
    <div className="properties-editor">
      {rows.map((r) => (
        <div className="prop-row" key={r.id}>
          <input className="input prop-key" placeholder="name" value={r.key} onChange={(e) => update(r.id, { key: e.target.value })} aria-label="Property name" />
          <select
            className="input select prop-type"
            value={r.type}
            disabled={r.type === 'other'}
            onChange={(e) => {
              const type = e.target.value as PropType;
              update(r.id, { type, value: type === 'checkbox' ? (r.value === 'true' ? 'true' : 'false') : r.type === 'checkbox' ? '' : r.value });
            }}
            aria-label="Property type"
          >
            <option value="text">Text</option>
            <option value="list">List</option>
            <option value="number">Number</option>
            <option value="checkbox">Checkbox</option>
            <option value="date">Date</option>
            {r.type === 'other' && <option value="other">YAML</option>}
          </select>
          {r.type === 'checkbox' ? (
            <input type="checkbox" className="switch" checked={r.value === 'true'} onChange={(e) => update(r.id, { value: String(e.target.checked) })} aria-label={r.key || 'value'} />
          ) : r.type === 'other' ? (
            <code className="prop-other" title="Nested values are kept as they are. Edit them in Edit mode.">
              {r.value}
            </code>
          ) : (
            <input
              className="input prop-value"
              type={r.type === 'date' ? 'date' : r.type === 'number' ? 'number' : 'text'}
              placeholder={r.type === 'list' ? 'one, two, three' : 'value'}
              value={r.value}
              onChange={(e) => update(r.id, { value: e.target.value })}
              aria-label={r.key || 'value'}
            />
          )}
          <button type="button" className="icon-btn" title="Remove property" onClick={() => setRows((rs) => rs!.filter((x) => x.id !== r.id))}>
            ✕
          </button>
        </div>
      ))}
      <div className="prop-actions">
        <button type="button" className="btn" onClick={() => setRows((rs) => [...rs!, { id: nextId++, key: '', type: 'text', value: '' }])}>
          ＋ Add property
        </button>
        <span className="prop-spacer" />
        {duplicate && <span className="small prop-error">“{duplicate}” appears twice</span>}
        <button type="button" className="btn" onClick={() => setRows(null)}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!!duplicate} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
