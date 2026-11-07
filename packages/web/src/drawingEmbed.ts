/**
 * Pictures of embedded `.excalidraw` drawings, shared by the reading view and the editor's live preview.
 * The Excalidraw library is loaded only when a note actually shows a drawing.
 */
import { api } from './api';

const escapeText = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Draw an embedded `.excalidraw` drawing as a picture. */
export async function renderDrawingEmbed(el: HTMLElement) {
  const target = el.dataset.target ?? '';
  const name = target.split('/').pop()!.replace(/\.excalidraw$/i, '');
  try {
    const d = (await api.drawing(target)).data as { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };
    const live = (d.elements ?? []).filter((x) => !(x as { isDeleted?: boolean }).isDeleted);
    if (!live.length) {
      el.innerHTML = `<div class="embed-loading">✎ ${escapeText(name)}: empty drawing, click to draw</div>`;
      return;
    }
    const lib = await import('@excalidraw/excalidraw');
    const svg = await lib.exportToSvg({
      elements: live as never,
      appState: { ...(d.appState ?? {}), exportBackground: false, exportWithDarkMode: document.documentElement.dataset.theme !== 'light' } as never,
      files: (d.files ?? {}) as never,
      exportPadding: 12,
    });
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    const cap = document.createElement('div');
    cap.className = 'embed-drawing-caption';
    cap.textContent = `✎ ${name}`;
    el.replaceChildren(svg, cap);
  } catch {
    el.innerHTML = `<div class="embed-missing">“${escapeText(target)}” doesn’t exist yet</div>`;
  }
}

// A drawing was saved: redraw its pictures in open notes.
if (typeof window !== 'undefined') {
  window.addEventListener('octavo:drawing-saved', (e) => {
    const p = ((e as CustomEvent<string>).detail ?? '').toLowerCase();
    const file = p.split('/').pop();
    for (const el of document.querySelectorAll<HTMLElement>('.embed-drawing')) {
      const t = (el.dataset.target ?? '').toLowerCase();
      if (t === p || t === file || t.endsWith('/' + file)) void renderDrawingEmbed(el);
    }
  });
}

