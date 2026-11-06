import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, OfflineError, onOffline, setToken, subscribe, type Backlink, type Bookmark, type GraphData, type NoteDetail, type NoteSummary, type VaultEvent } from './api';
import { Editor, type EditorHandle } from './components/Editor';
import { Preview } from './components/Preview';
import { FileTree } from './components/FileTree';
import { BrainView, type BrainHandle } from './components/BrainView';
import { AtlasView } from './components/AtlasView';
import { QuickSwitcher } from './components/QuickSwitcher';
import { CommandPalette, type PaletteItem } from './components/CommandPalette';
import { HistoryDialog } from './components/HistoryDialog';
import { applyTemplate } from './templates';
import { DEFAULT_SETTINGS, SettingsDialog, useDesktopUpdate, type VaultSettings } from './components/SettingsDialog';
import { Dialog, type DialogRequest } from './components/Modal';
import { BookmarksPanel, InsightsPanel, SearchPanel, TagsPanel, TasksPanel } from './components/Panels';
import { taskLines, wordCount } from './markdown';
import { deriveKey, isLocked, keyForContent, lockContent, unlockContent, WrongPasswordError, type NoteKey } from './crypto';

type Mode = 'edit' | 'preview';
type DrawerTab = 'files' | 'search' | 'tags' | 'tasks' | 'bookmarks' | 'insights';
const DRAWER_TABS: { key: DrawerTab; icon: string; label: string }[] = [
  { key: 'files', icon: '▤', label: 'Files' },
  { key: 'search', icon: '⌕', label: 'Search' },
  { key: 'tags', icon: '#', label: 'Tags' },
  { key: 'tasks', icon: '☑', label: 'Tasks' },
  { key: 'bookmarks', icon: '☆', label: 'Bookmarks' },
  { key: 'insights', icon: '◇', label: 'Insights' },
];

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

/** Fill {{date}}, {{time}}, {{title}} and {{date:YYYY-MM-DD HH:mm}} placeholders in a template. */
type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'offline';
type Route = { view: 'note'; path: string } | { view: 'home' };

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
  const [mode, setMode] = useState<Mode>(() => load('octavo.mode', 'preview'));
  const [leftTab, setLeftTab] = useState<DrawerTab>('files');
  const [palette, setPalette] = useState<null | 'commands' | 'templates' | 'new-from-template'>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [mentions, setMentions] = useState<Backlink[]>([]);
  const [vimMode, setVimMode] = useState<boolean>(() => load('octavo.vim', false));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFocus, setSettingsFocus] = useState<string | undefined>();
  useEffect(
    () =>
      window.octavoDesktop?.onOpenSettings?.((section) => {
        setSettingsFocus(section);
        setSettingsOpen(true);
      }),
    [],
  );
  const [settings, setSettings] = useState<VaultSettings>(DEFAULT_SETTINGS);
  const update = useDesktopUpdate();
  const [updateDismissed, setUpdateDismissed] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchFocus, setSearchFocus] = useState(0);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [showLeft, setShowLeft] = useState<boolean>(() => !narrow() && load('octavo.left', false));
  const [panelWide, setPanelWide] = useState<boolean>(() => load('octavo.panelWide', false));
  const [lineNumbers, setLineNumbers] = useState(() => load('octavo.lineNumbers', false));
  useEffect(() => store('octavo.vim', vimMode), [vimMode]);
  const [switcher, setSwitcher] = useState(false);
  /** Path of the note being merged into another (shows a note picker). */
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);
  const [propsSignal, setPropsSignal] = useState(0);
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
  /** Keys of locked notes unlocked in this tab (memory only; gone on reload). */
  const noteKeys = useRef(new Map<string, NoteKey>());
  /** Is the open note a locked (encrypted) note? */
  const encryptedRef = useRef(false);
  const [locked, setLocked] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  useEffect(() => store('octavo.mode', mode), [mode]);
  useEffect(() => void (!narrow() && store('octavo.left', showLeft)), [showLeft]);
  useEffect(() => store('octavo.panelWide', panelWide), [panelWide]);
  const [viewMode, setViewMode] = useState<'atlas' | 'network'>(() => load('octavo.view', 'atlas'));
  useEffect(() => store('octavo.view', viewMode), [viewMode]);
  const brain = useRef<BrainHandle | null>(null);
  useEffect(() => store('octavo.lineNumbers', lineNumbers), [lineNumbers]);
  const [isNarrow, setIsNarrow] = useState(narrow);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 800px)');
    const onChange = () => {
      setIsNarrow(mq.matches);
      // Sidebars become overlays on small screens: start closed.
      if (mq.matches) setShowLeft(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // ---------------------------------------------------------------- dialogs
  const prompt = useCallback(
    (title: string, initial = '', opts: { message?: string; confirmLabel?: string; placeholder?: string; password?: boolean } = {}) =>
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
          message: 'This vault is protected. Enter the token the server was started with (--token / OCTAVO_TOKEN).',
          confirmLabel: 'Unlock',
        });
        if (token) {
          setToken(token);
          location.reload();
        }
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      await confirm(err instanceof OfflineError ? 'You’re offline' : 'Something went wrong', message, { confirmLabel: 'OK' });
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
        let payload = content;
        if (encryptedRef.current) {
          const key = noteKeys.current.get(path);
          if (!key) throw new Error('This note is locked. Unlock it before saving.');
          payload = await lockContent(content, key);
        }
        const res = await api.save(path, payload, force ? undefined : baseMtime.current);
        baseMtime.current = res.mtime;
        if (draftRef.current === content) {
          dirty.current = false;
          setSaveState('saved');
        } else {
          setSaveState('dirty');
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) setSaveState('conflict');
        else if (err instanceof OfflineError) setSaveState('offline');
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

  // Offline: the service worker is serving saved copies. Unsaved edits are saved once back online.
  const [offline, setOfflineState] = useState(false);
  useEffect(
    () =>
      onOffline((v) => {
        setOfflineState(v);
        if (!v && dirty.current) save();
      }),
    [save],
  );
  useEffect(() => {
    const back = () => {
      // A cheap request tells us whether the computer is reachable again.
      api.vault().catch(() => {});
    };
    window.addEventListener('online', back);
    const t = setInterval(() => offline && back(), 15000);
    return () => {
      window.removeEventListener('online', back);
      clearInterval(t);
    };
  }, [offline]);

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
  const applyDetail = useCallback(async (d: NoteDetail, replaceContent: boolean) => {
    const enc = !!d.encrypted || isLocked(d.content);
    encryptedRef.current = enc;
    let content = d.content;
    if (enc && replaceContent) {
      const key = noteKeys.current.get(d.path);
      content = '';
      if (key) {
        try {
          content = await unlockContent(d.content, key);
        } catch (err) {
          // Changed elsewhere with another password, or damaged: ask again.
          noteKeys.current.delete(d.path);
          if (!(err instanceof WrongPasswordError)) setUnlockError((err as Error).message);
        }
      }
      setLocked(!noteKeys.current.has(d.path));
    } else if (!enc) {
      setLocked(false);
    }
    setDetail(d);
    setMissing(null);
    if (replaceContent) {
      draftRef.current = content;
      setDraft(content);
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
      const same = d.mtime === baseMtime.current || (!d.encrypted && d.content === draftRef.current);
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
    // octavo://open?…&heading=… links (desktop app) scroll to a heading.
    const onHeading = (e: Event) => setPendingHeading(String((e as CustomEvent).detail ?? '') || null);
    window.addEventListener('octavo:heading', onHeading);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('octavo:heading', onHeading);
    };
  }, []);

  useEffect(() => {
    if (route.view === 'note' && route.path !== loadedPath.current) loadNote(route.path);
  }, [route, loadNote]);

  // ---------------------------------------------------------------- startup
  useEffect(() => {
    (async () => {
      try {
        const v = await api.vault();
        setVaultName(v.name);
        document.title = `${v.name} · Octavo`;
        const list = await refreshNotes();
        await refreshGraph().catch(() => {});
        void list;
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
    const toFire = new Set<string>();
    const unsub = subscribe(
      (e: VaultEvent) => {
        // Claude read a note: light it up and add it to the trail; nothing changed, so no refresh.
        if (e.type === 'access') {
          (brain.current?.visit ?? brain.current?.fire)?.(e.path);
          return;
        }
        if (e.type === 'change') toFire.add(e.path);
        if (e.type === 'rename') toFire.add(e.to);
        if (e.type === 'rename' && e.from === loadedPath.current) {
          loadedPath.current = e.to;
          history.replaceState(null, '', noteHash(e.to));
          setRoute({ view: 'note', path: e.to });
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          refreshNotes().catch(() => {});
          // Light up the thoughts that just changed once the graph includes them.
          const fire = [...toFire];
          toFire.clear();
          refreshGraph()
            .then(() => setTimeout(() => fire.forEach((p) => (brain.current?.visit ?? brain.current?.fire)?.(p)), 60))
            .catch(() => {});
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

  const mergeNote = useCallback(
    async (from: string, into: string) => {
      const name = (p: string) => p.replace(/\.md$/, '');
      const ok = await confirm(
        `Merge “${name(from)}” into “${name(into)}”?`,
        `Its text is added to the end of “${name(into)}”, links to it are updated, and “${name(from)}” is moved to the vault’s .trash folder.`,
        { confirmLabel: 'Merge' },
      );
      if (!ok) return;
      try {
        if (dirty.current && loadedPath.current) await save();
        dirty.current = false;
        loadedPath.current = null;
        await api.merge(from, into);
        await refreshNotes();
        navigate(into);
      } catch (err) {
        handleError(err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [confirm, refreshNotes, navigate, handleError],
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
        void list;
        if (route.view === 'note' && route.path === path) {
          setDetail(null);
          history.replaceState(null, '', '#/');
          setRoute({ view: 'home' });
        }
      } catch (err) {
        handleError(err);
      }
    },
    [confirm, refreshNotes, route, navigate, handleError],
  );

  const openPeriodic = useCallback(
    async (period: 'day' | 'week' | 'month') => {
      try {
        const s = await api.periodic(period);
        await refreshNotes();
        navigate(s.path, { mode: 'edit' });
      } catch (err) {
        handleError(err);
      }
    },
    [refreshNotes, navigate, handleError],
  );
  const openDaily = useCallback(() => openPeriodic('day'), [openPeriodic]);

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

  const closePanel = useCallback(() => {
    if (dirty.current) save();
    if (location.hash && location.hash !== '#/') location.hash = '#/';
  }, [save]);

  // ---------------------------------------------------------------- bookmarks, mentions, tasks, templates
  useEffect(() => {
    api
      .getConfig<Partial<VaultSettings>>('settings')
      .then((r) => setSettings({ ...DEFAULT_SETTINGS, ...(r.value ?? {}) }))
      .catch(() => {});
  }, []);
  const saveSettings = useCallback((next: VaultSettings) => {
    setSettings(next);
    api.setConfig('settings', next).catch(() => {});
  }, []);
  useEffect(() => {
    api
      .getConfig<Bookmark[]>('bookmarks')
      .then((r) => setBookmarks(Array.isArray(r.value) ? r.value : []))
      .catch(() => {});
  }, []);
  const saveBookmarks = useCallback((next: Bookmark[]) => {
    setBookmarks(next);
    api.setConfig('bookmarks', next).catch(() => {});
  }, []);
  const isBookmarked = !!detail && bookmarks.some((b) => b.type === 'note' && b.path === detail.path && !b.heading);
  const headingBookmarks = useMemo(
    () => (detail ? bookmarks.flatMap((b) => (b.type === 'note' && b.path === detail.path && b.heading ? [b.heading] : [])) : []),
    [detail, bookmarks],
  );
  const toggleHeadingBookmark = useCallback(
    (heading: string) => {
      if (!detail || !heading) return;
      const has = (b: Bookmark) => b.type === 'note' && b.path === detail.path && b.heading === heading;
      saveBookmarks(bookmarks.some(has) ? bookmarks.filter((b) => !has(b)) : [...bookmarks, { type: 'note', path: detail.path, heading }]);
    },
    [detail, bookmarks, saveBookmarks],
  );
  const toggleBookmark = useCallback(() => {
    if (!detail) return;
    if (bookmarks.some((b) => b.type === 'note' && b.path === detail.path && !b.heading)) {
      saveBookmarks(bookmarks.filter((b) => !(b.type === 'note' && b.path === detail.path && !b.heading)));
    } else saveBookmarks([...bookmarks, { type: 'note', path: detail.path }]);
  }, [detail, bookmarks, saveBookmarks]);

  const detailPath = detail?.path;
  useEffect(() => {
    if (!detailPath) {
      setMentions([]);
      return;
    }
    api
      .mentions(detailPath)
      .then((r) => setMentions(r.mentions))
      .catch(() => setMentions([]));
  }, [detailPath, refreshKey]);

  /** Click a checkbox in reading view: flip that task in the source and autosave. */
  const toggleTask = useCallback(
    (index: number) => {
      const lines = draftRef.current.split('\n');
      const lineNo = taskLines(draftRef.current)[index];
      if (!lineNo) return;
      const m = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)(.)(\].*)$/.exec(lines[lineNo - 1]);
      if (!m) return;
      lines[lineNo - 1] = m[1] + (m[2] === ' ' ? 'x' : ' ') + m[3];
      onChange(lines.join('\n'));
    },
    [onChange],
  );

  const templates = useMemo(() => notes.filter((n) => /^templates?\//i.test(n.path)), [notes]);

  const insertTemplate = useCallback(
    async (path: string) => {
      try {
        const t = await api.note(path);
        const text = applyTemplate(t.content.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, ''), detail?.name ?? '', new Date(), detail?.folder ?? '');
        setMode('edit');
        setTimeout(() => editor.current?.insert(text), 60);
      } catch (err) {
        handleError(err);
      }
    },
    [detail, handleError],
  );

  const newFromTemplate = useCallback(
    async (path: string) => {
      const name = await prompt('New note from template', '', { confirmLabel: 'Create', placeholder: 'Folder/Note name' });
      if (!name) return;
      try {
        const t = await api.note(path);
        await createNote(name, applyTemplate(t.content, name.split('/').pop()!.replace(/\.md$/i, '')));
      } catch (err) {
        handleError(err);
      }
    },
    [prompt, createNote, handleError],
  );

  const newUniqueNote = useCallback(() => {
    const d = new Date();
    let name = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}`;
    if (notesRef.current.some((n) => n.name === name)) name += pad2(d.getSeconds());
    createNote(name, `# ${name}\n\n`);
  }, [createNote]);

  const openRandom = useCallback(() => {
    const list = notesRef.current.filter((n) => n.path !== loadedPath.current);
    if (list.length) navigate(list[Math.floor(Math.random() * list.length)].path);
  }, [navigate]);

  const extractSelection = useCallback(async () => {
    const sel = mode === 'edit' ? editor.current?.getSelection() ?? '' : '';
    if (!sel.trim()) {
      await confirm('Select some text first', 'Switch to Edit, select the text you want to move into its own note, then run this again.', {
        confirmLabel: 'OK',
      });
      return;
    }
    const firstLine = sel.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 60);
    const name = await prompt('Extract to new note', firstLine, { confirmLabel: 'Extract', message: 'The selection is replaced by a link to the new note.' });
    if (!name) return;
    try {
      const s = await api.create(name, sel.trim() + '\n');
      editor.current?.replaceSelection(`[[${s.name}]]`);
      await refreshNotes();
    } catch (err) {
      handleError(err);
    }
  }, [mode, confirm, prompt, refreshNotes, handleError]);

  const copyLink = useCallback(() => {
    if (!detail) return;
    const url = `${location.href.split('#')[0]}${noteHash(detail.path)}`;
    navigator.clipboard?.writeText(url).catch(() => {});
  }, [detail]);

  /** octavo://open?vault=…&file=… opens this note in the desktop app from other apps. */
  const copyAppLink = useCallback(() => {
    if (!detail) return;
    const link = `octavo://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(detail.path.replace(/\.md$/, ''))}`;
    navigator.clipboard?.writeText(link).catch(() => {});
  }, [detail, vaultName]);

  const addUrlBookmark = useCallback(async () => {
    const url = await prompt('Bookmark a web link', 'https://', { confirmLabel: 'Add' });
    if (!url || !/^https?:\/\/\S+$/.test(url)) return;
    const title = await prompt('Name (optional)', url.replace(/^https?:\/\//, ''), { confirmLabel: 'Save' });
    saveBookmarks([...bookmarks, { type: 'url', url, title: title || undefined }]);
  }, [prompt, bookmarks, saveBookmarks]);

  // ---------------------------------------------------------------- locked notes

  const askNewPassword = useCallback(
    async (title: string): Promise<string | null> => {
      const pw = await prompt(title, '', {
        password: true,
        confirmLabel: 'Next',
        message:
          'The note is encrypted in your browser, so only someone with this password can read it, including Claude and the server. If you forget the password, the note cannot be recovered. The note’s title stays visible.',
      });
      if (!pw) return null;
      if (pw.length < 8) {
        await confirm('Password too short', 'Use at least 8 characters. A short passphrase of several words works well.', { confirmLabel: 'OK' });
        return null;
      }
      const again = await prompt('Confirm password', '', { password: true, confirmLabel: 'Lock note' });
      if (again !== pw) {
        if (again != null) await confirm('Passwords don’t match', 'Nothing was changed.', { confirmLabel: 'OK' });
        return null;
      }
      return pw;
    },
    [prompt, confirm],
  );

  /** Encrypt the open note (or re-encrypt it with a new password). */
  const lockNote = useCallback(
    async (changePassword = false) => {
      const path = loadedPath.current;
      if (!path || !detail) return;
      if (locked) return;
      const pw = await askNewPassword(changePassword ? 'New password for this note' : 'Lock this note with a password');
      if (!pw) return;
      try {
        const key = await deriveKey(pw);
        const payload = await lockContent(draftRef.current, key);
        if (saveTimer.current) clearTimeout(saveTimer.current);
        const res = await api.save(path, payload);
        noteKeys.current.set(path, key);
        encryptedRef.current = true;
        baseMtime.current = res.mtime;
        dirty.current = false;
        setSaveState('saved');
        setDetail((d) => (d ? { ...d, encrypted: true, mtime: res.mtime } : d));
        refreshNotes().catch(() => {});
        refreshGraph().catch(() => {});
      } catch (err) {
        handleError(err);
      }
    },
    [detail, locked, askNewPassword, refreshNotes, refreshGraph, handleError],
  );

  const unlockNote = useCallback(
    async (password: string) => {
      if (!detail) return;
      setUnlocking(true);
      setUnlockError('');
      try {
        const fresh = await api.note(detail.path);
        const key = await keyForContent(fresh.content, password);
        noteKeys.current.set(fresh.path, key);
        await applyDetail(fresh, true);
      } catch (err) {
        setUnlockError(err instanceof WrongPasswordError ? 'Wrong password' : (err as Error).message);
      } finally {
        setUnlocking(false);
      }
    },
    [detail, applyDetail],
  );

  /** Forget the key(s) and hide the plaintext. */
  const lockNow = useCallback(
    async (all = false) => {
      if (dirty.current) await save();
      if (all) noteKeys.current.clear();
      else if (loadedPath.current) noteKeys.current.delete(loadedPath.current);
      if (encryptedRef.current && loadedPath.current && !noteKeys.current.has(loadedPath.current)) {
        draftRef.current = '';
        setDraft('');
        setVersion((v) => v + 1);
        setLocked(true);
        setMode('preview');
      }
    },
    [save],
  );

  const removeEncryption = useCallback(async () => {
    const path = loadedPath.current;
    if (!path || locked || !encryptedRef.current) return;
    const ok = await confirm(
      'Remove encryption?',
      'The note will be saved as plain text again, so Claude, search and other apps can read it.',
      { confirmLabel: 'Remove encryption', danger: true },
    );
    if (!ok) return;
    try {
      const res = await api.save(path, draftRef.current);
      encryptedRef.current = false;
      noteKeys.current.delete(path);
      baseMtime.current = res.mtime;
      dirty.current = false;
      setDetail((d) => (d ? { ...d, encrypted: false, mtime: res.mtime } : d));
      refreshNotes().catch(() => {});
      refreshGraph().catch(() => {});
      refreshCurrentRef.current();
    } catch (err) {
      handleError(err);
    }
  }, [locked, confirm, refreshNotes, refreshGraph, handleError]);

  // Auto-lock: forget all keys after 15 minutes without activity.
  useEffect(() => {
    let last = Date.now();
    const bump = () => (last = Date.now());
    window.addEventListener('pointerdown', bump);
    window.addEventListener('keydown', bump);
    const t = setInterval(() => {
      if (noteKeys.current.size && Date.now() - last > 15 * 60 * 1000) lockNow(true);
    }, 30_000);
    return () => {
      window.removeEventListener('pointerdown', bump);
      window.removeEventListener('keydown', bump);
      clearInterval(t);
    };
  }, [lockNow]);

  const isEncrypted = !!detail?.encrypted;

  const openDrawer = useCallback((tab: DrawerTab) => {
    setLeftTab(tab);
    setShowLeft(true);
    if (tab === 'search') setSearchFocus((k) => k + 1);
  }, []);

  // ---------------------------------------------------------------- shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && settingsOpen && !dialog) {
        setSettingsOpen(false);
        return;
      }
      if (e.key === 'Escape' && !dialog && !switcher && !palette && !historyOpen && !settingsOpen) {
        const inEditor = (e.target as HTMLElement | null)?.closest?.('.cm-editor, input, textarea');
        if (!inEditor) {
          if (showLeft && narrow()) setShowLeft(false);
          else closePanel();
        }
        return;
      }
      const m = isMac ? e.metaKey : e.ctrlKey;
      if (!m || dialog) return;
      const k = e.key.toLowerCase();
      if (k === 'p') {
        e.preventDefault();
        setPalette('commands');
      } else if (k === 'o') {
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
        closePanel();
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
  }, [dialog, switcher, palette, historyOpen, settingsOpen, showLeft, showSearch, closePanel, openDaily, newNote, save]);

  // ---------------------------------------------------------------- render
  const counts = useMemo(() => wordCount(draft), [draft]);
  const hasNote = route.view === 'note' && !!detail;
  const commandItems: PaletteItem[] = [
    { id: 'new', label: 'New note', hint: `${mod}+N`, run: () => newNote() },
    { id: 'unique', label: 'New unique note (timestamp name)', keywords: 'zettelkasten id', run: newUniqueNote },
    { id: 'new-tpl', label: 'New note from template…', run: () => setTimeout(() => setPalette('new-from-template'), 0) },
    { id: 'daily', label: 'Open today’s journal', hint: `${mod}+D`, keywords: 'daily note', run: openDaily },
    { id: 'weekly', label: 'Open this week’s note', keywords: 'weekly note periodic plan goals', run: () => openPeriodic('week') },
    { id: 'monthly', label: 'Open this month’s note', keywords: 'monthly note periodic plan goals', run: () => openPeriodic('month') },
    { id: 'switcher', label: 'Open quick switcher', hint: `${mod}+O`, keywords: 'find note', run: () => setSwitcher(true) },
    { id: 'random', label: 'Open random note', run: openRandom },
    ...(settings.locking ? [{ id: 'lock-all', label: 'Lock all unlocked notes', keywords: 'encrypt', run: () => lockNow(true) }] : []),
    { id: 'settings', label: 'Open settings', keywords: 'preferences options encryption', run: () => setSettingsOpen(true) },
    { id: 'search', label: 'Search all notes', hint: `${mod}+Shift+F`, run: () => showSearch() },
    { id: 'tasks', label: 'Show all tasks', keywords: 'todo checkbox', run: () => openDrawer('tasks') },
    { id: 'bookmarks', label: 'Show bookmarks', run: () => openDrawer('bookmarks') },
    { id: 'insights', label: 'Find orphans and dead ends', keywords: 'insights unlinked', run: () => openDrawer('insights') },
    { id: 'files', label: 'Show file explorer', hint: `${mod}+\\`, run: () => openDrawer('files') },
    { id: 'view', label: viewMode === 'atlas' ? 'Switch to network view' : 'Switch to atlas view', keywords: 'graph brain', run: () => setViewMode((v) => (v === 'atlas' ? 'network' : 'atlas')) },
    { id: 'vim', label: vimMode ? 'Turn off Vim keybindings' : 'Turn on Vim keybindings', run: () => setVimMode((v) => !v) },
    { id: 'lines', label: lineNumbers ? 'Hide line numbers' : 'Show line numbers', run: () => setLineNumbers((v: boolean) => !v) },
    ...(hasNote
      ? [
          { id: 'toggle', label: mode === 'edit' ? 'Switch to reading view' : 'Switch to editing', hint: `${mod}+E`, run: () => setMode((m) => (m === 'edit' ? 'preview' : 'edit')) },
          ...(!locked
            ? [{ id: 'props', label: 'Edit properties', keywords: 'frontmatter metadata yaml tags aliases', run: () => { setMode('preview'); setPropsSignal((n) => n + 1); } }]
            : []),
          { id: 'tpl', label: 'Insert template…', run: () => setTimeout(() => setPalette('templates'), 0) },
          { id: 'bookmark', label: isBookmarked ? 'Remove bookmark' : 'Bookmark this note', run: toggleBookmark },
          ...(!isEncrypted
            ? settings.locking
              ? [{ id: 'lock', label: 'Lock note with a password', keywords: 'encrypt private secret', run: () => lockNote() }]
              : []
            : locked
              ? []
              : [
                  { id: 'lock-now', label: 'Lock note now', keywords: 'encrypt hide', run: () => lockNow() },
                  { id: 'lock-pw', label: 'Change note password', keywords: 'encrypt', run: () => lockNote(true) },
                  { id: 'unlock-perm', label: 'Remove encryption from note', keywords: 'decrypt unlock', run: removeEncryption },
                ]),
          { id: 'history', label: 'Show version history', keywords: 'recovery restore snapshot', run: () => setHistoryOpen(true) },
          { id: 'extract', label: 'Extract selection to new note', keywords: 'split composer refactor', run: extractSelection },
          { id: 'merge', label: 'Merge this note into another…', keywords: 'combine composer duplicate join', run: () => setMergeFrom(route.path) },
          { id: 'copy', label: 'Copy link to this note', run: copyLink },
          ...(window.octavoDesktop
            ? [{ id: 'copy-app', label: 'Copy octavo:// link (opens the desktop app)', keywords: 'url uri deep link share', run: copyAppLink }]
            : []),
          { id: 'rename', label: 'Rename or move note', run: () => renameNote(detail!.path) },
          { id: 'delete', label: 'Delete note', run: () => deleteNote(detail!.path) },
          { id: 'close', label: 'Close note', hint: 'Esc', run: closePanel },
        ]
      : []),
  ];
  if (fatal) {
    return (
      <div className="fatal">
        <h2>Can’t reach the Octavo server</h2>
        <p className="muted">{fatal}</p>
        <button className="btn primary" onClick={() => location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  const title = detail?.name ?? missing?.replace(/\.md$/, '').split('/').pop() ?? '';
  const saveLabel: Record<SaveState, string> = {
    saved: 'Saved',
    dirty: 'Editing…',
    saving: 'Saving…',
    error: 'Save failed',
    offline: 'Offline: not saved yet',
    conflict: 'Conflict',
  };
  const panelOpen = route.view === 'note' && (!!detail || !!missing);
  const graphView = useMemo(
    () => (graph ? { ...graph, nodes: graph.nodes.map((n) => (n.encrypted ? { ...n, name: `🔒 ${n.name}` } : n)) } : null),
    [graph],
  );
  const panelFraction = isNarrow ? 0 : panelWide ? 0.62 : 0.44;
  const outgoing = detail
    ? detail.links.filter((l, i, arr) => l.target && arr.findIndex((x) => (x.path ?? x.target) === (l.path ?? l.target)) === i)
    : [];

  return (
    <div className={`app brain-app${panelOpen ? ' panel-open' : ''}`}>
      {(() => {
        const viewProps = {
          data: graphView,
          selected: panelOpen ? loadedPath.current : null,
          rightInset: panelOpen ? panelFraction : 0,
          onSelect: (p: string) => navigate(p),
          onSelectUnresolved: (name: string) => createNote(name),
          onBackground: closePanel,
          onReady: (h: BrainHandle) => (brain.current = h),
        };
        return viewMode === 'atlas' ? <AtlasView key="atlas" {...viewProps} /> : <BrainView key="network" {...viewProps} />;
      })()}

      {/* Floating toolbar */}
      <div className="toolbar">
        <button className="tb-btn" title={`Files, search & tags (${mod}+\\)`} onClick={() => setShowLeft((x) => !x)}>
          ☰
        </button>
        <span className={`dot ${connected ? 'ok' : 'bad'}`} title={connected ? 'Live sync connected' : 'Reconnecting…'} />
        <div className="tb-brand" title={vaultName}>
          <span>{(vaultName || 'Octavo').toUpperCase()}</span>
          <span className="tb-detail">
            <span className="faint"> — </span>
            {viewMode === 'atlas' ? 'ATLAS' : 'NETWORK'}
            <span className="faint"> — </span>
            {graph ? graph.nodes.filter((n) => !n.unresolved).length : 0} notes
          </span>
        </div>
        <button
          className="tb-btn"
          title={viewMode === 'atlas' ? 'Switch to flat network view' : 'Switch to 3D atlas view'}
          onClick={() => setViewMode((v) => (v === 'atlas' ? 'network' : 'atlas'))}
        >
          {viewMode === 'atlas' ? '⋰' : '◎'}
        </button>
        <button className="tb-btn" title={`Find or create a note (${mod}+O)`} onClick={() => setSwitcher(true)}>
          ⌕
        </button>
        <button className="tb-btn" title={`New thought (${mod}+N)`} onClick={() => newNote()}>
          ＋
        </button>
        <button className="tb-btn" title={`Today’s journal (${mod}+D)`} onClick={openDaily}>
          ◷
        </button>
        <button className="tb-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
      </div>

      {offline && (
        <div className="offline-banner" role="status">
          Offline: showing the copies saved on this device. Changes can’t be saved until your computer is reachable.
        </div>
      )}
      {update && (update.status === 'ready' || update.status === 'available') && updateDismissed !== update.version && (
        <div className="update-banner" role="status">
          <span>
            {update.status === 'ready' ? `Octavo ${update.version} is ready.` : `Octavo ${update.version} is available.`}
          </span>
          <button className="btn primary" onClick={() => window.octavoDesktop?.installUpdate()}>
            {update.status === 'ready' ? 'Restart to update' : 'Download'}
          </button>
          <button className="icon-btn" title="Later" onClick={() => setUpdateDismissed(update.version ?? null)}>
            ✕
          </button>
        </div>
      )}

      {ready && !panelOpen && notes.length > 0 && viewMode === 'network' && <div className="brain-hint">Click a point to open its note · scroll to zoom · drag to move</div>}

      {/* Drawer: files / search / tags */}
      {showLeft && (
        <aside className="drawer">
          <div className="tabs">
            {DRAWER_TABS.map((t) => (
              <button
                key={t.key}
                className={`tab icon-tab${leftTab === t.key ? ' active' : ''}`}
                title={t.label}
                aria-label={t.label}
                onClick={() => (t.key === 'search' ? showSearch() : setLeftTab(t.key))}
              >
                {t.icon}
              </button>
            ))}
            <button className="icon-btn" title="Close" onClick={() => setShowLeft(false)}>
              ✕
            </button>
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
              onBookmark={(q) => saveBookmarks([...bookmarks.filter((b) => !(b.type === 'search' && b.query === q)), { type: 'search', query: q }])}
              query={query}
              setQuery={setQuery}
              focusKey={searchFocus}
              refreshKey={refreshKey}
              onOpen={(p, line) => navigate(p, { line })}
            />
          )}
          {leftTab === 'tags' && <TagsPanel refreshKey={refreshKey} onSelect={(t) => showSearch(`tag:${t}`)} />}
          {leftTab === 'tasks' && <TasksPanel refreshKey={refreshKey} onOpen={(p, line) => navigate(p, { line })} />}
          {leftTab === 'bookmarks' && (
            <BookmarksPanel
              bookmarks={bookmarks}
              onOpenNote={(p, heading) => navigate(p, { heading })}
              onSearch={(q) => showSearch(q)}
              onRemove={(i) => saveBookmarks(bookmarks.filter((_, j) => j !== i))}
              onAddUrl={addUrlBookmark}
            />
          )}
          {leftTab === 'insights' && <InsightsPanel refreshKey={refreshKey} onOpen={(p) => navigate(p)} onCreate={(n) => createNote(n)} />}
        </aside>
      )}

      {/* Note panel */}
      <section
        className={`note-panel${panelOpen ? ' open' : ''}`}
        style={{ width: isNarrow ? '100%' : `${panelFraction * 100}%` }}
        aria-hidden={!panelOpen}
      >
        <header className="panel-header">
          <div className="panel-title" onDoubleClick={() => detail && renameNote(detail.path)}>
            {detail?.folder && <span className="crumb">{detail.folder} / </span>}
            <span title={detail ? 'Double-click to rename' : undefined}>{title}</span>
          </div>
          {detail && !locked && (
            <>
              <button
                className="icon-btn mode-btn"
                title={`Toggle edit/preview (${mod}+E)`}
                onClick={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
              >
                {mode === 'edit' ? 'Read' : 'Edit'}
              </button>
              <button className="icon-btn hide-narrow" title={panelWide ? 'Narrower' : 'Wider'} onClick={() => setPanelWide((w) => !w)}>
                {panelWide ? '⇥' : '⇤'}
              </button>
              {(settings.locking || isEncrypted) && (
              <button
                className={`icon-btn${isEncrypted ? ' lock-on' : ''}`}
                title={!isEncrypted ? 'Lock note with a password' : locked ? 'Locked' : 'Lock now'}
                onClick={() => (!isEncrypted ? lockNote() : locked ? undefined : lockNow())}
              >
                {isEncrypted ? (locked ? '🔒' : '🔓') : '🔐'}
              </button>
              )}
              <button className={`icon-btn${isBookmarked ? ' starred' : ''}`} title={isBookmarked ? 'Remove bookmark' : 'Bookmark this note'} onClick={toggleBookmark}>
                {isBookmarked ? '★' : '☆'}
              </button>
              {detail.headings.length > 0 && (
                <div className="outline-wrap">
                  <button className="icon-btn" title="Outline" onClick={() => setOutlineOpen((o) => !o)}>
                    ≡
                  </button>
                  {outlineOpen && (
                    <>
                      <div className="menu-backdrop" onMouseDown={() => setOutlineOpen(false)} />
                      <div className="outline-pop">
                        {detail.headings.map((h) => (
                          <button
                            key={h.line}
                            style={{ paddingLeft: 10 + (h.level - 1) * 12 }}
                            onClick={() => {
                              setOutlineOpen(false);
                              if (mode === 'edit') editor.current?.scrollToLine(h.line);
                              else setPendingHeading(h.text);
                            }}
                          >
                            {h.text}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              <button className="icon-btn hide-narrow" title="Version history" onClick={() => setHistoryOpen(true)}>
                ⟲
              </button>
              <button className="icon-btn" title="Rename / move" onClick={() => renameNote(detail.path)}>
                ✎
              </button>
              <button className="icon-btn" title="Delete" onClick={() => deleteNote(detail.path)}>
                🗑
              </button>
            </>
          )}
          <button className="icon-btn" title="Close (Esc)" onClick={closePanel}>
            ✕
          </button>
        </header>

        {saveState === 'conflict' && (
          <div className="banner">
            This note was changed somewhere else (maybe by Claude) while you were editing.
            <button className="btn" onClick={() => resolveConflict('theirs')}>
              Load theirs
            </button>
            <button className="btn primary" onClick={() => resolveConflict('mine')}>
              Keep mine
            </button>
          </div>
        )}

        {missing && (
          <div className="placeholder">
            <h2>“{missing.replace(/\.md$/, '')}” doesn’t exist yet</h2>
            <button className="btn primary" onClick={() => createNote(missing)}>
              Write it
            </button>
          </div>
        )}

        {detail && locked && (
          <form
            className="lock-screen"
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.currentTarget.elements.namedItem('pw') as HTMLInputElement);
              unlockNote(input.value);
              input.value = '';
            }}
          >
            <div className="lock-icon">🔒</div>
            <h2>{detail.name} is locked</h2>
            <p className="muted">Enter the note’s password to read and edit it. It’s decrypted only in this browser tab.</p>
            <input name="pw" className="input" type="password" autoComplete="current-password" placeholder="Password" autoFocus />
            {unlockError && <div className="lock-error">{unlockError}</div>}
            <button className="btn primary" type="submit" disabled={unlocking}>
              {unlocking ? 'Unlocking…' : 'Unlock'}
            </button>
          </form>
        )}

        <div className="panel-body" style={{ display: detail && !locked ? undefined : 'none' }}>
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
              vimMode={vimMode}
              onUpload={async (file) => {
                const r = await api.upload(file);
                return r.path;
              }}
              onSlashCommand={() => setPalette('templates')}
            />
          </div>
          {mode === 'preview' && detail && (
            <Preview
              path={detail.path}
              onToggleTask={toggleTask}
              content={draft}
              exists={exists}
              namesKey={namesKey}
              onOpenLink={openLink}
              onTag={(t) => showSearch(`tag:${t}`)}
              scrollToHeading={pendingHeading}
              onScrolled={() => setPendingHeading(null)}
              bookmarkedHeadings={headingBookmarks}
              onBookmarkHeading={toggleHeadingBookmark}
              onEditContent={onChange}
              editPropertiesSignal={propsSignal}
            />
          )}
        </div>

        {detail && !locked && (
          <div className="connections">
            <div className="conn-row">
              <span className="conn-label">Linked from</span>
              {detail.backlinks.length === 0 && <span className="muted small">nothing yet</span>}
              {detail.backlinks.map((b) => (
                <button key={b.path} className="chip" title={b.context.map((c) => c.text).join('\n')} onClick={() => navigate(b.path)}>
                  ← {b.name}
                </button>
              ))}
            </div>
            <div className="conn-row">
              <span className="conn-label">Links to</span>
              {outgoing.length === 0 && <span className="muted small">nothing yet</span>}
              {outgoing.map((l) => (
                <button
                  key={l.path ?? l.target}
                  className={`chip${l.path ? '' : ' ghost'}`}
                  title={l.path ?? 'Not written yet. Click to create'}
                  onClick={() => (l.path ? navigate(l.path) : openLink(l.target))}
                >
                  {l.path ? l.path.replace(/\.md$/, '').split('/').pop() : l.target} →
                </button>
              ))}
            </div>
            {mentions.length > 0 && (
              <div className="conn-row">
                <span className="conn-label" title="Notes that mention this note's name without linking to it">
                  Mentioned in
                </span>
                {mentions.map((m) => (
                  <button key={m.path} className="chip ghost" title={m.context.map((c) => c.text).join('\n')} onClick={() => navigate(m.path, { line: m.context[0]?.line })}>
                    {m.name}
                  </button>
                ))}
              </div>
            )}
            {detail.tags.length > 0 && (
              <div className="conn-row">
                {detail.tags.map((t) => (
                  <span key={t} className="tag" onClick={() => showSearch(`tag:${t}`)}>
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {detail && !locked && (
          <footer className="statusbar">
            <span className={`save-state ${saveState}`}>{saveLabel[saveState]}</span>
            <span>
              {counts.words} words · {counts.chars} chars
            </span>
            {vimMode && mode === 'edit' && <span className="vim-badge">VIM</span>}
            {isEncrypted && <span title="Encrypted in your browser; auto-locks after 15 minutes idle">🔓 Unlocked · encrypted on save</span>}
            <span className="spacer" />
            <label className="hide-narrow">
              <input type="checkbox" checked={lineNumbers} onChange={(e) => setLineNumbers(e.target.checked)} /> Line numbers
            </label>
          </footer>
        )}
      </section>

      {isNarrow && showLeft && <div className="sidebar-backdrop" onClick={() => setShowLeft(false)} />}

      {palette === 'commands' && (
        <CommandPalette
          placeholder="Type a command…"
          onClose={() => setPalette(null)}
          items={commandItems}
        />
      )}
      {(palette === 'templates' || palette === 'new-from-template') && (
        <CommandPalette
          placeholder={palette === 'templates' ? 'Insert template…' : 'New note from template…'}
          emptyText="No templates yet. Create notes in a Templates/ folder. They can use {{title}}, {{date}} and {{time}}."
          onClose={() => setPalette(null)}
          items={templates.map((t) => ({
            id: t.path,
            label: t.name,
            hint: t.folder,
            run: () => (palette === 'templates' ? insertTemplate(t.path) : newFromTemplate(t.path)),
          }))}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onChange={saveSettings}
          vimMode={vimMode}
          setVimMode={setVimMode}
          lineNumbers={lineNumbers}
          setLineNumbers={setLineNumbers}
          viewMode={viewMode}
          setViewMode={setViewMode}
          focus={settingsFocus}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsFocus(undefined);
          }}
        />
      )}
      {historyOpen && detail && (
        <HistoryDialog
          path={detail.path}
          current={draft}
          decode={
            isEncrypted
              ? async (stored) => {
                  const key = noteKeys.current.get(detail.path);
                  if (!key || !isLocked(stored)) return stored;
                  return unlockContent(stored, key);
                }
              : undefined
          }
          onClose={() => setHistoryOpen(false)}
          onRestored={() => {
            dirty.current = false;
            api.note(detail.path).then((d) => applyDetail(d, true)).catch(handleError);
          }}
        />
      )}

      {switcher && (
        <QuickSwitcher notes={notes} onOpen={(p) => navigate(p)} onCreate={(n) => createNote(n)} onClose={() => setSwitcher(false)} />
      )}
      {mergeFrom && (
        <QuickSwitcher
          notes={notes.filter((n) => n.path !== mergeFrom && !n.encrypted)}
          placeholder={`Merge “${mergeFrom.replace(/\.md$/, '').split('/').pop()}” into…`}
          onOpen={(into) => mergeNote(mergeFrom, into)}
          onClose={() => setMergeFrom(null)}
        />
      )}
      {dialog && <Dialog req={dialog} onDone={() => setDialog(null)} />}
    </div>
  );
}
