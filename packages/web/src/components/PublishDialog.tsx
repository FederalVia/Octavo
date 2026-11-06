import { useEffect, useState } from 'react';
import { Overlay } from './Modal';
import { api, getToken } from '../api';

type Scope = 'marked' | 'all' | 'folder' | 'tag';

/** Publish notes as a static website, downloaded as a zip you can upload to any static host. */
export function PublishDialog({ folders, tags, vaultName, onClose }: { folders: string[]; tags: string[]; vaultName: string; onClose: () => void }) {
  const [scope, setScope] = useState<Scope>('marked');
  const [folder, setFolder] = useState(folders[0] ?? '');
  const [tag, setTag] = useState(tags[0] ?? '');
  const [title, setTitle] = useState(vaultName);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // How many notes will go out, using the same rules as the publisher.
  useEffect(() => {
    let cancelled = false;
    const q =
      scope === 'marked'
        ? 'LIST WHERE publish = true'
        : scope === 'all'
          ? 'LIST FROM not "Templates" WHERE publish != false'
          : scope === 'folder'
            ? `LIST FROM "${folder.replace(/"/g, '')}" WHERE publish != false`
            : `LIST FROM #${tag.replace(/[^\p{L}\p{N}_/-]/gu, '')} WHERE publish != false`;
    setCount(null);
    api
      .query(q)
      .then((r) => !cancelled && setCount(r.errors.length ? null : r.total))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [scope, folder, tag]);

  const download = async () => {
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('scope', scope === 'all' ? 'all' : 'marked');
      if (scope === 'folder') params.set('folder', folder);
      if (scope === 'tag') params.set('tag', tag);
      if (title.trim()) params.set('title', title.trim());
      const token = getToken();
      const res = await fetch(`api/publish.zip?${params}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? res.statusText);
      const blob = await res.blob();
      const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition') ?? '')?.[1];
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name ? decodeURIComponent(name) : 'site.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <div
        className="dialog publish-dialog"
        role="dialog"
        aria-label="Publish as a website"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h3>Publish as a website</h3>
        <p className="muted small">
          Builds plain web pages from your notes, with links, backlinks, tags and search. Upload the folder to any free static host
          (GitHub Pages, Netlify, Cloudflare Pages). Links to notes you don’t publish turn into plain text, and locked notes are never included.
        </p>
        <fieldset className="publish-scope">
          <label>
            <input type="radio" checked={scope === 'marked'} onChange={() => setScope('marked')} /> Notes marked <code>publish: true</code>
          </label>
          <label>
            <input type="radio" checked={scope === 'folder'} onChange={() => setScope('folder')} disabled={!folders.length} /> A folder
            {scope === 'folder' && (
              <select value={folder} onChange={(e) => setFolder(e.target.value)}>
                {folders.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label>
            <input type="radio" checked={scope === 'tag'} onChange={() => setScope('tag')} disabled={!tags.length} /> A tag
            {scope === 'tag' && (
              <select value={tag} onChange={(e) => setTag(e.target.value)}>
                {tags.map((t) => (
                  <option key={t} value={t}>
                    #{t}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label>
            <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> Everything (except templates)
          </label>
        </fieldset>
        <label className="publish-title">
          Site title
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <p className="small">{count === null ? ' ' : count === 0 ? 'No notes match yet.' : `${count} note${count === 1 ? '' : 's'} will be published.`}</p>
        {scope === 'marked' && count === 0 && (
          <p className="muted small">To publish a note, open it and run “Publish this note” from the command palette, or add <code>publish: true</code> to its properties.</p>
        )}
        {error && <p className="error small">{error}</p>}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={download} disabled={busy || count === 0}>
            {busy ? 'Building…' : 'Download site (.zip)'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
