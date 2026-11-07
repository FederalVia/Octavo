/**
 * Drawings: an Excalidraw editor for `.excalidraw` files in the vault. Loaded on demand, so the
 * drawing library only downloads the first time a drawing is opened.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Excalidraw, MainMenu, serializeAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { api, ApiError } from '../api';

type Scene = { elements: readonly unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };

/** What counts as a change worth saving: element edits, images, background. Not panning or zooming. */
function changeKey(elements: readonly unknown[], appState: Record<string, unknown> | undefined, files: Record<string, unknown> | undefined): string {
  let v = 0;
  for (const el of elements as { version?: number; versionNonce?: number; isDeleted?: boolean }[]) v += (el.version ?? 0) * 31 + (el.versionNonce ?? 0) % 997 + (el.isDeleted ? 7 : 0);
  return `${elements.length}:${v}:${Object.keys(files ?? {}).length}:${String(appState?.viewBackgroundColor ?? '')}`;
}

export default function DrawingView({ path, dark, onClose }: { path: string; dark: boolean; onClose: () => void }) {
  const [scene, setScene] = useState<Scene | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const mtime = useRef<number | undefined>(undefined);
  const lastSaved = useRef('');
  const savedKey = useRef('');
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Where saves go: the drawing itself, or a conflict copy once it was changed elsewhere.
  const target = useRef(path);
  const title = path.replace(/\.excalidraw$/i, '').split('/').pop();
  // Phones: Excalidraw's top bar is full of tools, so Done goes in the middle of its bottom bar instead.
  const [mobile, setMobile] = useState(false);
  const [bottomSlot, setBottomSlot] = useState<HTMLElement | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    api
      .drawing(path)
      .then((r) => {
        if (!live) return;
        mtime.current = r.mtime;
        const d = r.data as Scene & { appState?: Record<string, unknown> };
        savedKey.current = changeKey(d.elements ?? [], d.appState, d.files);
        setScene({ elements: d.elements ?? [], appState: { ...(d.appState ?? {}), collaborators: new Map() }, files: d.files ?? {} });
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [path]);

  const flush = useCallback(async () => {
    const json = pending.current;
    if (!json || json === lastSaved.current) return;
    pending.current = null;
    setStatus('Saving…');
    try {
      const r = await api.saveDrawing(target.current, JSON.parse(json), mtime.current);
      mtime.current = r.mtime;
      lastSaved.current = json;
      setStatus('Saved');
      window.dispatchEvent(new CustomEvent('octavo:drawing-saved', { detail: r.path }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Changed elsewhere since we opened it: leave that copy alone and save ours beside it.
        try {
          const d = new Date();
          const pad = (n: number) => String(n).padStart(2, '0');
          const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
          const conflictPath = target.current.replace(/\.excalidraw$/i, '') + ` (conflict ${stamp}).excalidraw`;
          const r = await api.saveDrawing(conflictPath, JSON.parse(json), undefined, true);
          target.current = r.path;
          mtime.current = r.mtime;
          lastSaved.current = json;
          setStatus(`Changed elsewhere: your version saved as ${r.path.split('/').pop()}`);
          window.dispatchEvent(new CustomEvent('octavo:drawing-saved', { detail: r.path }));
        } catch (e2) {
          pending.current = json;
          setStatus(`Not saved: ${(e2 as Error).message}`);
        }
      } else {
        pending.current = json;
        setStatus(`Not saved: ${(err as Error).message}`);
      }
    }
  }, [path]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );

  const close = () => {
    if (timer.current) clearTimeout(timer.current);
    void flush().then(onClose);
  };

  if (error) {
    return (
      <div className="drawing-view">
        <div className="dv-error">
          <p>{error}</p>
          <button onClick={onClose}>Back</button>
        </div>
      </div>
    );
  }

  useEffect(() => {
    if (!mobile || !scene) return;
    const root = viewRef.current;
    if (!root) return;
    const ensure = () => {
      const bar = root.querySelector<HTMLElement>('.App-bottom-bar .App-toolbar-content');
      if (!bar) return setBottomSlot(null);
      let slot = bar.querySelector<HTMLElement>(':scope > .dv-bottom-slot');
      if (!slot) {
        slot = document.createElement('div');
        slot.className = 'dv-bottom-slot';
        bar.insertBefore(slot, bar.children[1] ?? null);
      }
      setBottomSlot((cur) => (cur === slot ? cur : slot));
    };
    ensure();
    // Excalidraw redraws its bars (e.g. when a shape is selected): put the slot back when that happens.
    const mo = new MutationObserver(ensure);
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [mobile, scene]);

  return (
    <div
      ref={viewRef}
      className="drawing-view"
      onKeyDown={(e) => {
        // Esc closes the drawing when nothing in Excalidraw is using it (no tool, menu or text edit).
        if (e.key === 'Escape' && !(e.target as HTMLElement).closest('textarea, input, [role="dialog"]') && !document.querySelector('.excalidraw .dropdown-menu')) {
          const t = document.querySelector('.excalidraw .App-menu_top .ToolIcon__icon[aria-checked="true"]');
          if (!t) close();
        }
      }}
    >
      {scene ? (
        <Excalidraw
          initialData={{ ...scene, scrollToContent: true } as never}
          theme={dark ? 'dark' : 'light'}
          name={title}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, saveAsImage: true, export: { saveFileToDisk: true } } }}
          onChange={(elements, appState, files) => {
            const key = changeKey(elements, appState as unknown as Record<string, unknown>, files as unknown as Record<string, unknown>);
            if (key === savedKey.current) return;
            savedKey.current = key;
            pending.current = serializeAsJSON(elements, appState, files, 'local');
            setStatus('');
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => void flush(), 900);
          }}
          renderTopRightUI={(isMobile) => {
            if (isMobile !== mobile) queueMicrotask(() => setMobile(isMobile));
            if (isMobile) return null;
            return (
              <div className="dv-top">
                {status && <span className="dv-status">{status}</span>}
                <button className="dv-done" onClick={close} title="Back to your notes">
                  Done
                </button>
              </div>
            );
          }}
        >
          <MainMenu>
            <MainMenu.Item onSelect={close}>← Back to notes</MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
      ) : (
        <div className="dv-error muted">Loading drawing…</div>
      )}
      {mobile &&
        bottomSlot &&
        createPortal(
          <>
            {status && <span className="dv-status">{status}</span>}
            <button className="dv-done" onClick={close} title="Back to your notes">
              Done
            </button>
          </>,
          bottomSlot,
        )}
    </div>
  );
}
