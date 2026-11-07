/**
 * Quick sketch: a small drawing pad that opens from the editor's `/sketch` command. Strokes are
 * drawn on a plain <canvas> (no Excalidraw bundle needed) and saved as a real `.excalidraw` file of
 * `freedraw` elements, so the sketch can be opened and edited later in the full drawing editor.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../api';

type Point = [number, number];
interface Stroke {
  color: string;
  /** Excalidraw stroke width (1, 2 or 4). */
  width: number;
  points: Point[];
  /** Real pen pressure (0..1) per point; empty when pressure is simulated (mouse, finger). */
  pressures: number[];
}

/** Colours as stored in the drawing (light-theme values; Excalidraw inverts them in dark mode). */
const COLORS: { value: string; name: string }[] = [
  { value: '#1e1e1e', name: 'Ink' },
  { value: '#e03131', name: 'Red' },
  { value: '#f08c00', name: 'Orange' },
  { value: '#2f9e44', name: 'Green' },
  { value: '#1971c2', name: 'Blue' },
  { value: '#9c36b5', name: 'Violet' },
];
const WIDTHS: { value: number; name: string }[] = [
  { value: 1, name: 'Thin' },
  { value: 2, name: 'Medium' },
  { value: 4, name: 'Bold' },
];
/** Excalidraw's dark-mode filter: the pad shows strokes exactly as the drawing will look. */
const DARK_FILTER = 'invert(93%) hue-rotate(180deg)';

/** On-screen line width for an Excalidraw stroke width (approximates its perfect-freehand outline). */
const lineWidth = (w: number, pressure?: number) =>
  pressure === undefined ? w * 4.25 : 2 * w * 4.25 * Math.sin(((0.5 - 0.6 * (0.5 - pressure)) * Math.PI) / 2);

const isDark = () => document.documentElement.dataset.theme !== 'light';
const pad2 = (n: number) => String(n).padStart(2, '0');
const rand = () => Math.floor(Math.random() * 2 ** 31);
const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const randomId = () => Array.from({ length: 20 }, () => ID_CHARS[Math.floor(Math.random() * 62)]).join('');
/** Fractional index keys in order ("a0".."az", then "b00"...), as Excalidraw 0.18 expects. */
const fractionalIndex = (i: number) => (i < 62 ? `a${ID_CHARS[i]}` : `b${ID_CHARS[Math.floor(i / 62) % 62]}${ID_CHARS[i % 62]}`);

/** Build an Excalidraw scene of freedraw elements from the pad's strokes. */
export function sketchToScene(strokes: Stroke[]) {
  const now = Date.now();
  const elements = strokes.map((s, i) => {
    const xs = s.points.map((p) => p[0]);
    const ys = s.points.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const points: Point[] = s.points.map(([px, py]) => [round(px - x), round(py - y)]);
    const pressures = s.pressures.slice();
    if (points.length === 1) {
      // A tap: give it a second point so it renders as a dot.
      points.push([0.0001, 0.0001]);
      if (pressures.length) pressures.push(pressures[0]);
    }
    return {
      id: randomId(),
      type: 'freedraw',
      x: round(x),
      y: round(y),
      width: round(Math.max(...xs) - x),
      height: round(Math.max(...ys) - y),
      angle: 0,
      strokeColor: s.color,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: s.width,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: fractionalIndex(i),
      roundness: null,
      seed: rand(),
      version: points.length + 1,
      versionNonce: rand(),
      isDeleted: false,
      boundElements: null,
      updated: now,
      link: null,
      locked: false,
      points,
      pressures,
      simulatePressure: pressures.length === 0,
      lastCommittedPoint: points[points.length - 1],
    };
  });
  return {
    type: 'excalidraw',
    version: 2,
    source: typeof location !== 'undefined' ? location.origin : 'octavo',
    elements,
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {},
  };
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

/** Distance from point p to segment ab. */
function segDist(p: Point, a: Point, b: Point) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function hits(s: Stroke, p: Point, radius: number) {
  const r = radius + lineWidth(s.width) / 2;
  if (s.points.length === 1) return Math.hypot(p[0] - s.points[0][0], p[1] - s.points[0][1]) <= r;
  for (let i = 1; i < s.points.length; i++) if (segDist(p, s.points[i - 1], s.points[i]) <= r) return true;
  return false;
}

/** Draw a stroke as a smooth curve through the midpoints of its samples. */
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  const pts = s.points;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], lineWidth(s.width, s.pressures[0]) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (!s.pressures.length) {
    ctx.lineWidth = lineWidth(s.width);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    ctx.stroke();
    return;
  }
  // Pen pressure: draw each smoothed piece with its own width.
  let prev: Point = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const end: Point = i < pts.length - 1 ? [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2] : pts[i];
    ctx.lineWidth = lineWidth(s.width, s.pressures[i] ?? s.pressures[s.pressures.length - 1]);
    ctx.beginPath();
    ctx.moveTo(prev[0], prev[1]);
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], end[0], end[1]);
    ctx.stroke();
    prev = end;
  }
}

export interface QuickSketchProps {
  /** Viewport rectangle of the cursor the panel opens next to. */
  anchor: { left: number; top: number; bottom: number };
  /** Called with the saved drawing's vault path. */
  onInsert: (path: string) => void;
  onCancel: () => void;
}

export default function QuickSketch({ anchor, onInsert, onCancel }: QuickSketchProps) {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [past, setPast] = useState<Stroke[][]>([]);
  const [color, setColor] = useState(COLORS[0].value);
  const [width, setWidth] = useState(2);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dark] = useState(isDark);
  const [sheet, setSheet] = useState(() => window.innerWidth < 600);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef<Stroke | null>(null);
  const pointer = useRef<number | null>(null);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const frame = useRef(0);

  const redraw = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokesRef.current) drawStroke(ctx, s);
    if (live.current) drawStroke(ctx, live.current);
  }, []);
  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(() => ((frame.current = 0), redraw()));
  }, [redraw]);

  useEffect(redraw, [strokes, redraw]);

  // Size the canvas to its box (device pixels), redrawing on resize.
  useLayoutEffect(() => {
    const c = canvas.current!;
    const fit = () => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      redraw();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    return () => ro.disconnect();
  }, [redraw]);

  // Place the panel below the cursor (above it when there's no room), inside the viewport.
  useLayoutEffect(() => {
    const place = () => {
      const narrow = window.innerWidth < 600;
      setSheet(narrow);
      if (narrow) return setPos(null);
      const el = panel.current!;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.max(12, Math.min(anchor.left - 24, vw - w - 12));
      let top = anchor.bottom + 8;
      if (top + h > vh - 12) top = anchor.top - h - 8;
      setPos({ left, top: Math.max(12, Math.min(top, vh - h - 12)) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);

  const commit = (next: Stroke[]) => {
    setPast((p) => [...p.slice(-99), strokesRef.current]);
    setStrokes(next);
  };
  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p;
      setStrokes(p[p.length - 1]);
      return p.slice(0, -1);
    });
  }, []);

  const insert = async () => {
    if (!strokesRef.current.length || saving) return;
    setSaving(true);
    setError('');
    const d = new Date();
    const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    const scene = sketchToScene(strokesRef.current);
    try {
      for (let n = 1; ; n++) {
        const path = `attachments/Sketch ${stamp}${n > 1 ? ` ${n}` : ''}.excalidraw`;
        try {
          const r = await api.saveDrawing(path, scene, undefined, true);
          onInsert(r.path);
          return;
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 409) || n >= 20) throw err;
        }
      }
    } catch (err) {
      setError(`Couldn’t save the sketch: ${(err as Error).message}`);
      setSaving(false);
    }
  };
  const insertRef = useRef(insert);
  insertRef.current = insert;

  // Keys while open: Esc cancels (without closing the note behind it), Ctrl/Cmd+Z undoes,
  // Ctrl/Cmd+Enter inserts. Captured on window so nothing else acts on them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') onCancel();
      else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) undo();
      else if (mod && e.key === 'Enter') void insertRef.current();
      else if (mod) return; // leave other shortcuts alone
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel, undo]);

  const at = (e: React.PointerEvent | PointerEvent): Point => {
    const r = canvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const realPressure = (e: PointerEvent | React.PointerEvent) => e.pointerType === 'pen' && e.pressure > 0 && e.pressure !== 0.5;

  const erase = (p: Point) => {
    const keep = strokesRef.current.filter((s) => !hits(s, p, 6));
    if (keep.length !== strokesRef.current.length) {
      strokesRef.current = keep;
      setStrokes(keep);
    }
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    pointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e);
    if (tool === 'eraser') {
      setPast((h) => [...h.slice(-99), strokesRef.current]);
      erase(p);
      return;
    }
    const pressure = realPressure(e);
    live.current = { color, width, points: [p], pressures: pressure ? [e.pressure] : [] };
    schedule();
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== e.pointerId) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const p = at(ev);
      if (tool === 'eraser') {
        erase(p);
        continue;
      }
      const s = live.current;
      if (!s) continue;
      const last = s.points[s.points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1) continue;
      s.points.push(p);
      if (s.pressures.length) s.pressures.push(ev.pressure || 0.5);
    }
    schedule();
  };
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null;
    const s = live.current;
    live.current = null;
    if (s && e.type !== 'pointercancel') commit([...strokesRef.current, s]);
    else schedule();
  };

  const style: React.CSSProperties = sheet ? {} : pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 };

  return createPortal(
    <>
      <div className="qs-backdrop" onPointerDown={() => !strokesRef.current.length && onCancel()} />
      <div
        ref={panel}
        className={`quick-sketch${sheet ? ' sheet' : ''}`}
        style={style}
        role="dialog"
        aria-label="Quick sketch"
        tabIndex={-1}
      >
        <div className="qs-tools" role="toolbar" aria-label="Sketch tools">
          <div className="qs-group">
            {COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`qs-swatch${tool === 'pen' && color === c.value ? ' on' : ''}`}
                title={c.value === COLORS[0].value ? (dark ? 'White' : 'Black') : c.name}
                aria-label={c.value === COLORS[0].value ? (dark ? 'White' : 'Black') : c.name}
                aria-pressed={tool === 'pen' && color === c.value}
                onClick={() => (setColor(c.value), setTool('pen'))}
              >
                <span style={{ background: c.value, filter: dark ? DARK_FILTER : undefined }} />
              </button>
            ))}
          </div>
          <div className="qs-group">
            {WIDTHS.map((w) => (
              <button
                key={w.value}
                type="button"
                className={`qs-tool${width === w.value && tool === 'pen' ? ' on' : ''}`}
                title={w.name}
                aria-label={`${w.name} pen`}
                aria-pressed={width === w.value && tool === 'pen'}
                onClick={() => (setWidth(w.value), setTool('pen'))}
              >
                <span className="qs-dot" style={{ width: 3 + w.value * 2.5, height: 3 + w.value * 2.5 }} />
              </button>
            ))}
            <button
              type="button"
              className={`qs-tool${tool === 'eraser' ? ' on' : ''}`}
              title="Eraser: wipe over a stroke to remove it"
              aria-label="Eraser"
              aria-pressed={tool === 'eraser'}
              onClick={() => setTool('eraser')}
            >
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 15.5 13.5 6a2 2 0 0 1 2.8 0l3.7 3.7a2 2 0 0 1 0 2.8L13 19.5H8L4 15.5Z" />
                <path d="M9.5 10 15 15.5M8 19.5h12" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="qs-group">
            <button type="button" className="qs-tool" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!past.length} onClick={undo}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 14 4 9l5-5" />
                <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
              </svg>
            </button>
            <button type="button" className="qs-tool qs-text" title="Clear the pad" disabled={!strokes.length} onClick={() => commit([])}>
              Clear
            </button>
          </div>
        </div>
        <div className="qs-pad">
          <canvas
            ref={canvas}
            className={tool === 'eraser' ? 'erasing' : undefined}
            style={{ filter: dark ? DARK_FILTER : undefined }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onLostPointerCapture={onUp}
            aria-label="Drawing pad"
          />
          {!strokes.length && <div className="qs-hint">Draw here with a finger, mouse or pen</div>}
        </div>
        <div className="qs-actions">
          {error ? <span className="qs-error">{error}</span> : <span className="qs-note muted">Saved as a drawing you can edit later</span>}
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!strokes.length || saving} onClick={() => void insert()}>
            {saving ? 'Saving…' : 'Insert'}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
