import { useEffect, useRef } from 'react';
import { EditorState, Compartment, Annotation, Transaction, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  placeholder,
  Decoration,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { parseWikiInner } from '../markdown';

export interface EditorHandle {
  scrollToLine(line: number): void;
  focus(): void;
}

interface Props {
  /** Changes when a different note is loaded; resets undo history. */
  docKey: string;
  /** Bumped when content should be replaced from outside (e.g. reloaded from disk). */
  version: number;
  value: string;
  onChange: (value: string) => void;
  noteNames: () => string[];
  tagNames: () => string[];
  onOpenLink: (target: string, heading?: string) => void;
  onReady?: (handle: EditorHandle) => void;
  showLineNumbers?: boolean;
}

const externalUpdate = Annotation.define<boolean>();

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.6em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.35em', fontWeight: '700' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '600' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--text-faint)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--code)' },
  { tag: t.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--text-faint)' },
  { tag: t.list, color: 'var(--accent)' },
  { tag: t.keyword, color: '#c792ea' },
  { tag: [t.string, t.special(t.string)], color: '#c3e88d' },
  { tag: [t.number, t.bool, t.atom], color: '#f78c6c' },
  { tag: t.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.propertyName], color: '#82aaff' },
  { tag: t.typeName, color: '#ffcb6b' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font-size)', backgroundColor: 'transparent', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-text)', lineHeight: '1.65', padding: '24px 0 40vh' },
  '.cm-content': { maxWidth: 'var(--line-width)', margin: '0 auto', padding: '0 32px', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--text-faint)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-wikilink': { color: 'var(--accent)', textDecoration: 'underline', textDecorationColor: 'var(--accent-soft)', cursor: 'pointer' },
  '.cm-hashtag': { color: 'var(--tag-text)', backgroundColor: 'var(--tag-bg)', borderRadius: '4px', padding: '0 2px' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '8px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--on-accent)' },
  '.cm-placeholder': { color: 'var(--text-faint)' },
});

const linkDecorator = new MatchDecorator({
  regexp: /!?\[\[[^\[\]\n]+?\]\]|(?<=^|[\s(])#[\p{L}\p{N}_\-/]*[\p{L}_\-][\p{L}\p{N}_\-/]*/gu,
  decoration: (m) => Decoration.mark({ class: m[0].startsWith('#') ? 'cm-hashtag' : 'cm-wikilink' }),
});

const linkHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = linkDecorator.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = linkDecorator.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Find the [[wikilink]] (if any) covering document position `pos`. */
function wikilinkAt(view: EditorView, pos: number): { target: string; heading?: string } | null {
  const line = view.state.doc.lineAt(pos);
  const offset = pos - line.from;
  for (const m of line.text.matchAll(/!?\[\[([^\[\]\n]+?)\]\]/g)) {
    if (offset >= m.index! && offset <= m.index! + m[0].length) {
      const inner = parseWikiInner(m[1]);
      return { target: inner.target, heading: inner.heading };
    }
  }
  return null;
}

export function Editor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const gutter = useRef(new Compartment());
  const extensions = useRef<Extension[]>([]);
  const lastDocKey = useRef(props.docKey);

  // Create the editor once.
  useEffect(() => {
    const completeLinks = (ctx: CompletionContext): CompletionResult | null => {
      const before = ctx.matchBefore(/\[\[[^\[\]\n|#]*/);
      if (before) {
        return {
          from: before.from + 2,
          filter: true,
          options: propsRef.current.noteNames().map((name) => ({
            label: name,
            type: 'text',
            // Insert the name, add/skip the closing ]] and put the cursor after it.
            apply: (view: EditorView, _c: unknown, from: number, to: number) => {
              const closing = view.state.sliceDoc(to, to + 2) === ']]';
              const insert = closing ? name : `${name}]]`;
              view.dispatch({
                changes: { from, to, insert },
                selection: { anchor: from + name.length + 2 },
                userEvent: 'input.complete',
              });
            },
          })),
        };
      }
      const tag = ctx.matchBefore(/(?<=^|[\s(])#[\p{L}\p{N}_\-/]*/u);
      if (tag && (tag.text.length > 1 || ctx.explicit)) {
        return {
          from: tag.from + 1,
          options: propsRef.current.tagNames().map((name) => ({ label: name, type: 'keyword' })),
        };
      }
      return null;
    };

    extensions.current = [
        gutter.current.of(props.showLineNumbers ? lineNumbers() : []),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        bracketMatching(),
        closeBrackets(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(highlight),
        linkHighlighter,
        autocompletion({ override: [completeLinks], icons: false }),
        placeholder('Start writing… Use [[ to link notes and # for tags.'),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
        theme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !u.transactions.some((tr) => tr.annotation(externalUpdate))) {
            propsRef.current.onChange(u.state.doc.toString());
          }
        }),
        EditorView.domEventHandlers({
          mousedown(e, v) {
            if (!(e.metaKey || e.ctrlKey)) return false;
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos == null) return false;
            const link = wikilinkAt(v, pos);
            if (!link) return false;
            e.preventDefault();
            propsRef.current.onOpenLink(link.target, link.heading);
            return true;
          },
        }),
    ];
    const state = EditorState.create({ doc: props.value, extensions: extensions.current });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    props.onReady?.({
      scrollToLine(line: number) {
        const l = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
        v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'start', yMargin: 40 }) });
        v.focus();
      },
      focus() {
        v.focus();
      },
    });
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Replace content when switching notes (fresh undo history) or reloading from disk.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (lastDocKey.current !== props.docKey) {
      lastDocKey.current = props.docKey;
      v.setState(EditorState.create({ doc: props.value, extensions: extensions.current }));
      v.dispatch({ effects: gutter.current.reconfigure(propsRef.current.showLineNumbers ? lineNumbers() : []) });
      v.scrollDOM.scrollTop = 0;
      return;
    }
    if (v.state.doc.toString() === props.value) return;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: props.value },
      annotations: [externalUpdate.of(true), Transaction.addToHistory.of(false)],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docKey, props.version]);

  useEffect(() => {
    view.current?.dispatch({ effects: gutter.current.reconfigure(props.showLineNumbers ? lineNumbers() : []) });
  }, [props.showLineNumbers]);

  return <div className="editor" ref={host} />;
}
