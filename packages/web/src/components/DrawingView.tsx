/**
 * Drawings: an Excalidraw editor for `.excalidraw` files in the vault. Loaded on demand, so the
 * drawing library only downloads the first time a drawing is opened.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
  const title = path.replace(/\.excalidraw$/i, '').split('/').pop();

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
      const r = await api.saveDrawing(path, JSON.parse(json), mtime.current);
      mtime.current = r.mtime;
      lastSaved.current = json;
      setStatus('Saved');
      window.dispatchEvent(new CustomEvent('octavo:drawing-saved', { detail: r.path }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Changed elsewhere since we opened it: keep our version (it's what's on screen).
        try {
          const r = await api.saveDrawing(path, JSON.parse(json));
          mtime.current = r.mtime;
          lastSaved.current = json;
          setStatus('Saved (replaced a newer copy)');
        } catch (e2) {
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

  return (
    <div
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
          renderTopRightUI={() => (
            <div className="dv-top">
              {status && <span className="dv-status">{status}</span>}
              <button className="dv-done" onClick={close} title="Back to your notes">
                Done
              </button>
            </div>
          )}
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
    </div>
  );
}
