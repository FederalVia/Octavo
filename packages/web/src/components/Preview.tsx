import { useEffect, useMemo, useRef } from 'react';
import { createRenderer, slugify, splitFrontmatter } from '../markdown';

interface Props {
  content: string;
  exists: (target: string) => boolean;
  /** Changes whenever the set of note names changes, to restyle unresolved links. */
  namesKey: string;
  onOpenLink: (target: string, heading?: string, opts?: { markdown?: boolean }) => void;
  onTag: (tag: string) => void;
  scrollToHeading?: string | null;
  onScrolled?: () => void;
}

function renderValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(renderValue).join(', ');
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v ?? '');
}

export function Preview({ content, exists, namesKey, onOpenLink, onTag, scrollToHeading, onScrolled }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const render = useMemo(() => createRenderer(exists), [namesKey]);
  const html = useMemo(() => render(content), [render, content]);
  const fm = useMemo(() => splitFrontmatter(content).frontmatter, [content]);

  useEffect(() => {
    if (!scrollToHeading || !ref.current) return;
    const el = ref.current.querySelector(`#${CSS.escape(slugify(scrollToHeading))}`);
    el?.scrollIntoView({ block: 'start' });
    onScrolled?.();
  }, [scrollToHeading, html, onScrolled]);

  return (
    <div className="preview-scroll">
      <article
        className="preview markdown"
        ref={ref}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          const link = target.closest('a.wikilink') as HTMLAnchorElement | null;
          if (link) {
            e.preventDefault();
            const t = link.dataset.target ?? '';
            const h = link.dataset.heading || undefined;
            if (!t && h) {
              ref.current?.querySelector(`#${CSS.escape(slugify(h))}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
              return;
            }
            onOpenLink(t, h, { markdown: link.dataset.md === '1' });
            return;
          }
          const tag = target.closest('a.tag') as HTMLAnchorElement | null;
          if (tag) {
            e.preventDefault();
            onTag(tag.dataset.tag ?? '');
          }
        }}
      >
        {fm && Object.keys(fm).length > 0 && (
          <table className="properties">
            <tbody>
              {Object.entries(fm).map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td>{renderValue(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </article>
    </div>
  );
}
