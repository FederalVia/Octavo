import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type NoteSummary } from '../api';
import { createRenderer, fileUrl } from '../markdown';

// ---------------------------------------------------------------------------------- data model
// The open JSON Canvas format (jsoncanvas.org).

type Side = 'top' | 'right' | 'bottom' | 'left';
interface Base {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  [k: string]: unknown;
}
type CNode = (Base & { type: 'text'; text: string }) | (Base & { type: 'file'; file: string; subpath?: string }) | (Base & { type: 'link'; url: string }) | (Base & { type: 'group'; label?: string });
interface CEdge {
  id: string;
  fromNode: string;
  fromSide?: Side;
  fromEnd?: 'none' | 'arrow';
  toNode: string;
  toSide?: Side;
  toEnd?: 'none' | 'arrow';
  color?: string;
  label?: string;
  [k: string]: unknown;
}
interface Data {
  nodes: CNode[];
  edges: CEdge[];
  [k: string]: unknown;
}

/** Preset colours "1"–"6", in Octavo's palette. */
const PRESETS: Record<string, string> = { '1': '#ff5c8a', '2': '#ff9b3d', '3': '#d8ef4f', '4': '#4fd18b', '5': '#2fd9c6', '6': '#b79bff' };
const colorOf = (c?: string) => (c ? PRESETS[c] ?? c : undefined);
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const uid = () => Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
const GRID = 20;
const snap = (v: number) => Math.round(v / GRID) * GRID;

function anchor(n: CNode, side: Side): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: n.x + n.width / 2, y: n.y };
    case 'bottom':
      return { x: n.x + n.width / 2, y: n.y + n.height };
    case 'left':
      return { x: n.x, y: n.y + n.height / 2 };
    case 'right':
      return { x: n.x + n.width, y: n.y + n.height / 2 };
  }
}

/** The sides that face each other when an edge doesn't say. */
function autoSides(a: CNode, b: CNode): [Side, Side] {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? ['right', 'left'] : ['left', 'right'];
  return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

const NORMAL: Record<Side, [number, number]> = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };

function edgePath(a: { x: number; y: number }, as: Side, b: { x: number; y: number }, bs: Side): string {
  const d = Math.max(40, Math.hypot(b.x - a.x, b.y - a.y) * 0.4);
  const [ax, ay] = NORMAL[as];
  const [bx, by] = NORMAL[bs];
  return `M${a.x},${a.y} C${a.x + ax * d},${a.y + ay * d} ${b.x + bx * d},${b.y + by * d} ${b.x},${b.y}`;
}

function nearestSide(n: CNode, p: { x: number; y: number }): Side {
  const sides: Side[] = ['top', 'right', 'bottom', 'left'];
  let best: Side = 'left';
  let dist = Infinity;
  for (const s of sides) {
    const q = anchor(n, s);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < dist) {
      dist = d;
      best = s;
    }
  }
  return best;
}

const inside = (n: CNode, g: CNode) => n.id !== g.id && n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height;

// ---------------------------------------------------------------------------------- note cards

const noteCache = new Map<string, { content: string; at: number }>();

function NoteCard({ file, render, onOpen }: { file: string; render: (md: string) => string; onOpen: (p: string) => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => {
      const cached = noteCache.get(file);
      if (cached && Date.now() - cached.at < 3000) {
        setHtml(render(cached.content));
        return;
      }
      api
        .note(file)
        .then((n) => {
          if (!live) return;
          if (n.encrypted) return setHtml('<p class="muted">🔒 Locked note</p>');
          noteCache.set(file, { content: n.content, at: Date.now() });
          setHtml(render(n.content));
          setMissing(false);
        })
        .catch(() => live && setMissing(true));
    };
    load();
    const onChange = () => {
      noteCache.delete(file);
      load();
    };
    window.addEventListener('octavo:vault-change', onChange);
    return () => {
      live = false;
      window.removeEventListener('octavo:vault-change', onChange);
    };
  }, [file, render]);
  const name = file.replace(/\.md$/i, '').split('/').pop();
  return (
    <>
      <div className="cv-card-title" onPointerDown={(e) => e.stopPropagation()} onClick={() => onOpen(file)} title="Open note">
        {name}
      </div>
      {missing ? <div className="cv-card-body muted">“{file}” doesn’t exist</div> : <div className="cv-card-body markdown" dangerouslySetInnerHTML={{ __html: html ?? '' }} />}
    </>
  );
}

// ---------------------------------------------------------------------------------- the view

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'move'; sx: number; sy: number; start: Map<string, { x: number; y: number }>; moved: boolean }
  | { kind: 'resize'; id: string; sx: number; sy: number; w: number; h: number }
  | { kind: 'connect'; from: string; side: Side; x: number; y: number; sx: number; sy: number }
  | { kind: 'marquee'; sx: number; sy: number; x: number; y: number }
  | { kind: 'pinch'; d0: number; z0: number; cx: number; cy: number; vx: number; vy: number };

export function CanvasView({
  path,
  notes,
  onClose,
  onOpenNote,
  onOpenUrl,
  pickNote,
  prompt,
}: {
  path: string;
  notes: NoteSummary[];
  onClose: () => void;
  onOpenNote: (path: string) => void;
  onOpenUrl: (url: string) => void;
  /** Ask the user to pick a note (resolves to its path, or null). */
  pickNote: () => Promise<string | null>;
  prompt: (title: string, initial?: string, opts?: { placeholder?: string; confirmLabel?: string }) => Promise<string | null>;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [status, setStatus] = useState('');
  const stage = useRef<HTMLDivElement>(null);
  const mtime = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undo = useRef<string[]>([]);
  const redo = useRef<string[]>([]);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dataRef = useRef<Data | null>(null);
  dataRef.current = data;
  const names = useMemo(() => new Set(notes.map((n) => n.name.toLowerCase())), [notes]);
  const render = useMemo(() => {
    const r = createRenderer({ exists: (t) => names.has(t.split('/').pop()!.toLowerCase()) || t.toLowerCase().endsWith('.canvas') });
    return (md: string) => r(md);
  }, [names]);
  const title = path.replace(/\.canvas$/i, '').split('/').pop();

  // ------------------------------------------------------------------ load / save
  const load = useCallback(
    async (fit: boolean) => {
      try {
        const r = await api.canvas(path);
        mtime.current = r.mtime;
        setData(r.data as Data);
        setError('');
        if (fit) requestAnimationFrame(() => fitTo(r.data as Data));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path],
  );
  useEffect(() => {
    void load(true);
  }, [load]);

  const flush = useCallback(async () => {
    if (!dirty.current || !dataRef.current) return;
    dirty.current = false;
    setStatus('Saving…');
    try {
      const r = await api.saveCanvas(path, dataRef.current, mtime.current);
      mtime.current = r.mtime;
      setStatus('Saved');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setStatus('Changed elsewhere: reloaded');
        await load(false);
      } else {
        dirty.current = true;
        setStatus(`Not saved: ${(err as Error).message}`);
      }
    }
  }, [path, load]);

  /** Change the canvas (with undo), and save shortly after. */
  const commit = useCallback(
    (next: Data | ((d: Data) => Data), opts: { history?: boolean } = {}) => {
      const cur = dataRef.current;
      if (!cur) return;
      const value = typeof next === 'function' ? next(cur) : next;
      if (opts.history !== false) {
        undo.current.push(JSON.stringify(cur));
        if (undo.current.length > 100) undo.current.shift();
        redo.current = [];
      }
      dataRef.current = value;
      setData(value);
      dirty.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), 600);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void flush();
    },
    [flush],
  );

  // Someone else (Claude, another device) changed it: reload when we have nothing unsaved.
  useEffect(() => {
    const onChange = () => {
      if (!dirty.current && !drag && !editing) void api.canvas(path).then((r) => r.mtime !== mtime.current && ((mtime.current = r.mtime), setData(r.data as Data))).catch(() => {});
    };
    window.addEventListener('octavo:vault-change', onChange);
    return () => window.removeEventListener('octavo:vault-change', onChange);
  }, [path, drag, editing]);

  // ------------------------------------------------------------------ geometry
  const toWorld = useCallback(
    (cx: number, cy: number) => {
      const r = stage.current!.getBoundingClientRect();
      return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z };
    },
    [view],
  );

  const fitTo = (d: Data | null = dataRef.current) => {
    const el = stage.current;
    if (!el || !d) return;
    const r = el.getBoundingClientRect();
    if (!d.nodes.length) return setView({ x: r.width / 2, y: r.height / 2, z: 1 });
    const minX = Math.min(...d.nodes.map((n) => n.x));
    const minY = Math.min(...d.nodes.map((n) => n.y));
    const maxX = Math.max(...d.nodes.map((n) => n.x + n.width));
    const maxY = Math.max(...d.nodes.map((n) => n.y + n.height));
    const z = Math.min(1.2, Math.max(0.1, Math.min((r.width - 80) / (maxX - minX || 1), (r.height - 120) / (maxY - minY || 1))));
    setView({ z, x: r.width / 2 - ((minX + maxX) / 2) * z, y: (r.height + 40) / 2 - ((minY + maxY) / 2) * z });
  };

  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    const r = stage.current!.getBoundingClientRect();
    const px = cx ?? r.left + r.width / 2;
    const py = cy ?? r.top + r.height / 2;
    setView((v) => {
      const z = Math.min(3, Math.max(0.08, v.z * factor));
      const wx = (px - r.left - v.x) / v.z;
      const wy = (py - r.top - v.y) / v.z;
      return { z, x: px - r.left - wx * z, y: py - r.top - wy * z };
    });
  };

  /** A spot in view for a new card. */
  const freeSpot = (w: number, h: number) => {
    const r = stage.current!.getBoundingClientRect();
    const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    const nodes = dataRef.current?.nodes ?? [];
    let x = snap(c.x - w / 2);
    let y = snap(c.y - h / 2);
    for (let i = 0; i < 40 && nodes.some((n) => n.type !== 'group' && x < n.x + n.width && x + w > n.x && y < n.y + n.height && y + h > n.y); i++) {
      x += 40;
      y += 40;
    }
    return { x, y };
  };

  const addNode = (node: { type: CNode['type']; width: number; height: number; x?: number; y?: number; [k: string]: unknown }) => {
    const spot = typeof node.x === 'number' && typeof node.y === 'number' ? { x: node.x, y: node.y } : freeSpot(node.width, node.height);
    const n = { ...node, id: uid(), x: spot.x, y: spot.y } as CNode;
    commit((d) => ({ ...d, nodes: n.type === 'group' ? [n, ...d.nodes] : [...d.nodes, n] }));
    setSel(new Set([n.id]));
    setSelEdge(null);
    return n;
  };

  // ------------------------------------------------------------------ toolbar actions
  const addText = (at?: { x: number; y: number }) => {
    const n = addNode({ type: 'text', text: '', width: 260, height: 120, ...(at ? { x: snap(at.x - 130), y: snap(at.y - 60) } : {}) });
    setEditing(n.id);
  };
  const addNote = async () => {
    const p = await pickNote();
    if (p) addNode({ type: 'file', file: p, width: 400, height: 320 });
  };
  const addLink = async () => {
    const u = await prompt('Add a web link', '', { placeholder: 'https://…', confirmLabel: 'Add' });
    if (u) addNode({ type: 'link', url: /^[a-z]+:/i.test(u) ? u : `https://${u}`, width: 360, height: 120 });
  };
  const addGroup = () => {
    const d = dataRef.current;
    const chosen = d?.nodes.filter((n) => sel.has(n.id)) ?? [];
    if (chosen.length) {
      const pad = 40;
      const minX = Math.min(...chosen.map((n) => n.x)) - pad;
      const minY = Math.min(...chosen.map((n) => n.y)) - pad;
      const maxX = Math.max(...chosen.map((n) => n.x + n.width)) + pad;
      const maxY = Math.max(...chosen.map((n) => n.y + n.height)) + pad;
      addNode({ type: 'group', label: 'Group', x: minX, y: minY, width: maxX - minX, height: maxY - minY });
    } else addNode({ type: 'group', label: 'Group', width: 600, height: 400 });
  };
  const removeSelected = () => {
    if (selEdge) {
      commit((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== selEdge) }));
      setSelEdge(null);
      return;
    }
    if (!sel.size) return;
    commit((d) => ({ ...d, nodes: d.nodes.filter((n) => !sel.has(n.id)), edges: d.edges.filter((e) => !sel.has(e.fromNode) && !sel.has(e.toNode)) }));
    setSel(new Set());
  };
  const setColor = (c: string | undefined) => {
    if (selEdge) commit((d) => ({ ...d, edges: d.edges.map((e) => (e.id === selEdge ? { ...e, color: c } : e)) }));
    else commit((d) => ({ ...d, nodes: d.nodes.map((n) => (sel.has(n.id) ? { ...n, color: c } : n)) }));
  };
  const doUndo = () => {
    const prev = undo.current.pop();
    if (!prev || !dataRef.current) return;
    redo.current.push(JSON.stringify(dataRef.current));
    commit(JSON.parse(prev), { history: false });
  };
  const doRedo = () => {
    const next = redo.current.pop();
    if (!next || !dataRef.current) return;
    undo.current.push(JSON.stringify(dataRef.current));
    commit(JSON.parse(next), { history: false });
  };

  // ------------------------------------------------------------------ pointer handling
  const nodeAt = (p: { x: number; y: number }, exclude?: string): CNode | undefined => {
    const nodes = dataRef.current?.nodes ?? [];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.id !== exclude && n.type !== 'group' && p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height) return n;
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.id !== exclude && n.type === 'group' && p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height) return n;
    }
    return undefined;
  };

  const onStageDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.current?.setPointerCapture(e.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      setDrag({ kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), z0: view.z, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, vx: view.x, vy: view.y });
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest('.cv-toolbar, .cv-node, textarea, .cv-edge-hit')) return;
    setEditing(null);
    if (e.shiftKey) {
      const p = toWorld(e.clientX, e.clientY);
      setDrag({ kind: 'marquee', sx: p.x, sy: p.y, x: p.x, y: p.y });
    } else {
      setSel(new Set());
      setSelEdge(null);
      setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
    }
  };

  const startMove = (e: React.PointerEvent, n: CNode) => {
    if (e.button !== 0 || editing === n.id) return;
    if ((e.target as HTMLElement).closest('a, button, .cv-card-title')) {
      e.stopPropagation(); // let links and buttons inside cards work
      return;
    }
    e.stopPropagation();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.current?.setPointerCapture(e.pointerId);
    let chosen = sel;
    if (e.shiftKey) {
      chosen = new Set(sel);
      if (chosen.has(n.id)) chosen.delete(n.id);
      else chosen.add(n.id);
    } else if (!sel.has(n.id)) chosen = new Set([n.id]);
    setSel(chosen);
    setSelEdge(null);
    const nodes = dataRef.current!.nodes;
    const moving = new Set(chosen);
    for (const g of nodes) if (chosen.has(g.id) && g.type === 'group') for (const c of nodes) if (inside(c, g)) moving.add(c.id);
    const start = new Map<string, { x: number; y: number }>();
    for (const m of nodes) if (moving.has(m.id)) start.set(m.id, { x: m.x, y: m.y });
    const p = toWorld(e.clientX, e.clientY);
    setDrag({ kind: 'move', sx: p.x, sy: p.y, start, moved: false });
  };

  const onStageMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) return;
    if (drag.kind === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const r = stage.current!.getBoundingClientRect();
      const z = Math.min(3, Math.max(0.08, (drag.z0 * Math.hypot(a.x - b.x, a.y - b.y)) / (drag.d0 || 1)));
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const wx = (drag.cx - r.left - drag.vx) / drag.z0;
      const wy = (drag.cy - r.top - drag.vy) / drag.z0;
      setView({ z, x: cx - r.left - wx * z, y: cy - r.top - wy * z });
      return;
    }
    if (drag.kind === 'pan') {
      setView((v) => ({ ...v, x: drag.vx + e.clientX - drag.sx, y: drag.vy + e.clientY - drag.sy }));
      return;
    }
    const p = toWorld(e.clientX, e.clientY);
    if (drag.kind === 'move') {
      const dx = p.x - drag.sx;
      const dy = p.y - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) * view.z < 3) return;
      if (!drag.moved) {
        undo.current.push(JSON.stringify(dataRef.current));
        redo.current = [];
        drag.moved = true;
      }
      const d = dataRef.current!;
      const next = { ...d, nodes: d.nodes.map((n) => (drag.start.has(n.id) ? { ...n, x: snap(drag.start.get(n.id)!.x + dx), y: snap(drag.start.get(n.id)!.y + dy) } : n)) };
      dataRef.current = next;
      setData(next);
    } else if (drag.kind === 'resize') {
      const d = dataRef.current!;
      const w = Math.max(80, snap(drag.w + p.x - drag.sx));
      const h = Math.max(40, snap(drag.h + p.y - drag.sy));
      const next = { ...d, nodes: d.nodes.map((n) => (n.id === drag.id ? { ...n, width: w, height: h } : n)) };
      dataRef.current = next;
      setData(next);
    } else if (drag.kind === 'connect' || drag.kind === 'marquee') {
      setDrag({ ...drag, x: p.x, y: p.y });
    }
  };

  const onStageUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (!drag) return;
    if (drag.kind === 'pinch' && pointers.current.size) return;
    if (drag.kind === 'move' || drag.kind === 'resize') {
      if (drag.kind === 'resize' || drag.moved) commit(dataRef.current!, { history: false });
    } else if (drag.kind === 'connect') {
      const p = toWorld(e.clientX, e.clientY);
      const target = nodeAt(p, drag.from);
      if (target) {
        const edge: CEdge = { id: uid(), fromNode: drag.from, fromSide: drag.side, toNode: target.id, toSide: nearestSide(target, p), toEnd: 'arrow' };
        commit((d) => ({ ...d, edges: [...d.edges, edge] }));
        setSelEdge(edge.id);
        setSel(new Set());
      } else if (Math.hypot(p.x - drag.sx, p.y - drag.sy) * view.z < 12) {
        /* click on handle: nothing */
      } else {
        // Dropped on empty space: make a new card there, connected.
        const n: CNode = { id: uid(), type: 'text', text: '', x: snap(p.x - 130), y: snap(p.y - 60), width: 260, height: 120 };
        const edge: CEdge = { id: uid(), fromNode: drag.from, fromSide: drag.side, toNode: n.id, toSide: nearestSide(n, anchor(dataRef.current!.nodes.find((x) => x.id === drag.from)!, drag.side)), toEnd: 'arrow' };
        commit((d) => ({ ...d, nodes: [...d.nodes, n], edges: [...d.edges, edge] }));
        setSel(new Set([n.id]));
        setEditing(n.id);
      }
    } else if (drag.kind === 'marquee') {
      const x0 = Math.min(drag.sx, drag.x);
      const y0 = Math.min(drag.sy, drag.y);
      const x1 = Math.max(drag.sx, drag.x);
      const y1 = Math.max(drag.sy, drag.y);
      setSel(new Set((dataRef.current?.nodes ?? []).filter((n) => n.x >= x0 && n.y >= y0 && n.x + n.width <= x1 && n.y + n.height <= y1).map((n) => n.id)));
    }
    setDrag(null);
  };

  const onWheel = (e: React.WheelEvent) => {
    if ((e.target as HTMLElement).closest('.cv-card-body, textarea')) {
      const body = (e.target as HTMLElement).closest('.cv-card-body') as HTMLElement | null;
      if (body && body.scrollHeight > body.clientHeight && !e.ctrlKey) return; // scroll the card
    }
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
  };

  // Ctrl+wheel must not zoom the page.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const stop = (e: WheelEvent) => (e.ctrlKey || e.metaKey) && e.preventDefault();
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, []);

  // ------------------------------------------------------------------ keyboard, paste, drop
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('textarea, input')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (sel.size || selEdge) {
        setSel(new Set());
        setSelEdge(null);
      } else onClose();
      e.preventDefault();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      removeSelected();
      e.preventDefault();
    } else if (mod && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) doRedo();
      else doUndo();
      e.preventDefault();
    } else if (mod && e.key.toLowerCase() === 'y') {
      doRedo();
      e.preventDefault();
    } else if (mod && e.key.toLowerCase() === 'a') {
      setSel(new Set((dataRef.current?.nodes ?? []).map((n) => n.id)));
      e.preventDefault();
    } else if (e.key === 'Enter' && sel.size === 1) {
      const n = dataRef.current?.nodes.find((x) => sel.has(x.id));
      if (n?.type === 'text') {
        setEditing(n.id);
        e.preventDefault();
      }
    } else if (!mod && (e.key === '+' || e.key === '=')) zoomAt(1.2);
    else if (!mod && e.key === '-') zoomAt(1 / 1.2);
    else if (e.shiftKey && e.key === '!') fitTo();
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    if ((e.target as HTMLElement).closest('textarea, input')) return;
    const files = [...(e.clipboardData?.files ?? [])];
    e.preventDefault();
    if (files.length) {
      for (const f of files) {
        try {
          const r = await api.upload(f);
          addNode({ type: 'file', file: r.path, width: 360, height: 260 });
        } catch (err) {
          setStatus(`Couldn’t add the file: ${(err as Error).message}`);
        }
      }
      return;
    }
    const text = e.clipboardData.getData('text/plain').trim();
    if (!text) return;
    if (/^https?:\/\/\S+$/.test(text)) addNode({ type: 'link', url: text, width: 360, height: 120 });
    else addNode({ type: 'text', text, width: 300, height: Math.min(400, 60 + text.split('\n').length * 24) });
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const p = toWorld(e.clientX, e.clientY);
    const note = e.dataTransfer.getData('application/x-octavo-note');
    if (note) return void addNode({ type: 'file', file: note, x: snap(p.x - 200), y: snap(p.y - 160), width: 400, height: 320 });
    for (const f of [...e.dataTransfer.files]) {
      try {
        const r = await api.upload(f);
        addNode({ type: 'file', file: r.path, x: snap(p.x - 180), y: snap(p.y - 130), width: 360, height: 260 });
      } catch (err) {
        setStatus(`Couldn’t add the file: ${(err as Error).message}`);
      }
    }
  };

  // ------------------------------------------------------------------ rendering
  if (error) {
    return (
      <div className="canvas-view">
        <div className="cv-toolbar">
          <button onClick={onClose}>← Back</button>
          <span className="cv-title">{title}</span>
        </div>
        <div className="cv-empty">{error}</div>
      </div>
    );
  }

  // The dot grid thins out when zoomed far out, so it never turns into a grey blur.
  let gridPx = GRID * view.z;
  while (gridPx < 12) gridPx *= 5;
  const nodes = data?.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const groups = nodes.filter((n) => n.type === 'group');
  const cards = nodes.filter((n) => n.type !== 'group');
  const selected = nodes.filter((n) => sel.has(n.id));

  const nodeBox = (n: CNode, body: React.ReactNode, extraClass = '') => {
    const c = colorOf(n.color);
    const isSel = sel.has(n.id);
    return (
      <div
        key={n.id}
        className={`cv-node cv-${n.type}${isSel ? ' selected' : ''}${extraClass}`}
        style={{ left: n.x, top: n.y, width: n.width, height: n.height, ...(c ? ({ '--cv-color': c } as React.CSSProperties) : {}) }}
        onPointerDown={(e) => startMove(e, n)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (n.type === 'text') setEditing(n.id);
          else if (n.type === 'group') {
            void prompt('Group name', n.label ?? '', { confirmLabel: 'Rename' }).then((label) => label !== null && commit((d) => ({ ...d, nodes: d.nodes.map((x) => (x.id === n.id ? { ...x, label } : x)) })));
          }
        }}
      >
        {body}
        {isSel && sel.size === 1 && (
          <>
            {(['top', 'right', 'bottom', 'left'] as Side[]).map((s) => (
              <span
                key={s}
                className={`cv-handle cv-handle-${s}`}
                title="Drag to connect"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  stage.current?.setPointerCapture(e.pointerId);
                  const a = anchor(n, s);
                  setDrag({ kind: 'connect', from: n.id, side: s, x: a.x, y: a.y, sx: a.x, sy: a.y });
                }}
              />
            ))}
            <span
              className="cv-resize"
              title="Drag to resize"
              onPointerDown={(e) => {
                e.stopPropagation();
                stage.current?.setPointerCapture(e.pointerId);
                undo.current.push(JSON.stringify(dataRef.current));
                redo.current = [];
                const p = toWorld(e.clientX, e.clientY);
                setDrag({ kind: 'resize', id: n.id, sx: p.x, sy: p.y, w: n.width, h: n.height });
              }}
            />
          </>
        )}
      </div>
    );
  };

  const renderCard = (n: CNode) => {
    if (n.type === 'text') {
      if (editing === n.id) {
        return nodeBox(
          n,
          <textarea
            className="cv-edit"
            autoFocus
            defaultValue={n.text}
            placeholder="Write… Markdown and [[links]] work"
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
            onBlur={(e) => {
              const text = e.target.value;
              setEditing(null);
              if (text !== n.text) commit((d) => ({ ...d, nodes: d.nodes.map((x) => (x.id === n.id ? { ...x, text } : x)) }));
              else if (!text.trim()) commit((d) => ({ ...d, nodes: d.nodes.filter((x) => x.id !== n.id), edges: d.edges.filter((ed) => ed.fromNode !== n.id && ed.toNode !== n.id) }), { history: false });
              stage.current?.focus();
            }}
          />,
          ' editing',
        );
      }
      return nodeBox(
        n,
        <div
          className="cv-card-body markdown"
          onClick={(e) => {
            const a = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null;
            if (!a) return;
            e.preventDefault();
            if (a.classList.contains('wikilink')) {
              const t = a.dataset.target ?? '';
              void api.resolve(t).then((r) => r.path && onOpenNote(r.path));
            } else if (/^https?:/.test(a.href)) onOpenUrl(a.href);
          }}
          dangerouslySetInnerHTML={{ __html: n.text.trim() ? render(n.text) : '<p class="muted">Double-click to write</p>' }}
        />,
      );
    }
    if (n.type === 'file') {
      if (IMAGE.test(n.file)) return nodeBox(n, <img className="cv-image" src={fileUrl(n.file)} alt={n.file.split('/').pop()} draggable={false} />);
      if (/\.md$/i.test(n.file) || !/\.[a-z0-9]+$/i.test(n.file)) return nodeBox(n, <NoteCard file={n.file} render={render} onOpen={onOpenNote} />);
      return nodeBox(
        n,
        <div className="cv-card-body">
          <a href={fileUrl(n.file)} target="_blank" rel="noopener noreferrer" onPointerDown={(e) => e.stopPropagation()}>
            {n.file.split('/').pop()}
          </a>
        </div>,
      );
    }
    if (n.type === 'link') {
      let host = n.url;
      try {
        host = new URL(n.url).hostname;
      } catch {
        /* keep */
      }
      return nodeBox(
        n,
        <div className="cv-card-body cv-link-card">
          <div className="cv-link-host">{host}</div>
          <button className="link" onPointerDown={(e) => e.stopPropagation()} onClick={() => onOpenUrl(n.url)}>
            {n.url}
          </button>
        </div>,
      );
    }
    return null;
  };

  const edgeEls = (data?.edges ?? []).map((ed) => {
    const a = byId.get(ed.fromNode);
    const b = byId.get(ed.toNode);
    if (!a || !b) return null;
    const [as, bs] = autoSides(a, b);
    const fs = ed.fromSide ?? as;
    const ts = ed.toSide ?? bs;
    const p1 = anchor(a, fs);
    const p2 = anchor(b, ts);
    const d = edgePath(p1, fs, p2, ts);
    const c = colorOf(ed.color) ?? 'var(--cv-edge)';
    const isSel = selEdge === ed.id;
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    return (
      <g key={ed.id} className={isSel ? 'selected' : ''}>
        <path d={d} className="cv-edge" style={{ stroke: c }} markerEnd={(ed.toEnd ?? 'arrow') === 'arrow' ? `url(#cv-arrow-${ed.color ?? 'x'})` : undefined} markerStart={ed.fromEnd === 'arrow' ? `url(#cv-arrow-${ed.color ?? 'x'})` : undefined} />
        <path
          d={d}
          className="cv-edge-hit"
          onPointerDown={(e) => {
            e.stopPropagation();
            setSelEdge(ed.id);
            setSel(new Set());
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            void prompt('Label for this arrow', ed.label ?? '', { confirmLabel: 'Save' }).then((label) => label !== null && commit((dd) => ({ ...dd, edges: dd.edges.map((x) => (x.id === ed.id ? { ...x, label: label || undefined } : x)) })));
          }}
        />
        {ed.label && (
          <foreignObject x={mid.x - 100} y={mid.y - 14} width={200} height={28} style={{ overflow: 'visible', pointerEvents: 'none' }}>
            <div className="cv-edge-label">{ed.label}</div>
          </foreignObject>
        )}
      </g>
    );
  });

  const colors = [...new Set((data?.edges ?? []).map((e) => e.color ?? 'x'))];
  let tempEdge: React.ReactNode = null;
  if (drag?.kind === 'connect') {
    const a = byId.get(drag.from);
    if (a) {
      const p1 = anchor(a, drag.side);
      const target = nodeAt({ x: drag.x, y: drag.y }, drag.from);
      const ts = target ? nearestSide(target, { x: drag.x, y: drag.y }) : (({ top: 'bottom', bottom: 'top', left: 'right', right: 'left' }) as const)[drag.side];
      const p2 = target ? anchor(target, ts) : { x: drag.x, y: drag.y };
      tempEdge = <path d={edgePath(p1, drag.side, p2, ts)} className="cv-edge temp" markerEnd="url(#cv-arrow-x)" />;
    }
  }

  return (
    <div className="canvas-view" role="application" aria-label={`Canvas ${title}`} onKeyDown={onKeyDown}>
      <div
        ref={stage}
        className={`cv-stage${drag?.kind === 'pan' ? ' panning' : ''}${drag ? ' dragging' : ''}`}
        tabIndex={0}
        onPointerDown={onStageDown}
        onPointerMove={onStageMove}
        onPointerUp={onStageUp}
        onPointerCancel={onStageUp}
        onWheel={onWheel}
        onPaste={onPaste}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('.cv-node, .cv-toolbar, .cv-edge-hit')) return;
          addText(toWorld(e.clientX, e.clientY));
        }}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${gridPx}px ${gridPx}px` }}
      >
        <div className="cv-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          {groups.map((g) =>
            nodeBox(
              g,
              <div className="cv-group-label" title="Double-click to rename">
                {(g as Extract<CNode, { type: 'group' }>).label || 'Group'}
              </div>,
            ),
          )}
          <svg className="cv-edges" width="1" height="1">
            <defs>
              {[...colors, 'x'].map((c) => (
                <marker key={c} id={`cv-arrow-${c}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" style={{ fill: colorOf(c === 'x' ? undefined : c) ?? 'var(--cv-edge)' }} />
                </marker>
              ))}
            </defs>
            {edgeEls}
            {tempEdge}
          </svg>
          {cards.map(renderCard)}
          {drag?.kind === 'marquee' && (
            <div className="cv-marquee" style={{ left: Math.min(drag.sx, drag.x), top: Math.min(drag.sy, drag.y), width: Math.abs(drag.x - drag.sx), height: Math.abs(drag.y - drag.sy) }} />
          )}
        </div>
        {data && !nodes.length && (
          <div className="cv-empty">
            <p>An empty canvas.</p>
            <p className="muted small">Double-click anywhere to write a card, add notes with <b>Note</b>, paste images or links, and drag from a card’s edge dots to connect it.</p>
          </div>
        )}
      </div>

      <div className="cv-toolbar" onPointerDown={(e) => e.stopPropagation()} onClick={() => requestAnimationFrame(() => !document.querySelector('.overlay') && !editing && stage.current?.focus())}>
        <button onClick={onClose} title="Back to your notes (Esc)">
          ←
        </button>
        <span className="cv-title" title={path}>
          {title}
        </span>
        <span className="cv-sep" />
        <button onClick={() => addText()} title="Add a text card (or double-click the canvas)">
          + Text
        </button>
        <button onClick={addNote} title="Add a note">
          + Note
        </button>
        <button onClick={addLink} title="Add a web link">
          + Link
        </button>
        <button onClick={addGroup} title="Group the selected cards (or add an empty group)">
          + Group
        </button>
        {(selected.length > 0 || selEdge) && (
          <>
            <span className="cv-sep" />
            <span className="cv-swatches" role="group" aria-label="Colour">
              <button className="cv-swatch none" title="No colour" onClick={() => setColor(undefined)} />
              {Object.entries(PRESETS).map(([k, v]) => (
                <button key={k} className="cv-swatch" style={{ background: v }} title={`Colour ${k}`} onClick={() => setColor(k)} />
              ))}
            </span>
            <button onClick={removeSelected} title="Delete (Del)">
              Delete
            </button>
          </>
        )}
        <span className="cv-spacer" />
        <button onClick={doUndo} title="Undo (Ctrl/Cmd+Z)" aria-label="Undo">
          ↶
        </button>
        <button onClick={doRedo} title="Redo (Ctrl/Cmd+Shift+Z)" aria-label="Redo">
          ↷
        </button>
        <button onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom out">
          −
        </button>
        <button className="cv-zoom" onClick={() => fitTo()} title="Fit everything (Shift+1)">
          {Math.round(view.z * 100)}%
        </button>
        <button onClick={() => zoomAt(1.2)} aria-label="Zoom in">
          +
        </button>
        {status && <span className="cv-status">{status}</span>}
      </div>
    </div>
  );
}
