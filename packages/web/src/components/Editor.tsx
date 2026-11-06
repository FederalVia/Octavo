import { useEffect, useRef } from 'react';
import { livePreview } from '../livePreview';
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
import { vim } from '@replit/codemirror-vim';
import { parseWikiInner } from '../markdown';
import { outliner } from '../outliner';

export interface EditorHandle {
  scrollToLine(line: number): void;
  focus(): void;
  /** Insert text at the cursor. With `snippet`, a `|` in the text marks where the cursor ends up. */
  insert(text: string, snippet?: boolean): void;
  getSelection(): string;
  replaceSelection(text: string): void;
}

interface SlashCommand {
  label: string;
  detail: string;
  /** Snippet; `|` marks the cursor. A function gets the editor for custom behaviour. */
  insert: string | ((v: EditorView, from: number, to: number) => void);
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

/** Insert a snippet, placing the cursor at the `|` marker. */
function insertSnippet(v: EditorView, from: number, to: number, snippet: string) {
  const at = snippet.indexOf('|');
  const text = at === -1 ? snippet : snippet.slice(0, at) + snippet.slice(at + 1);
  v.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + (at === -1 ? text.length : at) },
    userEvent: 'input.complete',
  });
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
  vimMode?: boolean;
  /** Show Markdown formatted while editing (hide marks except on the cursor's line). */
  livePreview?: boolean;
  /** URL for an attachment referenced from this note (images in live preview). */
  fileUrl?: (ref: string) => string;
  /** Upload a pasted/dropped file; resolves to the saved vault path. */
  onUpload?: (file: File) => Promise<string>;
  /** Slash commands that need the app (e.g. picking a template). */
  onSlashCommand?: (command: 'template') => void;
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
  '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer', opacity: '0', transition: 'opacity 0.15s', padding: '0 4px', fontSize: '0.85em' },
  '.cm-gutters:hover .cm-foldGutter .cm-gutterElement, .cm-foldGutter .cm-gutterElement:focus-visible': { opacity: '0.75' },
  '@media (hover: none)': { '.cm-foldGutter .cm-gutterElement': { opacity: '0.45' } },
  '.cm-foldPlaceholder': { background: 'var(--tag-bg)', border: 'none', color: 'var(--text-muted)', borderRadius: '4px', padding: '0 6px', margin: '0 4px' },
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
  '.cm-highlight': { backgroundColor: 'rgba(250, 204, 21, 0.25)', borderRadius: '3px' },
  '.cm-comment': { color: 'var(--text-faint)', fontStyle: 'italic' },
  '.cm-tooltip-autocomplete .cm-completionDetail': { color: 'var(--text-faint)', marginLeft: '10px', fontStyle: 'normal' },
  '.cm-fat-cursor': { background: 'var(--accent) !important', color: 'var(--on-accent) !important' },
  '&:not(.cm-focused) .cm-fat-cursor': { background: 'none !important', outline: '1px solid var(--accent)' },
  '.cm-panels': { backgroundColor: 'var(--bg-elevated)', color: 'var(--text)' },
});

// No lookbehind (Safari < 16.4 can't parse it): a hashtag's preceding space/paren is captured
// in group 1 and skipped when decorating.
const markClass = { hashtag: Decoration.mark({ class: 'cm-hashtag' }), highlight: Decoration.mark({ class: 'cm-highlight' }), comment: Decoration.mark({ class: 'cm-comment' }), wikilink: Decoration.mark({ class: 'cm-wikilink' }) };
const linkDecorator = new MatchDecorator({
  regexp: /!?\[\[[^\[\]\n]+?\]\]|(^|[\s(])(#[\p{L}\p{N}_\-/]*[\p{L}_\-][\p{L}\p{N}_\-/]*)|==[^=\n]+==|%%[^%\n]*%%/gu,
  decorate: (add, from, to, m) => {
    if (m[2] !== undefined) add(from + m[1].length, to, markClass.hashtag);
    else add(from, to, m[0].startsWith('==') ? markClass.highlight : m[0].startsWith('%%') ? markClass.comment : markClass.wikilink);
  },
});

/** ctx.matchBefore for a pattern that starts with an optional lead char (start of line, space, paren), minus that char. */
function matchAfterLead(ctx: CompletionContext, re: RegExp, sigil: string) {
  const m = ctx.matchBefore(re);
  if (!m || m.text.startsWith(sigil)) return m;
  return { from: m.from + 1, to: m.to, text: m.text.slice(1) };
}

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
  const vimC = useRef(new Compartment());
  const lpC = useRef(new Compartment());
  const lpExt = () =>
    livePreview({
      onOpenLink: (t, h) => propsRef.current.onOpenLink(t, h),
      fileUrl: (ref) => (propsRef.current.fileUrl ? propsRef.current.fileUrl(ref) : ref),
    });
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
      const slash = matchAfterLead(ctx, /(?:^|\s)\/[\w-]*/, '/');
      if (slash) {
        const now = new Date();
        const commands: SlashCommand[] = [
          { label: 'Heading 1', detail: '#', insert: '# |' },
          { label: 'Heading 2', detail: '##', insert: '## |' },
          { label: 'Heading 3', detail: '###', insert: '### |' },
          { label: 'Task', detail: '- [ ]', insert: '- [ ] |' },
          { label: 'Bullet list', detail: '-', insert: '- |' },
          { label: 'Numbered list', detail: '1.', insert: '1. |' },
          { label: 'Quote', detail: '>', insert: '> |' },
          { label: 'Callout: note', detail: '[!note]', insert: '> [!note] |\n> ' },
          { label: 'Callout: tip', detail: '[!tip]', insert: '> [!tip] |\n> ' },
          { label: 'Callout: warning', detail: '[!warning]', insert: '> [!warning] |\n> ' },
          { label: 'Callout: foldable', detail: '[!info]-', insert: '> [!info]- |\n> ' },
          { label: 'Table', detail: '| |', insert: '| Column | Column |\n| --- | --- |\n| | |\n' },
          { label: 'Code block', detail: '```', insert: '```|\n\n```' },
          { label: 'Math block', detail: '$$', insert: '$$\n|\n$$' },
          { label: 'Inline math', detail: '$', insert: '$|$' },
          { label: 'Mermaid diagram', detail: 'mermaid', insert: '```mermaid\ngraph TD\n  A[|Start] --> B[Finish]\n```' },
          { label: 'Divider', detail: '---', insert: '---\n|' },
          { label: 'Highlight', detail: '==', insert: '==|==' },
          { label: 'Comment', detail: '%%', insert: '%%|%%' },
          { label: 'Link to note', detail: '[[ ]]', insert: '[[|' },
          { label: 'Embed note', detail: '![[ ]]', insert: '![[|' },
          {
            label: 'Footnote',
            detail: '[^1]',
            insert: (v, from, to) => {
              const doc = v.state.doc.toString();
              let n = 1;
              while (doc.includes(`[^${n}]`)) n++;
              const tail = `\n\n[^${n}]: `;
              v.dispatch({
                changes: [
                  { from, to, insert: `[^${n}]` },
                  { from: v.state.doc.length, insert: tail },
                ],
                selection: { anchor: v.state.doc.length - (to - from) + `[^${n}]`.length + tail.length },
                scrollIntoView: true,
              });
            },
          },
          { label: 'Date', detail: 'today', insert: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}|` },
          { label: 'Time', detail: 'now', insert: `${pad2(now.getHours())}:${pad2(now.getMinutes())}|` },
          ...[
            ['Due today', 0],
            ['Due tomorrow', 1],
            ['Due in a week', 7],
          ].map(([label, days]) => {
            const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (days as number));
            const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
            return { label: label as string, detail: `📅 ${iso}`, insert: `📅 ${iso}|` };
          }),
          {
            label: 'Template…',
            detail: 'insert',
            insert: (v, from, to) => {
              v.dispatch({ changes: { from, to, insert: '' } });
              propsRef.current.onSlashCommand?.('template');
            },
          },
        ];
        return {
          from: slash.from,
          filter: false,
          options: commands
            .filter((c) => c.label.toLowerCase().replace(/[^a-z0-9]/g, '').includes(slash.text.slice(1).toLowerCase().replace(/[^a-z0-9]/g, '')))
            .map((c, i) => ({
              label: c.label,
              detail: c.detail,
              boost: -i,
              type: 'keyword',
              apply: (v: EditorView, _c: unknown, from: number, to: number) =>
                typeof c.insert === 'string' ? insertSnippet(v, from, to, c.insert) : c.insert(v, from, to),
            })),
        };
      }
      const tag = matchAfterLead(ctx, /(?:^|[\s(])#[\p{L}\p{N}_\-/]*/u, '#');
      if (tag && (tag.text.length > 1 || ctx.explicit)) {
        return {
          from: tag.from + 1,
          options: propsRef.current.tagNames().map((name) => ({ label: name, type: 'keyword' })),
        };
      }
      return null;
    };

    const uploadFiles = (v: EditorView, files: File[], pos: number) => {
      const upload = propsRef.current.onUpload;
      if (!upload) return;
      (async () => {
        let at = pos;
        for (const f of files) {
          try {
            const saved = await upload(f);
            const name = saved.split('/').pop()!;
            const text = `![[${name}]]\n`;
            v.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.paste' });
            at += text.length;
          } catch (err) {
            console.error('upload failed', err);
          }
        }
      })();
    };

    extensions.current = [
        vimC.current.of(props.vimMode ? vim() : []),
        gutter.current.of(props.showLineNumbers ? lineNumbers() : []),
        lpC.current.of(props.livePreview ? lpExt() : []),
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
        outliner(),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
        theme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !u.transactions.some((tr) => tr.annotation(externalUpdate))) {
            propsRef.current.onChange(u.state.doc.toString());
          }
        }),
        EditorView.domEventHandlers({
          paste(e, v) {
            const files = [...(e.clipboardData?.files ?? [])];
            if (!files.length || !propsRef.current.onUpload) return false;
            e.preventDefault();
            uploadFiles(v, files, v.state.selection.main.head);
            return true;
          },
          drop(e, v) {
            const files = [...(e.dataTransfer?.files ?? [])];
            if (!files.length || !propsRef.current.onUpload) return false;
            e.preventDefault();
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
            uploadFiles(v, files, pos);
            return true;
          },
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
      insert(text: string, snippet = false) {
        const cur = view.current ?? v;
        const { from, to } = cur.state.selection.main;
        if (snippet) insertSnippet(cur, from, to, text);
        else cur.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true });
        cur.focus();
      },
      getSelection() {
        const cur = view.current ?? v;
        const { from, to } = cur.state.selection.main;
        return cur.state.sliceDoc(from, to);
      },
      replaceSelection(text: string) {
        const cur = view.current ?? v;
        cur.dispatch(cur.state.replaceSelection(text));
        cur.focus();
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
      v.dispatch({
        effects: [
          gutter.current.reconfigure(propsRef.current.showLineNumbers ? lineNumbers() : []),
          vimC.current.reconfigure(propsRef.current.vimMode ? vim() : []),
          lpC.current.reconfigure(propsRef.current.livePreview ? lpExt() : []),
        ],
      });
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

  useEffect(() => {
    view.current?.dispatch({ effects: vimC.current.reconfigure(props.vimMode ? vim() : []) });
  }, [props.vimMode]);

  useEffect(() => {
    view.current?.dispatch({ effects: lpC.current.reconfigure(props.livePreview ? lpExt() : []) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.livePreview]);

  return <div className="editor" ref={host} />;
}
