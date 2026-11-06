import { useEffect, useState } from 'react';
import { api, type NoteDetail } from '../api';
import { Preview } from './Preview';

/** A second note shown alongside the main one, in reading view. */
export function SplitPane({
  path,
  refreshKey,
  exists,
  namesKey,
  style,
  onNavigate,
  onSwap,
  onClose,
}: {
  path: string;
  refreshKey: number;
  exists: (target: string) => boolean;
  namesKey: string;
  style?: React.CSSProperties;
  /** A link inside the split was clicked: show that note here. */
  onNavigate: (path: string) => void;
  /** Make this note the main (editable) one. */
  onSwap: () => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api
      .note(path)
      .then((n) => live && (setNote(n), setError('')))
      .catch(() => live && setError('This note can’t be loaded.'));
    return () => {
      live = false;
    };
  }, [path, refreshKey]);
  return (
    <section className="split-panel" style={style} aria-label="Split view">
      <header className="panel-header">
        <div className="panel-title">
          {note?.folder && <span className="crumb">{note.folder} / </span>}
          <span>{note?.name ?? path.replace(/\.md$/, '').split('/').pop()}</span>
        </div>
        <button className="icon-btn" title="Open this note in the main pane (to edit it)" onClick={onSwap}>
          ⇄
        </button>
        <button className="icon-btn" title="Close split view" onClick={onClose}>
          ✕
        </button>
      </header>
      {error && <div className="placeholder muted">{error}</div>}
      {note?.encrypted && <div className="placeholder muted">🔒 This note is locked. Open it in the main pane to unlock it.</div>}
      {note && !note.encrypted && (
        <Preview
          content={note.content}
          path={note.path}
          exists={exists}
          namesKey={namesKey}
          onOpenLink={async (target) => {
            if (!target) return;
            const r = await api.resolve(target, note.path).catch(() => ({ path: null }));
            if (r.path) onNavigate(r.path);
          }}
          onTag={() => {}}
        />
      )}
    </section>
  );
}
