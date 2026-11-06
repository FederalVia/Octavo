import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { GraphData, GraphNode } from '../api';

interface Node extends GraphNode, SimulationNodeDatum {}
interface Link extends SimulationLinkDatum<Node> {
  source: Node | string;
  target: Node | string;
}

interface Props {
  data: GraphData | null;
  currentPath: string | null;
  onOpen: (path: string, unresolvedName?: string) => void;
  /** Compact mode for the sidebar's local graph. */
  compact?: boolean;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Keep only nodes within `depth` hops of `center`. */
function localSubgraph(data: GraphData, center: string, depth: number): GraphData {
  const adj = new Map<string, Set<string>>();
  for (const l of data.links) {
    if (!adj.has(l.source)) adj.set(l.source, new Set());
    if (!adj.has(l.target)) adj.set(l.target, new Set());
    adj.get(l.source)!.add(l.target);
    adj.get(l.target)!.add(l.source);
  }
  const keep = new Set([center]);
  let frontier = [center];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) for (const n of adj.get(id) ?? []) if (!keep.has(n)) keep.add(n), next.push(n);
    frontier = next;
  }
  return {
    nodes: data.nodes.filter((n) => keep.has(n.id)),
    links: data.links.filter((l) => keep.has(l.source) && keep.has(l.target)),
  };
}

export function GraphView({ data, currentPath, onOpen, compact }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState(!!compact);
  const [depth, setDepth] = useState(compact ? 1 : 2);
  const [showUnresolved, setShowUnresolved] = useState(true);
  const [showOrphans, setShowOrphans] = useState(true);
  const [filter, setFilter] = useState('');

  const view = useMemo(() => {
    if (!data) return null;
    let g = data;
    if (!showUnresolved) {
      const ok = new Set(g.nodes.filter((n) => !n.unresolved).map((n) => n.id));
      g = { nodes: g.nodes.filter((n) => ok.has(n.id)), links: g.links.filter((l) => ok.has(l.source) && ok.has(l.target)) };
    }
    if (local && currentPath) g = localSubgraph(g, currentPath, depth);
    if (!showOrphans && !local) {
      const linked = new Set(g.links.flatMap((l) => [l.source, l.target]));
      g = { nodes: g.nodes.filter((n) => linked.has(n.id)), links: g.links };
    }
    return g;
  }, [data, local, depth, currentPath, showUnresolved, showOrphans]);

  // Mutable render state shared with event handlers.
  const state = useRef({
    nodes: [] as Node[],
    links: [] as Link[],
    sim: null as Simulation<Node, Link> | null,
    transform: { x: 0, y: 0, k: 1 },
    hover: null as Node | null,
    drag: null as Node | null,
    panning: null as { x: number; y: number; tx: number; ty: number } | null,
    moved: false,
    filter: '',
    current: null as string | null,
    neighbors: new Map<string, Set<string>>(),
    draw: () => {},
  });
  state.current.filter = filter.toLowerCase();
  state.current.current = currentPath;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d')!;
    const s = state.current;
    let width = 0;
    let height = 0;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      width = r.width;
      height = r.height;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      s.draw();
    };

    const radius = (n: Node) => (compact ? 3 : 4) + Math.sqrt(n.degree) * (compact ? 1.4 : 2);

    s.draw = () => {
      const colors = {
        node: cssVar('--graph-node', '#a1a1aa'),
        current: cssVar('--accent', '#a78bfa'),
        unresolved: cssVar('--graph-unresolved', '#52525b'),
        line: cssVar('--graph-line', 'rgba(161,161,170,0.25)'),
        lineHi: cssVar('--accent', '#a78bfa'),
        text: cssVar('--text', '#e4e4e7'),
        bg: cssVar('--bg', '#18181b'),
      };
      const { x, y, k } = s.transform;
      ctx.save();
      ctx.clearRect(0, 0, width, height);
      ctx.translate(width / 2 + x, height / 2 + y);
      ctx.scale(k, k);

      const focus = s.hover ?? (s.current ? s.nodes.find((n) => n.id === s.current) ?? null : null);
      const focusSet = focus ? s.neighbors.get(focus.id) ?? new Set() : null;
      const matches = (n: Node) => !s.filter || n.name.toLowerCase().includes(s.filter);

      ctx.lineWidth = 1 / k;
      for (const l of s.links) {
        const a = l.source as Node;
        const b = l.target as Node;
        if (a.x == null || b.x == null) continue;
        const hi = focus && (a === focus || b === focus);
        ctx.strokeStyle = hi ? colors.lineHi : colors.line;
        ctx.globalAlpha = s.hover && !hi ? 0.35 : 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y!);
        ctx.lineTo(b.x, b.y!);
        ctx.stroke();
      }

      for (const n of s.nodes) {
        if (n.x == null) continue;
        const dim = (s.hover && n !== s.hover && !focusSet?.has(n.id)) || !matches(n);
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.fillStyle = n.id === s.current ? colors.current : n.unresolved ? colors.unresolved : colors.node;
        if (n === s.hover) ctx.fillStyle = colors.current;
        ctx.beginPath();
        ctx.arc(n.x, n.y!, radius(n), 0, Math.PI * 2);
        ctx.fill();
      }

      // Labels: always for focus + neighbors, otherwise only when zoomed in enough.
      const fontSize = (compact ? 10 : 12) / Math.max(k, 0.6);
      ctx.font = `${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const n of s.nodes) {
        if (n.x == null) continue;
        const important = n === focus || focusSet?.has(n.id) || (s.filter && matches(n));
        if (!important && s.nodes.length > (compact ? 12 : 60) && k < (compact ? 1.6 : 1.1)) continue;
        const dim = (s.hover && n !== s.hover && !focusSet?.has(n.id)) || !matches(n);
        ctx.globalAlpha = dim ? 0.3 : 1;
        ctx.fillStyle = colors.text;
        ctx.fillText(n.name, n.x, n.y! + radius(n) + 2);
      }
      ctx.restore();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const toWorld = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      const { x, y, k } = s.transform;
      return { x: (e.clientX - r.left - width / 2 - x) / k, y: (e.clientY - r.top - height / 2 - y) / k };
    };
    const hit = (e: { clientX: number; clientY: number }) => {
      const p = toWorld(e);
      let best: Node | null = null;
      let bestD = Infinity;
      for (const n of s.nodes) {
        if (n.x == null) continue;
        const d = Math.hypot(n.x - p.x, n.y! - p.y);
        if (d < radius(n) + 4 / s.transform.k && d < bestD) (best = n), (bestD = d);
      }
      return best;
    };

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      s.moved = false;
      const n = hit(e);
      if (n) {
        s.drag = n;
        n.fx = n.x;
        n.fy = n.y;
        s.sim?.alphaTarget(0.3).restart();
      } else {
        s.panning = { x: e.clientX, y: e.clientY, tx: s.transform.x, ty: s.transform.y };
      }
    };
    const onMove = (e: PointerEvent) => {
      if (s.drag) {
        const p = toWorld(e);
        s.drag.fx = p.x;
        s.drag.fy = p.y;
        s.moved = true;
      } else if (s.panning) {
        s.transform.x = s.panning.tx + e.clientX - s.panning.x;
        s.transform.y = s.panning.ty + e.clientY - s.panning.y;
        if (Math.abs(e.clientX - s.panning.x) + Math.abs(e.clientY - s.panning.y) > 3) s.moved = true;
        s.draw();
      } else {
        const n = hit(e);
        if (n !== s.hover) {
          s.hover = n;
          canvas.style.cursor = n ? 'pointer' : 'grab';
          s.draw();
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      const clicked = !s.moved ? hit(e) : null;
      if (s.drag) {
        s.drag.fx = null;
        s.drag.fy = null;
        s.sim?.alphaTarget(0);
        s.drag = null;
      }
      s.panning = null;
      if (clicked) onOpenRef.current(clicked.unresolved ? '' : clicked.id, clicked.unresolved ? clicked.name : undefined);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left - width / 2;
      const my = e.clientY - r.top - height / 2;
      const { x, y, k } = s.transform;
      const nk = Math.min(8, Math.max(0.1, k * Math.exp(-e.deltaY * 0.0015)));
      s.transform = { k: nk, x: mx - ((mx - x) * nk) / k, y: my - ((my - y) * nk) / k };
      s.draw();
    };
    const onLeave = () => {
      if (s.hover) {
        s.hover = null;
        s.draw();
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const redraw = () => s.draw();
    mq.addEventListener('change', redraw);
    return () => {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      mq.removeEventListener('change', redraw);
      s.sim?.stop();
    };
  }, [compact]);

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  // (Re)build the simulation when the visible graph changes, keeping positions.
  useEffect(() => {
    const s = state.current;
    if (!view) return;
    const old = new Map(s.nodes.map((n) => [n.id, n]));
    const nodes: Node[] = view.nodes.map((n) => {
      const prev = old.get(n.id);
      return prev ? Object.assign(prev, n) : { ...n };
    });
    const ids = new Set(nodes.map((n) => n.id));
    const links: Link[] = view.links.filter((l) => ids.has(l.source) && ids.has(l.target)).map((l) => ({ ...l }));
    s.neighbors = new Map();
    for (const l of view.links) {
      if (!s.neighbors.has(l.source)) s.neighbors.set(l.source, new Set());
      if (!s.neighbors.has(l.target)) s.neighbors.set(l.target, new Set());
      s.neighbors.get(l.source)!.add(l.target);
      s.neighbors.get(l.target)!.add(l.source);
    }
    s.nodes = nodes;
    s.links = links;
    s.sim?.stop();
    const sim = forceSimulation<Node, Link>(nodes)
      .force('link', forceLink<Node, Link>(links).id((d) => d.id).distance(compact ? 40 : 80).strength(0.6))
      .force('charge', forceManyBody().strength(compact ? -80 : -140))
      .force('center', forceCenter(0, 0))
      .force('x', forceX(0).strength(0.04))
      .force('y', forceY(0).strength(0.04))
      .force('collide', forceCollide<Node>().radius((d) => 6 + Math.sqrt(d.degree) * 2))
      .alpha(old.size ? 0.4 : 1)
      .on('tick', () => s.draw());
    s.sim = sim;
    return () => {
      sim.stop();
    };
  }, [view, compact]);

  useEffect(() => {
    state.current.draw();
  }, [filter, currentPath]);

  const nodeCount = view?.nodes.length ?? 0;

  return (
    <div className={`graph${compact ? ' compact' : ''}`}>
      {!compact && (
        <div className="graph-controls">
          <input
            className="input"
            placeholder="Highlight notes…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label>
            <input type="checkbox" checked={local} disabled={!currentPath} onChange={(e) => setLocal(e.target.checked)} />
            Local graph
          </label>
          {local && (
            <label>
              Depth
              <input type="range" min={1} max={4} value={depth} onChange={(e) => setDepth(Number(e.target.value))} />
              {depth}
            </label>
          )}
          <label>
            <input type="checkbox" checked={showUnresolved} onChange={(e) => setShowUnresolved(e.target.checked)} />
            Unresolved
          </label>
          {!local && (
            <label>
              <input type="checkbox" checked={showOrphans} onChange={(e) => setShowOrphans(e.target.checked)} />
              Orphans
            </label>
          )}
          <span className="muted">{nodeCount} notes</span>
        </div>
      )}
      <div className="graph-canvas" ref={wrapRef}>
        <canvas ref={canvasRef} />
        {nodeCount === 0 && <div className="graph-empty muted">Nothing to show yet</div>}
      </div>
    </div>
  );
}
