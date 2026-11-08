/**
 * Live Preview: Markdown is shown formatted while you edit. Formatting marks
 * (**, #, [[ ]], links…) are hidden on every line except the ones the cursor is
 * on, checkboxes become real checkboxes, and links and images render inline.
 */
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { renderDrawingEmbed } from './drawingEmbed';
import { renderPdfEmbed } from './pdfEmbed';

export interface LivePreviewOptions {
  onOpenLink: (target: string, heading?: string) => void;
  /** URL for an attachment (e.g. an image) referenced from the note. */
  fileUrl: (ref: string) => string;
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

class CheckboxWidget extends WidgetType {
  constructor(
    readonly status: string,
    readonly pos: number,
  ) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.status === this.status && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('span');
    const done = this.status === 'x' || this.status === 'X';
    box.className = `cm-lp-task task-box interactive${done ? ' done' : ''}`;
    box.dataset.status = this.status;
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(done));
    if (this.status !== ' ' && !done) box.textContent = this.status;
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      // pos is the "[" of "[ ]": the status character is right after it.
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.status === ' ' ? 'x' : ' ' } });
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class TextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly cls: string,
  ) {
    super();
  }
  eq(o: TextWidget) {
    return o.text === this.text && o.cls === this.cls;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width?: number,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.width === this.width;
  }
  toDOM() {
    const img = document.createElement('img');
    img.className = 'cm-lp-image';
    img.src = this.src;
    img.alt = this.alt;
    if (this.width) img.width = this.width;
    img.loading = 'lazy';
    return img;
  }
}

/** `![[sketch.excalidraw]]` drawn as a picture, as in the reading view; tapping it opens the drawing. */
class DrawingWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly open: (target: string) => void,
  ) {
    super();
  }
  eq(o: DrawingWidget) {
    return o.target === this.target;
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div');
    el.className = 'embed-drawing cm-lp-drawing';
    el.dataset.target = this.target;
    el.setAttribute('role', 'button');
    el.title = 'Open drawing';
    el.innerHTML = '<div class="embed-loading"></div>';
    (el.firstChild as HTMLElement).textContent = `✎ ${this.target.split('/').pop()!.replace(/\.excalidraw$/i, '')}`;
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      e.preventDefault();
      this.open(this.target);
    });
    void renderDrawingEmbed(el).then(() => view.requestMeasure());
    return el;
  }
  get estimatedHeight() {
    return 220;
  }
  ignoreEvent() {
    return true;
  }
}

/** `![[file.pdf]]` drawn page by page, as in the reading view. */
class PdfWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly name: string,
  ) {
    super();
  }
  eq(o: PdfWidget) {
    return o.src === this.src;
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div');
    el.className = 'embed-pdf-pages cm-lp-pdf';
    el.dataset.src = this.src;
    el.dataset.name = this.name;
    el.innerHTML = '<div class="embed-loading"></div>';
    (el.firstChild as HTMLElement).textContent = `📄 ${this.name}`;
    el.addEventListener('mousedown', (e) => {
      if (!(e.target as HTMLElement).closest('a')) e.preventDefault();
    });
    void renderPdfEmbed(el).then(() => view.requestMeasure());
    return el;
  }
  get estimatedHeight() {
    return 500;
  }
  ignoreEvent() {
    return true;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new TextWidget('•', 'cm-lp-bullet') });
const hr = Decoration.replace({ widget: new TextWidget('', 'cm-lp-hr') });

/** Line numbers touched by the selection: those lines show their raw Markdown. */
function activeLines(state: EditorState): Set<number> {
  const out = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return out;
}

function build(view: EditorView, opts: LivePreviewOptions): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const active = activeLines(state);
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const decos: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  const inCode = (pos: number) => {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent) {
      if (n.name === 'InlineCode' || n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'CodeText') return true;
    }
    return false;
  };

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        if (name === 'FencedCode' || name === 'CodeBlock') {
          for (let p = node.from; p <= node.to; ) {
            const line = doc.lineAt(p);
            decos.push(Decoration.line({ class: 'cm-lp-codeline' }).range(line.from));
            p = line.to + 1;
          }
          return false;
        }
        if (name === 'FrontMatter' || name === 'HTMLBlock' || name === 'CommentBlock') return false;
        if (isActive(node.from)) return;
        switch (name) {
          case 'HeaderMark': {
            // "## " at the start of a heading (not the closing marks of a setext heading).
            const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            if (node.from === doc.lineAt(node.from).from) decos.push(hide.range(node.from, end));
            break;
          }
          case 'EmphasisMark':
          case 'StrikethroughMark':
            decos.push(hide.range(node.from, node.to));
            break;
          case 'CodeMark':
            if (node.node.parent?.name === 'InlineCode') decos.push(hide.range(node.from, node.to));
            break;
          case 'QuoteMark': {
            const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            decos.push(hide.range(node.from, end));
            decos.push(Decoration.line({ class: 'cm-lp-quote' }).range(doc.lineAt(node.from).from));
            break;
          }
          case 'HorizontalRule':
            decos.push(hr.range(node.from, node.to));
            break;
          case 'ListMark': {
            const after = doc.sliceString(node.to, node.to + 5);
            const isTask = /^ \[.\]/.test(after);
            const mark = doc.sliceString(node.from, node.to);
            if (isTask) decos.push(hide.range(node.from, node.to + 1));
            else if (/^[-*+]$/.test(mark)) decos.push(bullet.range(node.from, node.to));
            break;
          }
          case 'TaskMarker': {
            const status = doc.sliceString(node.from + 1, node.from + 2);
            decos.push(Decoration.replace({ widget: new CheckboxWidget(status, node.from) }).range(node.from, node.to));
            if (status === 'x' || status === 'X') {
              const line = doc.lineAt(node.from);
              if (node.to + 1 < line.to) decos.push(Decoration.mark({ class: 'cm-lp-done' }).range(node.to + 1, line.to));
            }
            break;
          }
          case 'Link': {
            // [text](url): show only the text, as a link.
            const marks = node.node.getChildren('LinkMark');
            const url = node.node.getChild('URL');
            if (marks.length < 2 || !url) break;
            const textFrom = marks[0].to;
            const textTo = marks[1].from;
            if (textTo <= textFrom) break;
            decos.push(hide.range(node.from, textFrom));
            decos.push(Decoration.mark({ class: 'cm-lp-link', attributes: { 'data-href': doc.sliceString(url.from, url.to) } }).range(textFrom, textTo));
            decos.push(hide.range(textTo, node.to));
            return false;
          }
          case 'Image': {
            const url = node.node.getChild('URL');
            const marks = node.node.getChildren('LinkMark');
            if (!url || marks.length < 2) break;
            const src = doc.sliceString(url.from, url.to);
            const alt = doc.sliceString(marks[0].to, marks[1].from);
            const resolved = /^(https?:|data:)/i.test(src) ? src : opts.fileUrl(decodeURIComponent(src));
            decos.push(Decoration.replace({ widget: new ImageWidget(resolved, alt) }).range(node.from, node.to));
            return false;
          }
        }
      },
    });

    // Obsidian syntax the Markdown parser doesn't know: [[wikilinks]], ![[embeds]] and ==highlights==.
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      if (!active.has(line.number)) {
        for (const m of line.text.matchAll(/(!?)\[\[([^\[\]\n]+?)\]\]/g)) {
          const start = line.from + m.index!;
          const end = start + m[0].length;
          if (inCode(start)) continue;
          const inner = m[2];
          const pipe = inner.indexOf('|');
          const target = pipe === -1 ? inner : inner.slice(0, pipe);
          const label = pipe === -1 ? '' : inner.slice(pipe + 1);
          if (m[1] && /\.excalidraw$/i.test(target.trim())) {
            decos.push(Decoration.replace({ widget: new DrawingWidget(target.trim(), (t) => opts.onOpenLink(t)) }).range(start, end));
            continue;
          }
          if (m[1] && /\.pdf$/i.test(target.trim())) {
            decos.push(Decoration.replace({ widget: new PdfWidget(opts.fileUrl(target.trim()), target.trim().split('/').pop()!) }).range(start, end));
            continue;
          }
          if (m[1] && IMAGE.test(target.trim())) {
            const width = /^\d+$/.test(label) ? Number(label) : undefined;
            decos.push(Decoration.replace({ widget: new ImageWidget(opts.fileUrl(target.trim()), target, width) }).range(start, end));
            continue;
          }
          const hash = target.indexOf('#');
          const attrs = { 'data-target': (hash === -1 ? target : target.slice(0, hash)).trim(), 'data-heading': hash === -1 ? '' : target.slice(hash + 1).replace(/^\^/, '').trim() };
          const labelFrom = pipe === -1 ? start + m[1].length + 2 : start + m[1].length + 2 + pipe + 1;
          const labelTo = end - 2;
          decos.push(hide.range(start, labelFrom));
          decos.push(Decoration.mark({ class: `cm-lp-wikilink${m[1] ? ' embed' : ''}`, attributes: attrs }).range(labelFrom, labelTo));
          decos.push(hide.range(labelTo, end));
        }
        for (const m of line.text.matchAll(/==(?:\{(\w+)\})?([^=\n]+?)==/g)) {
          const start = line.from + m.index!;
          if (inCode(start)) continue;
          const open = 2 + (m[1] ? m[1].length + 2 : 0);
          const end = start + m[0].length;
          decos.push(hide.range(start, start + open));
          decos.push(Decoration.mark({ class: `cm-lp-highlight hl-${m[1] ?? 'yellow'}` }).range(start + open, end - 2));
          decos.push(hide.range(end - 2, end));
        }
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(decos, true);
}

export function livePreview(opts: LivePreviewOptions) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, opts);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.state) !== syntaxTree(u.startState)) {
          this.decorations = build(u.view, opts);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e) {
          const el = (e.target as HTMLElement).closest('.cm-lp-wikilink, .cm-lp-link') as HTMLElement | null;
          if (!el) return false;
          e.preventDefault();
          if (el.dataset.href) {
            const href = el.dataset.href;
            if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener');
            else opts.onOpenLink(decodeURIComponent(href.replace(/\.md(#.*)?$/i, '')), href.includes('#') ? decodeURIComponent(href.split('#')[1]) : undefined);
          } else opts.onOpenLink(el.dataset.target ?? '', el.dataset.heading || undefined);
          return true;
        },
      },
    },
  );
  return [plugin, EditorView.baseTheme(lpTheme)];
}

const lpTheme = {
  '.cm-lp-link, .cm-lp-wikilink': { color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--accent-soft)', textUnderlineOffset: '3px' },
  '.cm-lp-wikilink.embed': { fontStyle: 'italic' },
  '.cm-lp-bullet': { color: 'var(--accent)', padding: '0 0.15em' },
  '.cm-lp-hr': { display: 'inline-block', width: '100%', borderTop: '1px solid var(--border)', verticalAlign: 'middle' },
  '.cm-lp-quote': { borderLeft: '3px solid var(--accent-soft)', paddingLeft: '12px !important', color: 'var(--text-muted)' },
  '.cm-lp-codeline': { backgroundColor: 'var(--code-bg)', fontFamily: 'var(--font-mono)' },
  '.cm-lp-done': { color: 'var(--text-faint)', textDecoration: 'line-through' },
  '.cm-lp-task': { margin: '0 0.35em 0 0', verticalAlign: 'middle', cursor: 'pointer' },
  '.cm-lp-pdf': { display: 'block', margin: '6px 0' },
  '.cm-lp-drawing': { display: 'block', margin: '6px 0', cursor: 'pointer' },
  '.cm-lp-image': { maxWidth: '100%', display: 'block', margin: '6px 0', borderRadius: '6px' },
  '.cm-lp-highlight': { backgroundColor: 'rgba(250, 204, 21, 0.28)', borderRadius: '3px', padding: '0 2px' },
  '.cm-lp-highlight.hl-red': { backgroundColor: 'rgba(248, 113, 113, 0.28)' },
  '.cm-lp-highlight.hl-orange': { backgroundColor: 'rgba(251, 146, 60, 0.28)' },
  '.cm-lp-highlight.hl-green': { backgroundColor: 'rgba(74, 222, 128, 0.25)' },
  '.cm-lp-highlight.hl-blue': { backgroundColor: 'rgba(96, 165, 250, 0.28)' },
  '.cm-lp-highlight.hl-purple': { backgroundColor: 'rgba(192, 132, 252, 0.28)' },
};
