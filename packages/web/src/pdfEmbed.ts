/**
 * Embedded PDFs drawn page by page as pictures (pdf.js), in the reading view and the editor's live preview.
 * An <iframe> shows only the first page on iPhones (and nothing where the browser has no PDF viewer), which
 * hides most of a handwritten Notability or GoodNotes note. pdf.js loads only when a note has a PDF, and
 * pages are drawn as they scroll into view.
 */
const MAX_PAGES = 60;

type PdfLib = typeof import('pdfjs-dist');
let lib: Promise<PdfLib> | null = null;
function loadPdfJs(): Promise<PdfLib> {
  return (lib ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
    return pdfjs;
  }));
}

const escapeText = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Fill an `.embed-pdf-pages` element (data-src: the file URL, data-name: what to call it). */
export async function renderPdfEmbed(el: HTMLElement): Promise<void> {
  const src = el.dataset.src ?? '';
  const name = el.dataset.name ?? 'PDF';
  const open = `<a class="embed-pdf-open" href="${escapeText(src)}" target="_blank" rel="noopener">Open PDF</a>`;
  try {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ url: src }).promise;
    const pages = document.createElement('div');
    pages.className = 'embed-pdf-list';
    const count = Math.min(doc.numPages, MAX_PAGES);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          observer.unobserve(e.target);
          void drawPage(e.target as HTMLCanvasElement);
        }
      },
      { rootMargin: '600px 0px' },
    );
    const drawPage = async (canvas: HTMLCanvasElement) => {
      try {
        const page = await doc.getPage(Number(canvas.dataset.page));
        const cssWidth = Math.max(200, el.clientWidth || 600);
        const base = page.getViewport({ scale: 1 });
        const scale = (cssWidth / base.width) * Math.min(2, window.devicePixelRatio || 1);
        const vp = page.getViewport({ scale });
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        await page.render({ canvas, viewport: vp }).promise;
        canvas.classList.add('drawn');
      } catch {
        canvas.classList.add('failed');
      }
    };
    for (let i = 1; i <= count; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas');
      canvas.className = 'embed-pdf-page';
      canvas.dataset.page = String(i);
      // Keep the page's shape before it's drawn, so the note doesn't jump while scrolling.
      canvas.style.aspectRatio = `${vp.width} / ${vp.height}`;
      canvas.setAttribute('aria-label', `${name}, page ${i}`);
      pages.appendChild(canvas);
      observer.observe(canvas);
    }
    const cap = document.createElement('div');
    cap.className = 'embed-pdf-caption';
    cap.innerHTML = `📄 ${escapeText(name)} · ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}${doc.numPages > count ? ` (first ${count} shown)` : ''} · ${open}`;
    el.replaceChildren(pages, cap);
  } catch {
    el.innerHTML = `<div class="embed-missing">Couldn’t show “${escapeText(name)}” · ${open}</div>`;
  }
}
