import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Island } from '../api';

/**
 * Settings → Islands: folders kept apart from the six regions in the brain views, each with its own
 * area and colour (e.g. a Theology folder in a vault that's mostly about software).
 */
export function IslandsSection() {
  const [islands, setIslands] = useState<Island[] | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const colourTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.islands(), api.notes()])
      .then(([i, n]) => {
        if (!live) return;
        setIslands(i.islands);
        setFolders(n.folders.slice().sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => live && setError('Couldn’t load islands.'));
    return () => {
      live = false;
    };
  }, []);

  const save = async (next: Partial<Island>[]) => {
    setBusy(true);
    setError('');
    try {
      setIslands((await api.setIslands(next)).islands);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!islands) return <p className="muted small">{error || 'Loading…'}</p>;
  const taken = new Set(islands.map((i) => i.folder.toLowerCase()));
  const free = folders.filter((f) => !taken.has(f.toLowerCase()));
  // Rename/recolour on blur or pick, not on every keystroke.
  const update = (id: string, change: Partial<Island>) => save(islands.map((i) => (i.id === id ? { ...i, ...change } : i)));

  return (
    <>
      <p className="muted small settings-note">
        Keep a separate subject apart: every note in an island’s folder gets its own area and colour in the brain and network views, instead of being
        mixed into the six regions. A note elsewhere can join with <code>region: Island name</code> in its properties.
      </p>
      {islands.map((i) => (
        <div className="setting-row island-row" key={i.id}>
          <input
            type="color"
            className="island-color"
            value={i.color}
            aria-label={`Colour of ${i.name}`}
            onChange={(e) => {
              // A colour picker fires on every move: show it now, save once it settles.
              const color = e.target.value;
              const next = islands.map((x) => (x.id === i.id ? { ...x, color } : x));
              setIslands(next);
              if (colourTimer.current) clearTimeout(colourTimer.current);
              colourTimer.current = setTimeout(() => void save(next), 400);
            }}
          />
          <div className="island-info">
            <input
              className="input island-name"
              defaultValue={i.name}
              aria-label="Island name"
              disabled={busy}
              onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== i.name && void update(i.id, { name: e.target.value.trim() })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <span className="muted small">{i.folder}/</span>
          </div>
          <button className="btn" disabled={busy} onClick={() => void save(islands.filter((x) => x.id !== i.id))} title="Put these notes back in the regions">
            Remove
          </button>
        </div>
      ))}
      <div className="setting-row">
        <div>
          <b>{islands.length ? 'Add another island' : 'Make a folder an island'}</b>
          <span className="muted small">Up to 12. Subfolders come along.</span>
        </div>
        <div className="island-add">
          <select className="input select" value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy || !free.length || islands.length >= 12}>
            <option value="">{free.length ? 'Choose a folder…' : 'No folders left'}</option>
            {free.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <button
            className="btn primary"
            disabled={busy || !pick}
            onClick={() => {
              void save([...islands, { folder: pick }]);
              setPick('');
            }}
          >
            Add
          </button>
        </div>
      </div>
      {error && <p className="error small">{error}</p>}
    </>
  );
}
