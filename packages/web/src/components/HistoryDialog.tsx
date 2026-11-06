import { useEffect, useState } from 'react';
import { api, type Version } from '../api';
import { Overlay } from './Modal';

interface Props {
  path: string;
  current: string;
  /** Turn a stored version into readable text (decrypts versions of locked notes). */
  decode?: (stored: string) => Promise<string>;
  onRestored: () => void;
  onClose: () => void;
}

/** A tiny line diff (LCS) so you can see what changed between versions. */
function diffLines(a: string, b: string): { type: ' ' | '+' | '-'; text: string }[] {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 400_000) return y.map((text) => ({ type: ' ', text }));
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { type: ' ' | '+' | '-'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) out.push({ type: ' ', text: x[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: '-', text: x[i++] });
    else out.push({ type: '+', text: y[j++] });
  }
  while (i < x.length) out.push({ type: '-', text: x[i++] });
  while (j < y.length) out.push({ type: '+', text: y[j++] });
  return out;
}

/** File recovery: browse saved versions of a note, see what changed, restore one. */
export function HistoryDialog({ path, current, decode, onRestored, onClose }: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [selected, setSelected] = useState<Version | null>(null);
  const [content, setContent] = useState<string>('');
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .history(path)
      .then((r) => {
        setVersions(r.versions);
        if (r.versions[0]) setSelected(r.versions[0]);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [path]);

  useEffect(() => {
    if (!selected) return;
    api
      .version(path, selected.id)
      .then(async (r) => {
        if (!decode) return setContent(r.content);
        try {
          setContent(await decode(r.content));
        } catch {
          setContent('🔒 This version was encrypted with a different password and can’t be shown.');
        }
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [path, selected]);

  const restore = async () => {
    if (!selected) return;
    try {
      await api.restore(path, selected.id);
      onRestored();
      onClose();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const diff = selected ? diffLines(content, current) : [];

  return (
    <Overlay onClose={onClose}>
      <div className="history-dialog" onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), onClose())}>
        <header>
          <h3>Version history</h3>
          <span className="muted small">{path}</span>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </header>
        {error && <div className="banner">{error}</div>}
        <div className="history-body">
          <div className="history-list">
            {versions?.length === 0 && (
              <div className="muted small empty">
                No saved versions yet. A snapshot is kept each time the note is changed (at most every 5 minutes).
              </div>
            )}
            {versions?.map((v) => (
              <button key={v.id} className={`history-item${selected?.id === v.id ? ' active' : ''}`} onClick={() => setSelected(v)}>
                <b>{new Date(v.time).toLocaleString()}</b>
                <span className="muted small">{v.size} bytes</span>
              </button>
            ))}
          </div>
          <div className="history-preview">
            {selected ? (
              <>
                <div className="muted small history-legend">
                  Changes from this version to the current note: <span className="diff-add">+ added</span> <span className="diff-del">− removed</span>
                </div>
                <pre className="history-diff">
                  {diff.map((d, i) => (
                    <div key={i} className={d.type === '+' ? 'diff-add' : d.type === '-' ? 'diff-del' : ''}>
                      {d.type === ' ' ? '  ' : d.type === '+' ? '+ ' : '− '}
                      {d.text}
                    </div>
                  ))}
                </pre>
              </>
            ) : (
              <div className="muted empty">Select a version</div>
            )}
          </div>
        </div>
        <footer>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!selected} onClick={restore}>
            Restore this version
          </button>
        </footer>
      </div>
    </Overlay>
  );
}
