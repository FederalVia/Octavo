import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, setToken, subscribe, type GraphData, type NoteDetail, type NoteSummary, type VaultEvent } from './api';
import { Editor, type EditorHandle } from './components/Editor';
import { Preview } from './components/Preview';
import { FileTree } from './components/FileTree';
import { GraphView } from './components/GraphView';
import { QuickSwitcher } from './components/QuickSwitcher';
import { Dialog, type DialogRequest } from './components/Modal';
import { RightPanel, SearchPanel, TagsPanel } from './components/Panels';
import { wordCount } from './markdown';

type Mode = 'edit' | 'preview';
type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
type Route = { view: 'note'; path: string } | { view: 'graph' } | { view: 'home' };

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function parseHash(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (h.startsWith('note/')) return { view: 'note', path: h.slice(5) };
  if (h === 'graph') return { view: 'graph' };
  return { view: 'home' };
}

function noteHash(path: string): string {
  return `#/note/${path.split('/').map(encodeURIComponent).join('/')}`;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl';
const narrow = () => window.matchMedia('(max-width: 800px)').matches;

export function App() {
  const [vaultName, setVaultName] = useState('');
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [route, setRoute] = useState<Route>(parseHash);
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [version, setVersion] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [mode, setMode] = useState<Mode>(() => load('ultron.mode', 'preview'));
  const [leftTab, setLeftTab] = useState<'files' | 'search' | 'tags'>('files');
  const [query, setQuery] = useState('');
  const [searchFocus, setSearchFocus] = useState(0);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [showLeft, setShowLeft] = useState(() => !narrow() && load('ultron.left', true));
  const [showRight, setShowRight] = useState(() => !narrow() && load('ultron.right', true));
  const [lineNumbers, setLineNumbers] = useState(() => load('ultron.lineNumbers', false));
  const [switcher, setSwitcher] = useState(false);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [connected, setConnected] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingHeading, setPendingHeading] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  const currentPath = route.view === 'note' ? route.path : null;
  const editor = useRef<EditorHandle | null>(null);
  const pendingLine = useRef<number | null>(null);
  const draftRef = useRef('');
  const dirty = useRef(false);
  const baseMtime = useRef<number | undefined>(undefined);
  const saving = useRef(false);
  const needsRefresh = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedPath = useRef<string | null>(null);

  useEffect(() => store('ultron.mode', mode), [mode]);
  useEffect(() => void (!narrow() && store('ultron.left', showLeft)), [showLeft]);
  useEffect(() => void (!narrow() && store('ultron.right', showRight)), [showRight]);
  useEffect(() => store('ultron.lineNumbers', lineNumbers), [lineNumbers]);
  const [isNarrow, setIsNarrow] = useState(narrow);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 800px)');
    const onChange = () => {
      setIsNarrow(mq.matches);
      // Sidebars become overlays on small screens: start closed.
      if (mq.matches) {
        setShowLeft(false);
        setShowRight(false);
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // ---------------------------------------------------------------- dialogs
  const prompt = useCallback(
    (title: string, initial = '', opts: { message?: string; confirmLabel?: string; placeholder?: string } = {}) =>
      new Promise<string | null>((resolve) => setDialog({ kind: 'prompt', title, initial, resolve, ...opts })),
    [],
  );
  const confirm = useCallback(
    (title: string, message?: string, opts: { confirmLabel?: string; danger?: boolean } = {}) =>
      new Promise<boolean>((resolve) => setDialog({ kind: 'confirm', title, message, resolve, ...opts })),
    [],
  );

  const handleError = useCallback(
    async (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        const token = await prompt('Access token required', '', {
          message: 'This vault is protected. Enter the token the server was started with (--token / ULTRON_TOKEN).',
          confirmLabel: 'Unlock',
        });
        if (token) {
          setToken(token);
          location.reload();
        }
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      await confirm('Something went wrong', message, { confirmLabel: 'OK' });
    },
    [prompt, confirm],
  );

  // ---------------------------------------------------------------- data
  const refreshNotes = useCallback(async () => {
    const r = await api.notes();
    setNotes(r.notes);
    return r.notes;
  }, []);

  const refreshGraph = useCallback(async () => {
    setGraph(await api.graph());
  }, []);

  const nameIndex = useMemo(() => {
    const names = new Set<string>();
    for (const n of notes) {
      names.add(n.name.toLowerCase());
      names.add(n.path.toLowerCase().replace(/\.md$/, ''));
    }
    return names;
  }, [notes]);
  const namesKey = useMemo(() => notes.map((n) => n.path).join('|'), [notes]);
  const exists = useCallback(
    (target: string) => {
      const t = target.toLowerCase().replace(/\.md$/, '');
      if (nameIndex.has(t)) return true;
      // Path-suffix match ("Folder/Note").
      if (t.includes('/')) for (const n of nameIndex) if (n.endsWith('/' + t)) return true;
      return false;
    },
    [nameIndex],
  );
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const noteNames = useCallback(() => {
    const counts = new Map<string, number>();
    for (const n of notesRef.current) counts.set(n.name.toLowerCase(), (counts.get(n.name.toLowerCase()) ?? 0) + 1);
    // Ambiguous names get their full path.
    return notesRef.current.map((n) => ((counts.get(n.name.toLowerCase()) ?? 0) > 1 ? n.path.replace(/\.md$/, '') : n.name));
  }, []);
  const tagNamesRef = useRef<string[]>([]);
  useEffect(() => {
    api
      .tags()
      .then((r) => (tagNamesRef.current = r.tags.map((t) => t.tag)))
      .catch(() => {});
  }, [refreshKey]);
  const tagNames = useCallback(() => tagNamesRef.current, []);

  // ---------------------------------------------------------------- saving
  const save = useCallback(
    async (force = false) => {
      const path = loadedPath.current;
      if (!path || (!dirty.current && !force) || saving.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saving.current = true;
      setSaveState('saving');
      const content = draftRef.current;
      try {
        const res = await api.save(path, content, force ? undefined : baseMtime.current);
        baseMtime.current = res.mtime;
        if (draftRef.current === content) {
          dirty.current = false;
          setSaveState('saved');
        } else {
          setSaveState('dirty');
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) setSaveState('conflict');
        else {
          setSaveState('error');
          if (err instanceof ApiError && err.status === 401) handleError(err);
        }
      } finally {
        saving.current = false;
      }
      if (dirty.current && loadedPath.current === path && saveStateRef.current === 'dirty') {
        saveTimer.current = setTimeout(() => save(), 700);
      }
      if (needsRefresh.current) {
        needsRefresh.current = false;
        refreshCurrentRef.current();
      }
    },
    [handleError],
  );
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;

  const onChange = useCallback(
    (value: string) => {
      draftRef.current = value;
      setDraft(value);
      dirty.current = true;
      if (saveStateRef.current !== 'conflict') {
        setSaveState('dirty');
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => save(), 700);
      }
    },
    [save],
  );

  // ---------------------------------------------------------------- loading
  const applyDetail = useCallback((d: NoteDetail, replaceContent: boolean) => {
    setDetail(d);
    setMissing(null);
    if (replaceContent) {
      draftRef.current = d.content;
      setDraft(d.content);
      baseMtime.current = d.mtime;
      dirty.current = false;
      setSaveState('saved');
      setVersion((v) => v + 1);
    }
  }, []);

  const loadNote = useCallback(
    async (path: string) => {
      try {
        const d = await api.note(path);
        if (d.path !== path) {
          // Resolved via a different spelling; normalize the URL.
          history.replaceState(null, '', noteHash(d.path));
          setRoute({ view: 'note', path: d.path });
        }
        loadedPath.current = d.path;
        applyDetail(d, true);
        if (pendingLine.current) {
          const line = pendingLine.current;
          pendingLine.current = null;
          setMode('edit');
          setTimeout(() => editor.current?.scrollToLine(line), 30);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          loadedPath.current = null;
          setDetail(null);
          setMissing(path);
        } else handleError(err);
      }
    },
    [applyDetail, handleError],
  );

  /** Re-sync the open note after something changed in the vault. */
  const refreshCurrent = useCallback(async () => {
    const path = loadedPath.current;
    if (!path) return;
    if (saving.current) {
      needsRefresh.current = true;
      return;
    }
    try {
      const d = await api.note(path);
      if (loadedPath.current !== path) return;
      const same = d.mtime === baseMtime.current || d.content === draftRef.current;
      if (same) {
        if (d.content === draftRef.current) baseMtime.current = d.mtime;
        applyDetail(d, false);
      } else if (!dirty.current) {
        applyDetail(d, true);
      } else {
        setDetail(d);
        setSaveState('conflict');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404 && loadedPath.current === path) {
        loadedPath.current = null;
        setDetail(null);
        setMissing(path);
      }
    }
  }, [applyDetail]);
  const refreshCurrentRef = useRef(refreshCurrent);
  refreshCurrentRef.current = refreshCurrent;

  // ---------------------------------------------------------------- navigation
  const navigate = useCallback(
    (path: string, opts: { line?: number; heading?: string; mode?: Mode } = {}) => {
      if (dirty.current) save();
      pendingLine.current = opts.line ?? null;
      setPendingHeading(opts.heading ?? null);
      if (opts.mode) setMode(opts.mode);
      if (narrow()) setShowLeft(false);
      const hash = noteHash(path);
      if (location.hash === hash) {
        if (opts.line) {
          setMode('edit');
          setTimeout(() => editor.current?.scrollToLine(opts.line!), 30);
        }
        if (route.view !== 'note') setRoute({ view: 'note', path });
      } else location.hash = hash;
    },
    [save, route.view],
  );

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (route.view === 'note' && route.path !== loadedPath.current) loadNote(route.path);
    if (route.view === 'graph') refreshGraph().catch(handleError);
  }, [route, loadNote, refreshGraph, handleError]);

  // ---------------------------------------------------------------- startup
  useEffect(() => {
    (async () => {
      try {
        const v = await api.vault();
        setVaultName(v.name);
        document.title = `${v.name} · Ultron Mind`;
        const list = await refreshNotes();
        refreshGraph().catch(() => {});
        if (parseHash().view === 'home') {
          const home =
            list.find((n) => /^(home|index|readme)\.md$/i.test(n.path)) ?? [...list].sort((a, b) => b.mtime - a.mtime)[0];
          if (home) history.replaceState(null, '', noteHash(home.path)), setRoute({ view: 'note', path: home.path });
        }
        setReady(true);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) handleError(err);
        else setFatal(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [refreshNotes, refreshGraph, handleError]);

  // Live updates from the server (edits by Claude, other windows, other editors).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribe(
      (e: VaultEvent) => {
        if (e.type === 'rename' && e.from === loadedPath.current) {
          loadedPath.current = e.to;
          history.replaceState(null, '', noteHash(e.to));
          setRoute({ view: 'note', path: e.to });
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          refreshNotes().catch(() => {});
          refreshGraph().catch(() => {});
          refreshCurrentRef.current();
          setRefreshKey((k) => k + 1);
        }, 150);
      },
      (ok) => {
        setConnected(ok);
        if (ok) {
          // Catch up on anything missed while disconnected.
          refreshNotes().catch(() => {});
          refreshCurrentRef.current();
        }
      },
    );
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [refreshNotes, refreshGraph]);

  useEffect(() => {
    const flush = () => {
      if (dirty.current) save();
    };
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        save();
        e.preventDefault();
      }
    };
    window.addEventListener('blur', flush);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('blur', flush);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [save]);

  // ---------------------------------------------------------------- actions
  const createNote = useCallback(
    async (path: string, content?: string) => {
      const name = path.replace(/\.md$/i, '').split('/').pop()!;
      try {
        const s = await api.create(path, content ?? `# ${name}\n\n`);
        await refreshNotes();
        navigate(s.path, { mode: 'edit' });
        setTimeout(() => editor.current?.focus(), 60);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const r = await api.resolve(path);
          if (r.path) navigate(r.path);
        } else handleError(err);
      }
    },
    [refreshNotes, navigate, handleError],
  );

  const newNote = useCallback(
    async (folder?: string) => {
      const base = folder ?? (detail?.folder || '');
      let name = 'Untitled';
      let i = 1;
      const taken = new Set(notesRef.current.map((n) => n.path.toLowerCase()));
      while (taken.has(`${base ? base + '/' : ''}${name}.md`.toLowerCase())) name = `Untitled ${i++}`;
      const p = await prompt('New note', `${base ? base + '/' : ''}${name}`, {
        message: 'Use "Folder/Name" to put it in a folder.',
        confirmLabel: 'Create',
      });
      if (p) createNote(p);
    },
    [detail, prompt, createNote],
  );

  const openLink = useCallback(
    async (target: string, heading?: string) => {
      if (!target) {
        if (heading) setPendingHeading(heading);
        return;
      }
      try {
        const r = await api.resolve(target, loadedPath.current ?? undefined);
        if (r.path) navigate(r.path, { heading });
        else createNote(target);
      } catch (err) {
        handleError(err);
      }
    },
    [navigate, createNote, handleError],
  );

  const renameNote = useCallback(
    async (path: string) => {
      const to = await prompt('Rename / move note', path.replace(/\.md$/, ''), {
        message: 'Links to this note will be updated automatically.',
        confirmLabel: 'Rename',
      });
      if (!to || to === path.replace(/\.md$/, '')) return;
      try {
        if (path === loadedPath.current && dirty.current) await save();
        const r = await api.rename(path, to);
        await refreshNotes();
        if (path === loadedPath.current) {
          loadedPath.current = r.to;
          history.replaceState(null, '', noteHash(r.to));
          setRoute({ view: 'note', path: r.to });
          refreshCurrentRef.current();
        }
      } catch (err) {
        handleError(err);
      }
    },
    [prompt, save, refreshNotes, handleError],
  );

  const moveNote = useCallback(
    async (path: string, folder: string) => {
      const name = path.split('/').pop()!;
      const to = folder ? `${folder}/${name}` : name;
      if (to === path) return;
      try {
        const r = await api.rename(path, to);
        await refreshNotes();
        if (path === loadedPath.current) {
          loadedPath.current = r.to;
          history.replaceState(null, '', noteHash(r.to));
          setRoute({ view: 'note', path: r.to });
        }
      } catch (err) {
        handleError(err);
      }
    },
    [refreshNotes, handleError],
  );

  const deleteNote = useCallback(
    async (path: string) => {
      const ok = await confirm(`Delete “${path.replace(/\.md$/, '')}”?`, 'It will be moved to the vault’s .trash folder.', {
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        if (path === loadedPath.current) {
          dirty.current = false;
          loadedPath.current = null;
        }
        await api.remove(path);
        const list = await refreshNotes();
        if (route.view === 'note' && route.path === path) {
          const home = list.find((n) => /^(home|index|readme)\.md$/i.test(n.path)) ?? list[0];
          if (home) navigate(home.path);
          else {
            setDetail(null);
            history.replaceState(null, '', '#/');
            setRoute({ view: 'home' });
          }
        }
      } catch (err) {
        handleError(err);
      }
    },
    [confirm, refreshNotes, route, navigate, handleError],
  );

  const openDaily = useCallback(async () => {
    try {
      const s = await api.daily();
      await refreshNotes();
      navigate(s.path, { mode: 'edit' });
    } catch (err) {
      handleError(err);
    }
  }, [refreshNotes, navigate, handleError]);

  const showSearch = useCallback((q?: string) => {
    if (q != null) setQuery(q);
    setLeftTab('search');
    setShowLeft(true);
    setSearchFocus((k) => k + 1);
  }, []);

  const resolveConflict = useCallback(
    async (keep: 'mine' | 'theirs') => {
      if (keep === 'mine') {
        dirty.current = true;
        setSaveState('dirty');
        await save(true);
      } else {
        const path = loadedPath.current;
        if (!path) return;
        dirty.current = false;
        try {
          applyDetail(await api.note(path), true);
        } catch (err) {
          handleError(err);
        }
      }
    },
    [save, applyDetail, handleError],
  );

  // ---------------------------------------------------------------- shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = isMac ? e.metaKey : e.ctrlKey;
      if (!m || dialog) return;
      const k = e.key.toLowerCase();
      if (k === 'o' || (k === 'p' && !e.shiftKey)) {
        e.preventDefault();
        setSwitcher(true);
      } else if (k === 'f' && e.shiftKey) {
        e.preventDefault();
        showSearch();
      } else if (k === 'e') {
        e.preventDefault();
        setMode((x) => (x === 'edit' ? 'preview' : 'edit'));
      } else if (k === 'g') {
        e.preventDefault();
        if (route.view === 'graph') history.back();
        else location.hash = '#/graph';
      } else if (k === 'd') {
        e.preventDefault();
        openDaily();
      } else if (k === 'n' && !e.shiftKey) {
        e.preventDefault();
        newNote();
      } else if (k === 's') {
        e.preventDefault();
        save();
      } else if (k === '\\') {
        e.preventDefault();
        setShowLeft((x) => !x);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, showSearch, route.view, openDaily, newNote, save]);

  // ---------------------------------------------------------------- render
  const words = useMemo(() => wordCount(draft), [draft]);
  if (fatal) {
    return (
      <div className="fatal">
        <h2>Can’t reach the Ultron Mind server</h2>
        <p className="muted">{fatal}</p>
        <button className="btn primary" onClick={() => location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  const title = route.view === 'graph' ? 'Graph' : detail?.name ?? missing?.replace(/\.md$/, '').split('/').pop() ?? '';
  const saveLabel: Record<SaveState, string> = {
    saved: 'Saved',
    dirty: 'Editing…',
    saving: 'Saving…',
    error: 'Save failed',
    conflict: 'Conflict',
  };

  return (
    <div className={`app${showLeft ? ' left-open' : ''}${showRight && route.view === 'note' ? ' right-open' : ''}`}>
      {showLeft && (
        <aside className="sidebar left">
          <div className="sidebar-header">
            <div className="vault-name" title={vaultName}>
              <img src="./favicon.svg" alt="" width={18} height={18} />
              {vaultName || 'Ultron Mind'}
            </div>
            <button className="icon-btn" title={`New note (${mod}+N)`} onClick={() => newNote()}>
              ＋
            </button>
            <button className="icon-btn" title={`Today’s journal (${mod}+D)`} onClick={openDaily}>
              ◷
            </button>
          </div>
          <div className="tabs">
            {(['files', 'search', 'tags'] as const).map((t) => (
              <button
                key={t}
                className={`tab${leftTab === t ? ' active' : ''}`}
                onClick={() => (t === 'search' ? showSearch() : setLeftTab(t))}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          {leftTab === 'files' && (
            <FileTree
              notes={notes}
              currentPath={currentPath}
              onOpen={(p) => navigate(p)}
              onNewNote={(f) => newNote(f)}
              onRename={renameNote}
              onDelete={deleteNote}
              onMove={moveNote}
            />
          )}
          {leftTab === 'search' && (
            <SearchPanel
              query={query}
              setQuery={setQuery}
              focusKey={searchFocus}
              refreshKey={refreshKey}
              onOpen={(p, line) => navigate(p, { line })}
            />
          )}
          {leftTab === 'tags' && <TagsPanel refreshKey={refreshKey} onSelect={(t) => showSearch(`tag:${t}`)} />}
        </aside>
      )}

      <main className="main">
        <header className="topbar">
          <button className="icon-btn" title={`Toggle sidebar (${mod}+\\)`} onClick={() => setShowLeft((x) => !x)}>
            ☰
          </button>
          <button className="icon-btn hide-narrow" title="Back" onClick={() => history.back()}>
            ‹
          </button>
          <button className="icon-btn hide-narrow" title="Forward" onClick={() => history.forward()}>
            ›
          </button>
          <div className="title" onDoubleClick={() => detail && renameNote(detail.path)}>
            {detail?.folder && route.view === 'note' && <span className="crumb">{detail.folder} / </span>}
            <span title={detail ? 'Double-click to rename' : undefined}>{title}</span>
          </div>
          <button className="icon-btn" title={`Quick switcher (${mod}+O)`} onClick={() => setSwitcher(true)}>
            ⌕
          </button>
          {route.view === 'note' && detail && (
            <button
              className="icon-btn mode-btn"
              title={`Toggle edit/preview (${mod}+E)`}
              onClick={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
            >
              {mode === 'edit' ? 'Preview' : 'Edit'}
            </button>
          )}
          <button
            className={`icon-btn${route.view === 'graph' ? ' active' : ''}`}
            title={`Graph view (${mod}+G)`}
            onClick={() => (route.view === 'graph' ? history.back() : (location.hash = '#/graph'))}
          >
            ⬡
          </button>
          {route.view === 'note' && (
            <button className="icon-btn" title="Toggle right panel" onClick={() => setShowRight((x) => !x)}>
              ☷
            </button>
          )}
        </header>

        {saveState === 'conflict' && (
          <div className="banner">
            This note was changed somewhere else (maybe by Claude) while you were editing.
            <button className="btn" onClick={() => resolveConflict('theirs')}>
              Load their version
            </button>
            <button className="btn primary" onClick={() => resolveConflict('mine')}>
              Keep mine
            </button>
          </div>
        )}

        <div className="content">
          {route.view === 'graph' && (
            <GraphView
              data={graph}
              currentPath={loadedPath.current}
              onOpen={(p, unresolved) => (unresolved ? createNote(unresolved) : navigate(p))}
            />
          )}
          {route.view === 'note' && missing && (
            <div className="placeholder">
              <h2>“{missing.replace(/\.md$/, '')}” doesn’t exist</h2>
              <button className="btn primary" onClick={() => createNote(missing)}>
                Create it
              </button>
            </div>
          )}
          {route.view === 'home' && ready && notes.length === 0 && (
            <div className="placeholder">
              <h2>Your vault is empty</h2>
              <button className="btn primary" onClick={() => newNote('')}>
                Create a note
              </button>
            </div>
          )}
          <div className="note-pane" style={{ display: route.view === 'note' && detail ? undefined : 'none' }}>
            <div className="editor-wrap" style={{ display: mode === 'edit' ? undefined : 'none' }}>
              <Editor
                docKey={detail?.path ?? ''}
                version={version}
                value={draft}
                onChange={onChange}
                noteNames={noteNames}
                tagNames={tagNames}
                onOpenLink={openLink}
                showLineNumbers={lineNumbers}
                onReady={(h) => (editor.current = h)}
              />
            </div>
            {mode === 'preview' && detail && (
              <Preview
                content={draft}
                exists={exists}
                namesKey={namesKey}
                onOpenLink={openLink}
                onTag={(t) => showSearch(`tag:${t}`)}
                scrollToHeading={pendingHeading}
                onScrolled={() => setPendingHeading(null)}
              />
            )}
          </div>
        </div>

        <footer className="statusbar">
          <span className={`dot ${connected ? 'ok' : 'bad'}`} title={connected ? 'Live sync connected' : 'Reconnecting…'} />
          {route.view === 'note' && detail && (
            <>
              <span className={`save-state ${saveState}`}>{saveLabel[saveState]}</span>
              <span>{words} words</span>
              <span>{detail.backlinks.length} backlinks</span>
              <label className="hide-narrow">
                <input type="checkbox" checked={lineNumbers} onChange={(e) => setLineNumbers(e.target.checked)} /> Line numbers
              </label>
            </>
          )}
          <span className="spacer" />
          <span className="hide-narrow">{notes.length} notes</span>
        </footer>
      </main>

      {showRight && route.view === 'note' && (
        <aside className="sidebar right">
          <RightPanel
            note={detail}
            graph={graph}
            onOpen={(p, line) => navigate(p, { line })}
            onOpenLink={(t) => openLink(t)}
            onTag={(t) => showSearch(`tag:${t}`)}
            onHeading={(line, text) => {
              if (mode === 'edit') editor.current?.scrollToLine(line);
              else setPendingHeading(text);
            }}
          />
        </aside>
      )}

      {isNarrow && (showLeft || (showRight && route.view === 'note')) && (
        <div className="sidebar-backdrop" onClick={() => (setShowLeft(false), setShowRight(false))} />
      )}

      {switcher && (
        <QuickSwitcher notes={notes} onOpen={(p) => navigate(p)} onCreate={(n) => createNote(n)} onClose={() => setSwitcher(false)} />
      )}
      {dialog && <Dialog req={dialog} onDone={() => setDialog(null)} />}
    </div>
  );
}
