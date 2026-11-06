/** Print / save a note as PDF, from its rendered reading view. */

const PRINT_CSS = `
  :root { color-scheme: light; }
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif; color: #1f1d19; background: #fff; margin: 0; padding: 0 4px; }
  h1, h2, h3, h4 { line-height: 1.25; page-break-after: avoid; }
  a { color: #2f5fa8; text-decoration: none; }
  pre, code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.88em; }
  pre { background: #f4f2ee; padding: 10px 12px; border-radius: 6px; white-space: pre-wrap; page-break-inside: avoid; }
  :not(pre) > code { background: #f4f2ee; padding: 1px 4px; border-radius: 4px; }
  table { border-collapse: collapse; margin: 12px 0; page-break-inside: avoid; }
  th, td { border: 1px solid #d8d4cc; padding: 5px 9px; text-align: left; }
  blockquote { border-left: 3px solid #d8d4cc; margin: 12px 0; padding: 2px 14px; color: #555; }
  img, svg { max-width: 100%; height: auto; }
  .callout { border-left: 4px solid #9a7b2f; background: #f7f4ec; padding: 8px 12px; margin: 12px 0; border-radius: 4px; page-break-inside: avoid; }
  .callout-title { font-weight: 600; margin-bottom: 4px; display: flex; gap: 6px; }
  li.task { list-style: none; margin-left: -1.2em; }
  .task-box { display: inline-block; width: 0.95em; height: 0.95em; border: 1.5px solid #888; border-radius: 3px; margin-right: 0.45em; vertical-align: -0.1em; text-align: center; font-size: 0.75em; line-height: 0.95em; }
  li.task.done .task-box::after { content: '✓'; }
  li.task.done { color: #888; text-decoration: line-through; }
  mark, .hl { background: #fff1a8; }
  .properties { font-size: 0.85em; color: #555; }
  .properties th { width: 1%; white-space: nowrap; }
  .heading-bookmark, .table-menu-btn, .properties-edit, .tq-box { display: none !important; }
  .katex { font-size: 1.05em; }
  @page { margin: 18mm 16mm; }
`;

/** Self-contained HTML for a note: its rendered body, light print styles and KaTeX styles. */
export function noteHtml(title: string, bodyHtml: string): string {
  const base = new URL('./', location.href).toString();
  const katexCss = [...document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')]
    .filter((el) => (el instanceof HTMLLinkElement ? /katex|index-.*\.css/.test(el.href) : /\.katex/.test(el.textContent ?? '')))
    .map((el) => (el instanceof HTMLLinkElement ? `<link rel="stylesheet" href="${el.href}">` : ''))
    .join('');
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><html><head><meta charset="utf-8"><base href="${base}"><title>${esc(title)}</title>${katexCss}<style>${PRINT_CSS}</style></head><body>${bodyHtml}</body></html>`;
}

/** The current note's reading-view HTML (switch to reading view first). */
export function currentNoteBody(): string | null {
  const el = document.querySelector('.note-panel .preview');
  if (!el) return null;
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.heading-bookmark, .table-menu-btn, .properties-edit, .hover-card').forEach((x) => x.remove());
  return clone.innerHTML;
}

/** Print in the browser (the print dialog offers "Save as PDF"). */
export function printHtml(html: string) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  const go = () => {
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  // Wait for images and stylesheets.
  if (doc.readyState === 'complete') setTimeout(go, 300);
  else frame.addEventListener('load', () => setTimeout(go, 300));
}
