import { useEffect, useMemo, useRef, useState } from 'react';
import { splitFrontmatter } from '../markdown';
import { Preview } from './Preview';

/** Split a note into slides at lines that are just "---" (outside code blocks and frontmatter). */
export function splitSlides(content: string): string[] {
  const body = splitFrontmatter(content).body;
  const slides: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) fence = fence ? (line.trim().startsWith(fence) ? null : fence) : f[1];
    if (!fence && /^\s*---\s*$/.test(line)) {
      slides.push(cur.join('\n'));
      cur = [];
    } else cur.push(line);
  }
  slides.push(cur.join('\n'));
  return slides.filter((s) => s.trim());
}

/** Full-screen slides: → / Space / click for next, ← for back, Esc to leave. */
export function Presentation({
  content,
  path,
  exists,
  namesKey,
  onClose,
}: {
  content: string;
  path: string;
  exists: (t: string) => boolean;
  namesKey: string;
  onClose: () => void;
}) {
  const slides = useMemo(() => splitSlides(content), [content]);
  const [i, setI] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.requestFullscreen?.().catch(() => {});
    const onFs = () => !document.fullscreenElement && onClose();
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) setI((x) => Math.min(slides.length - 1, x + 1));
      else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) setI((x) => Math.max(0, x - 1));
      else if (e.key === 'Home') setI(0);
      else if (e.key === 'End') setI(slides.length - 1);
      else if (e.key === 'Escape') onClose();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [slides.length, onClose]);
  return (
    <div
      className="presentation"
      ref={root}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a, button')) return;
        const left = e.clientX < window.innerWidth / 3;
        setI((x) => (left ? Math.max(0, x - 1) : Math.min(slides.length - 1, x + 1)));
      }}
    >
      <div className="slide" key={i}>
        <Preview content={slides[i] ?? ''} path={path} exists={exists} namesKey={namesKey} onOpenLink={() => {}} onTag={() => {}} />
      </div>
      <div className="slide-bar">
        <span>
          {i + 1} / {slides.length}
        </span>
        <button className="icon-btn" title="Exit (Esc)" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  );
}
