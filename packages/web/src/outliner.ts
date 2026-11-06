/**
 * Outliner: work with Markdown lists as an outline.
 *
 * - Tab / Shift-Tab on a list item indents or outdents it together with everything nested under it.
 * - Ctrl/Cmd+Shift+↑/↓ moves the item (and its children) above the previous or below the next sibling.
 * - Ctrl/Cmd+Enter cycles a list item through plain → [ ] → [x] → [ ].
 * - List items with children, and heading sections, can be folded (arrows in the gutter, or
 *   Ctrl/Cmd+Shift+[ and ]).
 */
import { EditorSelection, type EditorState, type Extension, type Line } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';
import { foldGutter, foldKeymap, foldService, indentUnit } from '@codemirror/language';

const ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[.\]\s+)?/;
const HEADING = /^(#{1,6})\s/;
const FENCE = /^\s*(```|~~~)/;

const width = (ws: string) => ws.replace(/\t/g, '    ').length;

/** Lines inside fenced code blocks (1-based line numbers). */
function fencedLines(state: EditorState): Set<number> {
  const inside = new Set<number>();
  let open = false;
  for (let i = 1; i <= state.doc.lines; i++) {
    const t = state.doc.line(i).text;
    if (FENCE.test(t)) {
      inside.add(i);
      open = !open;
      continue;
    }
    if (open) inside.add(i);
  }
  return inside;
}

function itemAt(state: EditorState, lineNo: number): { line: Line; indent: number } | null {
  const line = state.doc.line(lineNo);
  const m = ITEM.exec(line.text);
  return m ? { line, indent: width(m[1]) } : null;
}

/** The last line belonging to the item on `lineNo` (its children and continuation lines). */
function itemEnd(state: EditorState, lineNo: number, indent: number): number {
  let end = lineNo;
  for (let i = lineNo + 1; i <= state.doc.lines; i++) {
    const t = state.doc.line(i).text;
    if (t.trim() === '') {
      // A blank line only belongs to the item if something nested follows it.
      let j = i + 1;
      while (j <= state.doc.lines && state.doc.line(j).text.trim() === '') j++;
      if (j <= state.doc.lines && width(/^\s*/.exec(state.doc.line(j).text)![0]) > indent) {
        i = j - 1;
        continue;
      }
      break;
    }
    if (width(/^\s*/.exec(t)![0]) <= indent) break;
    end = i;
  }
  return end;
}

/** The indent unit lists use in this document: a tab, or the first nested list's spaces. */
function listUnit(state: EditorState): string {
  for (let i = 1; i <= Math.min(state.doc.lines, 2000); i++) {
    const m = /^(\s+)([-*+]|\d+[.)])\s/.exec(state.doc.line(i).text);
    if (m) return m[1].startsWith('\t') ? '\t' : m[1].length >= 4 ? '    ' : m[1].length >= 2 ? m[1].slice(0, Math.min(m[1].length, 4)) : '  ';
  }
  return state.facet(indentUnit) === '  ' ? '\t' : state.facet(indentUnit);
}

/** The block of list lines the selection touches: from the first selected item to the end of the last one's children. */
function selectedItems(state: EditorState): { from: number; to: number } | null {
  const sel = state.selection.main;
  const first = state.doc.lineAt(sel.from).number;
  const last = state.doc.lineAt(sel.to).number;
  const head = itemAt(state, first);
  if (!head) return null;
  let to = last;
  for (let i = first; i <= last; i++) {
    const it = itemAt(state, i);
    if (it) to = Math.max(to, itemEnd(state, i, it.indent));
  }
  return { from: first, to };
}

function indentItems(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const block = selectedItems(state);
  if (!block) return false;
  if (fencedLines(state).has(block.from)) return false;
  const unit = listUnit(state);
  const unitWidth = width(unit);
  const changes: { from: number; to?: number; insert: string }[] = [];
  if (dir === 1) {
    // Only indent under a previous item (a list can't start more nested than its parent).
    const head = itemAt(state, block.from)!;
    let prev = block.from - 1;
    while (prev >= 1 && state.doc.line(prev).text.trim() === '') prev--;
    const prevItem = prev >= 1 ? itemAt(state, prev) : null;
    const prevIndent = prevItem ? prevItem.indent : prev >= 1 && width(/^\s*/.exec(state.doc.line(prev).text)![0]) > head.indent ? Infinity : -1;
    if (prevIndent < head.indent) return true; // nothing to nest under: swallow Tab so focus stays
    for (let i = block.from; i <= block.to; i++) {
      const l = state.doc.line(i);
      if (l.text.trim() === '') continue;
      changes.push({ from: l.from, insert: unit });
    }
  } else {
    for (let i = block.from; i <= block.to; i++) {
      const l = state.doc.line(i);
      const ws = /^\s*/.exec(l.text)![0];
      if (!ws) {
        if (i === block.from) return true; // already at the top level
        continue;
      }
      let cut = 0;
      let w = 0;
      while (cut < ws.length && w < unitWidth) {
        w += ws[cut] === '\t' ? 4 : 1;
        cut++;
      }
      changes.push({ from: l.from, to: l.from + cut, insert: '' });
    }
  }
  if (!changes.length) return true;
  view.dispatch({ changes, userEvent: dir === 1 ? 'input.indent' : 'delete.dedent', scrollIntoView: true });
  return true;
}

function moveItem(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const lineNo = state.doc.lineAt(state.selection.main.head).number;
  const it = itemAt(state, lineNo);
  if (!it) return false;
  const end = itemEnd(state, lineNo, it.indent);
  let swapFrom: number;
  let swapTo: number;
  if (dir === -1) {
    // Find the previous sibling: the nearest item above at the same indent, with nothing shallower in between.
    let i = lineNo - 1;
    let found = -1;
    while (i >= 1) {
      const t = state.doc.line(i).text;
      if (t.trim() !== '') {
        const w = width(/^\s*/.exec(t)![0]);
        if (w < it.indent) break;
        const s = itemAt(state, i);
        if (s && s.indent === it.indent) {
          found = i;
          break;
        }
        if (!s && w <= it.indent) break;
      }
      i--;
    }
    if (found < 0) return true;
    swapFrom = found;
    swapTo = lineNo - 1;
  } else {
    let next = end + 1;
    while (next <= state.doc.lines && state.doc.line(next).text.trim() === '') next++;
    const s = next <= state.doc.lines ? itemAt(state, next) : null;
    if (!s || s.indent !== it.indent) return true;
    swapFrom = end + 1;
    swapTo = itemEnd(state, next, s.indent);
  }
  const a = { from: state.doc.line(lineNo).from, to: state.doc.line(end).to };
  const b = { from: state.doc.line(swapFrom).from, to: state.doc.line(swapTo).to };
  const aText = state.sliceDoc(a.from, a.to);
  const bText = state.sliceDoc(b.from, b.to);
  const offset = state.selection.main.head - a.from;
  if (dir === -1) {
    // b is above a: replace [b.from, a.to] with a + "\n" + b
    view.dispatch({
      changes: { from: b.from, to: a.to, insert: `${aText}\n${bText}` },
      selection: EditorSelection.cursor(b.from + offset),
      scrollIntoView: true,
      userEvent: 'move.line',
    });
  } else {
    view.dispatch({
      changes: { from: a.from, to: b.to, insert: `${bText}\n${aText}` },
      selection: EditorSelection.cursor(a.from + bText.length + 1 + offset),
      scrollIntoView: true,
      userEvent: 'move.line',
    });
  }
  return true;
}

function cycleCheckbox(view: EditorView): boolean {
  const { state } = view;
  const changes: { from: number; to: number; insert: string }[] = [];
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      const m = ITEM.exec(line.text);
      if (!m) {
        // Not a list item: make it a task.
        const ws = /^\s*/.exec(line.text)![0];
        changes.push({ from: line.from + ws.length, to: line.from + ws.length, insert: '- [ ] ' });
        continue;
      }
      const boxAt = line.from + m[1].length + m[2].length + m[3].length;
      if (!m[4]) changes.push({ from: boxAt, to: boxAt, insert: '[ ] ' });
      else changes.push({ from: boxAt + 1, to: boxAt + 2, insert: m[4][1] === ' ' ? 'x' : ' ' });
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: 'input' });
  return true;
}

/** Fold list items with children, and heading sections. */
const outlineFolding = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart);
  const h = HEADING.exec(line.text);
  if (h) {
    const level = h[1].length;
    let end = line.number;
    let fence = false;
    for (let i = line.number + 1; i <= state.doc.lines; i++) {
      const t = state.doc.line(i).text;
      if (FENCE.test(t)) fence = !fence;
      const hh = !fence && HEADING.exec(t);
      if (hh && hh[1].length <= level) break;
      end = i;
    }
    while (end > line.number && state.doc.line(end).text.trim() === '') end--;
    return end > line.number ? { from: line.to, to: state.doc.line(end).to } : null;
  }
  const m = ITEM.exec(line.text);
  if (!m) return null;
  const end = itemEnd(state, line.number, width(m[1]));
  return end > line.number ? { from: line.to, to: state.doc.line(end).to } : null;
});

export function outliner(): Extension {
  return [
    outlineFolding,
    foldGutter({ openText: '▾', closedText: '▸' }),
    keymap.of([
      { key: 'Tab', run: (v) => indentItems(v, 1) },
      { key: 'Shift-Tab', run: (v) => indentItems(v, -1) },
      { key: 'Mod-Shift-ArrowUp', run: (v) => moveItem(v, -1) },
      { key: 'Mod-Shift-ArrowDown', run: (v) => moveItem(v, 1) },
      { key: 'Mod-Enter', run: cycleCheckbox },
      ...foldKeymap,
    ]),
  ];
}
