import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  forceRadial,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { GraphData, GraphNode } from '../api';

/** Imperative controls the app uses to make the brain react to events. */
export interface BrainHandle {
  /** Light up a node and send signals along its connections (e.g. when Claude edits it). */
  fire(id: string): void;
  /** Fly the camera to a node. */
  focus(id: string): void;
}

interface Node extends GraphNode, SimulationNodeDatum {
  hue: number;
  phase: number;
  born: number;
  firedAt: number;
}
interface Link extends SimulationLinkDatum<Node> {
  source: Node;
  target: Node;
  /** Curve bend, so parallel-ish links don't overlap. */
  bend: number;
}
interface Pulse {
  link: Link;
  /** 0..1 progress along the link. */
  t: number;
  speed: number;
  forward: boolean;
  strong: boolean;
}
interface Ripple {
  node: Node;
  start: number;
}

interface Props {
  data: GraphData | null;
  selected: string | null;
  /** Fraction of the width covered by an overlay panel on the right (camera centers in the free area). */
  rightInset: number;
  onSelect: (id: string) => void;
  onSelectUnresolved: (name: string) => void;
  onBackground: () => void;
  onReady?: (handle: BrainHandle) => void;
}

// Brain-region palette: each top-level folder gets its own hue.
const PALETTE = [265, 190, 320, 150, 30, 220, 0, 95, 285, 170];
function hueFor(id: string, folders: string[]): number {
  const top = id.includes('/') ? id.slice(0, id.indexOf('/')) : '';
  if (!top) return PALETTE[0];
  const i = folders.indexOf(top);
  if (i >= 0) return PALETTE[(i + 1) % PALETTE.length];
  let h = 0;
  for (const ch of top) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Pre-rendered glow sprites, one per hue, for cheap drawing. */
const glowCache = new Map<string, HTMLCanvasElement>();
function glowSprite(hue: number, light: number): HTMLCanvasElement {
  const key = `${hue}:${light}`;
  let c = glowCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, `hsla(${hue}, 100%, ${light}%, 0.9)`);
  grad.addColorStop(0.18, `hsla(${hue}, 100%, ${light - 10}%, 0.45)`);
  grad.addColorStop(0.45, `hsla(${hue}, 100%, ${light - 20}%, 0.12)`);
  grad.addColorStop(1, `hsla(${hue}, 100%, ${light - 25}%, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowCache.set(key, c);
  return c;
}

function linkId(l: { source: string | Node; target: string | Node }) {
  const s = typeof l.source === 'string' ? l.source : l.source.id;
  const t = typeof l.target === 'string' ? l.target : l.target.id;
  return `${s}\u0000${t}`;
}

export function BrainView(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [filter, setFilter] = useState('');
  const propsRef = useRef(props);
  propsRef.current = props;

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const n of props.data?.nodes ?? []) if (!n.unresolved && n.id.includes('/')) set.add(n.id.slice(0, n.id.indexOf('/')));
    return [...set].sort();
  }, [props.data]);

  const s = useRef({
    nodes: [] as Node[],
    links: [] as Link[],
    byId: new Map<string, Node>(),
    neighbors: new Map<string, Set<string>>(),
    adjacency: new Map<string, Link[]>(),
    pulses: [] as Pulse[],
    ripples: [] as Ripple[],
    sim: null as Simulation<Node, Link> | null,
    cam: { x: 0, y: 0, k: 1 },
    camTarget: null as { x: number; y: number; k: number } | null,
    hover: null as Node | null,
    drag: null as Node | null,
    pan: null as { x: number; y: number; cx: number; cy: number } | null,
    pointers: new Map<number, { x: number; y: number }>(),
    pinch: null as { d: number; k: number } | null,
    moved: false,
    filter: '',
    width: 0,
    height: 0,
    fitted: false,
    stars: [] as { x: number; y: number; r: number; a: number }[],
  });
  s.current.filter = filter.trim().toLowerCase();

  // ------------------------------------------------------------ data -> simulation
  useEffect(() => {
    const st = s.current;
    const data = props.data;
    if (!data) return;
    const now = performance.now();
    const old = st.byId;
    const first = old.size === 0;
    const nodes: Node[] = data.nodes.map((n) => {
      const prev = old.get(n.id);
      if (prev) return Object.assign(prev, n, { hue: hueFor(n.id, folders) });
      // New thoughts appear near a connected node if there is one.
      const anchorLink = data.links.find((l) => l.source === n.id || l.target === n.id);
      const anchor = anchorLink ? old.get(anchorLink.source === n.id ? anchorLink.target : anchorLink.source) : undefined;
      return {
        ...n,
        hue: hueFor(n.id, folders),
        phase: Math.random() * Math.PI * 2,
        born: first ? now - 10000 : now,
        firedAt: -1e9,
        x: anchor?.x != null ? anchor.x + (Math.random() - 0.5) * 30 : (Math.random() - 0.5) * 400,
        y: anchor?.y != null ? anchor.y + (Math.random() - 0.5) * 30 : (Math.random() - 0.5) * 400,
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: Link[] = [];
    for (const l of data.links) {
      const a = byId.get(l.source);
      const b = byId.get(l.target);
      if (!a || !b) continue;
      let h = 0;
      for (const ch of linkId(l)) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
      links.push({ source: a, target: b, bend: ((h % 1000) / 1000 - 0.5) * 0.35 });
    }
    st.neighbors = new Map();
    st.adjacency = new Map();
    for (const l of links) {
      for (const [x, y] of [
        [l.source, l.target],
        [l.target, l.source],
      ] as const) {
        if (!st.neighbors.has(x.id)) st.neighbors.set(x.id, new Set());
        st.neighbors.get(x.id)!.add(y.id);
        if (!st.adjacency.has(x.id)) st.adjacency.set(x.id, []);
        st.adjacency.get(x.id)!.push(l);
      }
    }
    st.nodes = nodes;
    st.links = links;
    st.byId = byId;
    const live = new Set(links);
    st.pulses = st.pulses.filter((p) => live.has(p.link));

    st.sim?.stop();
    const radius = Math.max(150, Math.sqrt(nodes.length) * 55);
    st.sim = forceSimulation<Node, Link>(nodes)
      .force(
        'link',
        forceLink<Node, Link>(links)
          .id((d) => d.id)
          .distance((l) => 50 + Math.min(60, (l.source.degree + l.target.degree) * 3))
          .strength(0.5),
      )
      .force('charge', forceManyBody<Node>().strength((d) => -120 - d.degree * 12).distanceMax(600))
      .force('collide', forceCollide<Node>().radius((d) => 10 + Math.sqrt(d.degree) * 3))
      // Pull everything into a rounded, brain-like blob; orphans drift to the edge.
      .force('radial', forceRadial<Node>((d) => (d.degree === 0 ? radius * 1.1 : 0), 0, 0).strength((d) => (d.degree === 0 ? 0.08 : 0.015)))
      .force('x', forceX<Node>(0).strength(0.03))
      .force('y', forceY<Node>(0).strength(0.045))
      .alpha(first ? 1 : 0.15)
      .alphaDecay(0.02);
    if (first) {
      // Settle the initial layout before the first frame so it doesn't explode on screen.
      st.sim.stop();
      for (let i = 0; i < 220; i++) st.sim.tick();
      st.sim.alpha(0.05).restart();
      st.fitted = false;
    }
  }, [props.data, folders]);

  // ------------------------------------------------------------ render loop + interaction
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d')!;
    const st = s.current;
    let raf = 0;
    let last = performance.now();

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      st.width = r.width;
      st.height = r.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      st.stars = Array.from({ length: Math.round((r.width * r.height) / 9000) }, () => ({
        x: Math.random() * r.width,
        y: Math.random() * r.height,
        r: Math.random() * 1.1 + 0.2,
        a: Math.random() * 0.5 + 0.1,
      }));
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const nodeRadius = (n: Node) => (n.unresolved ? 2.5 : 3.5 + Math.sqrt(n.degree) * 1.8);
    const centerX = () => (st.width * (1 - propsRef.current.rightInset)) / 2;
    const centerY = () => st.height / 2;

    const fit = () => {
      if (!st.nodes.length) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of st.nodes) {
        minX = Math.min(minX, n.x!);
        maxX = Math.max(maxX, n.x!);
        minY = Math.min(minY, n.y!);
        maxY = Math.max(maxY, n.y!);
      }
      const w = st.width * (1 - propsRef.current.rightInset);
      const k = Math.min(2.2, Math.max(0.15, Math.min(w / (maxX - minX + 160), st.height / (maxY - minY + 160))));
      st.cam = { k, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k };
    };

    const toWorld = (cx: number, cy: number) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: (cx - r.left - centerX() - st.cam.x) / st.cam.k,
        y: (cy - r.top - centerY() - st.cam.y) / st.cam.k,
      };
    };
    const hitTest = (cx: number, cy: number): Node | null => {
      const p = toWorld(cx, cy);
      let best: Node | null = null;
      let bestD = Infinity;
      for (const n of st.nodes) {
        const d = Math.hypot(n.x! - p.x, n.y! - p.y);
        const reach = nodeRadius(n) + 10 / st.cam.k;
        if (d < reach && d < bestD) (best = n), (bestD = d);
      }
      return best;
    };

    const spawnPulse = (link: Link, forward: boolean, strong: boolean) => {
      if (st.pulses.length > 400) return;
      st.pulses.push({ link, t: 0, speed: (strong ? 0.9 : 0.35) + Math.random() * 0.4, forward, strong });
    };

    const fire = (id: string) => {
      const n = st.byId.get(id);
      if (!n) return;
      n.firedAt = performance.now();
      st.ripples.push({ node: n, start: n.firedAt });
      for (const l of st.adjacency.get(id) ?? []) spawnPulse(l, l.source === n, true);
    };

    const focusOn = (id: string) => {
      const n = st.byId.get(id);
      if (!n || n.x == null) return;
      const k = Math.max(st.cam.k, 1.15);
      st.camTarget = { k, x: -n.x * k, y: -n.y! * k };
    };

    propsRef.current.onReady?.({ fire, focus: focusOn });

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { width: W, height: H, cam } = st;
      if (!W || !H) return;
      if (!st.fitted && st.nodes.length) {
        fit();
        st.fitted = true;
      }
      if (st.camTarget) {
        const e = 1 - Math.pow(0.0015, dt);
        cam.x += (st.camTarget.x - cam.x) * e;
        cam.y += (st.camTarget.y - cam.y) * e;
        cam.k += (st.camTarget.k - cam.k) * e;
        if (Math.abs(st.camTarget.x - cam.x) + Math.abs(st.camTarget.y - cam.y) < 0.5 && Math.abs(st.camTarget.k - cam.k) < 0.002) {
          st.camTarget = null;
        }
      }

      const selectedId = propsRef.current.selected;
      const focus = st.hover ?? (selectedId ? st.byId.get(selectedId) ?? null : null);
      const focusSet = focus ? st.neighbors.get(focus.id) : undefined;
      const filterOn = !!st.filter;
      const matches = (n: Node) => !filterOn || n.name.toLowerCase().includes(st.filter);
      const t = now / 1000;

      // Background: deep space + vignette + faint stars.
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#05040b';
      ctx.fillRect(0, 0, W, H);
      const bg = ctx.createRadialGradient(centerX(), H / 2, 0, centerX(), H / 2, Math.max(W, H) * 0.7);
      bg.addColorStop(0, 'rgba(60, 30, 110, 0.35)');
      bg.addColorStop(0.5, 'rgba(20, 12, 45, 0.25)');
      bg.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      for (const star of st.stars) {
        ctx.globalAlpha = star.a * (0.7 + 0.3 * Math.sin(t * 0.8 + star.x));
        ctx.fillStyle = '#c8c0ff';
        ctx.fillRect(star.x, star.y, star.r, star.r);
      }
      ctx.globalAlpha = 1;

      ctx.save();
      ctx.translate(centerX() + cam.x, centerY() + cam.y);
      ctx.scale(cam.k, cam.k);

      // Gentle "breathing" displacement, purely visual.
      const wob = (n: Node) => ({
        x: n.x! + Math.sin(t * 0.6 + n.phase) * 1.6,
        y: n.y! + Math.cos(t * 0.5 + n.phase * 1.3) * 1.6,
      });
      const pos = new Map<Node, { x: number; y: number }>();
      for (const n of st.nodes) if (n.x != null) pos.set(n, wob(n));

      const curve = (l: Link) => {
        const a = pos.get(l.source)!;
        const b = pos.get(l.target)!;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        return { a, b, cx: mx - dy * l.bend, cy: my + dx * l.bend };
      };

      // Synapses (links).
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (const l of st.links) {
        if (!pos.has(l.source) || !pos.has(l.target)) continue;
        const hot = focus && (l.source === focus || l.target === focus);
        const dim = (focus && !hot) || (filterOn && !(matches(l.source) && matches(l.target)));
        const { a, b, cx, cy } = curve(l);
        const hue = hot ? focus!.hue : (l.source.hue + l.target.hue) / 2;
        ctx.strokeStyle = `hsla(${hue}, 90%, ${hot ? 70 : 60}%, ${hot ? 0.55 : dim ? 0.05 : 0.14})`;
        ctx.lineWidth = (hot ? 1.6 : 0.9) / Math.sqrt(cam.k);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cx, cy, b.x, b.y);
        ctx.stroke();
      }

      // Ambient firing: random signals; focused node's connections fire more.
      if (st.links.length) {
        const ambient = Math.min(6, st.links.length * 0.02) * dt * 10;
        if (Math.random() < ambient) {
          const l = st.links[(Math.random() * st.links.length) | 0];
          spawnPulse(l, Math.random() < 0.5, false);
        }
        if (focus && Math.random() < dt * 4) {
          const ls = st.adjacency.get(focus.id);
          if (ls?.length) {
            const l = ls[(Math.random() * ls.length) | 0];
            spawnPulse(l, l.source === focus, true);
          }
        }
      }

      // Signals travelling along synapses.
      for (let i = st.pulses.length - 1; i >= 0; i--) {
        const p = st.pulses[i];
        p.t += dt * p.speed;
        if (p.t >= 1) {
          st.pulses.splice(i, 1);
          // A strong signal arriving makes the target flicker.
          const arrived = p.forward ? p.link.target : p.link.source;
          if (p.strong) arrived.firedAt = Math.max(arrived.firedAt, now - 500);
          continue;
        }
        if (!pos.has(p.link.source) || !pos.has(p.link.target)) continue;
        const { a, b, cx, cy } = curve(p.link);
        const u = p.forward ? p.t : 1 - p.t;
        const x = (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * cx + u * u * b.x;
        const y = (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * cy + u * u * b.y;
        const from = p.forward ? p.link.source : p.link.target;
        const size = (p.strong ? 14 : 9) / Math.sqrt(cam.k);
        ctx.globalAlpha = Math.sin(p.t * Math.PI) * (p.strong ? 1 : 0.7);
        ctx.drawImage(glowSprite(from.hue, 80), x - size / 2, y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;

      // Ripples from fired nodes.
      for (let i = st.ripples.length - 1; i >= 0; i--) {
        const r = st.ripples[i];
        const age = Math.max(0, (now - r.start) / 1000);
        if (age > 1.6) {
          st.ripples.splice(i, 1);
          continue;
        }
        const p = pos.get(r.node);
        if (!p) continue;
        ctx.strokeStyle = `hsla(${r.node.hue}, 100%, 75%, ${(1 - age / 1.6) * 0.8})`;
        ctx.lineWidth = 2 / cam.k;
        ctx.beginPath();
        ctx.arc(p.x, p.y, nodeRadius(r.node) + age * 60, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Neurons (nodes).
      for (const n of st.nodes) {
        const p = pos.get(n);
        if (!p) continue;
        const isSel = n.id === selectedId;
        const isHover = n === st.hover;
        const near = focusSet?.has(n.id);
        let alpha = 1;
        if (focus && !isSel && !isHover && !near && n !== focus) alpha = 0.28;
        if (filterOn) alpha = matches(n) ? 1 : 0.12;
        // rAF timestamps can trail performance.now() slightly, so clamp ages at 0.
        const age = Math.max(0, (now - n.born) / 1000);
        const grow = age < 1.2 ? Math.max(0.05, 1 - Math.pow(1 - age / 1.2, 3)) : 1;
        const fireAge = Math.max(0, (now - n.firedAt) / 1000);
        const fireBoost = fireAge < 1.5 ? 1 - fireAge / 1.5 : 0;
        const breath = 1 + Math.sin(t * 1.4 + n.phase) * 0.08;
        const r = nodeRadius(n) * grow * breath * (1 + fireBoost * 0.6) * (isSel || isHover ? 1.25 : 1);
        const light = n.unresolved ? 55 : isSel ? 82 : 72;

        ctx.globalAlpha = alpha * (n.unresolved ? 0.45 : 1);
        const glow = r * (5 + fireBoost * 5 + (isSel ? 3 : 0));
        ctx.drawImage(glowSprite(n.hue, light), p.x - glow, p.y - glow, glow * 2, glow * 2);

        // Bright core.
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = alpha;
        if (n.unresolved) {
          ctx.strokeStyle = `hsla(${n.hue}, 60%, 70%, 0.6)`;
          ctx.lineWidth = 1 / cam.k;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.fillStyle = `hsl(${n.hue}, 100%, ${88 + fireBoost * 10}%)`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 0.55, 0, Math.PI * 2);
          ctx.fill();
        }
        if (isSel) {
          ctx.strokeStyle = `hsla(${n.hue}, 100%, 85%, ${0.6 + Math.sin(t * 3) * 0.3})`;
          ctx.lineWidth = 1.5 / cam.k;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 5 / cam.k + Math.sin(t * 3) * 1.5 / cam.k, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'lighter';
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // Labels.
      const fontPx = 12;
      ctx.font = `500 ${fontPx / cam.k}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const showAll = cam.k > 1.3 || (st.nodes.length <= 40 && cam.k > 0.75);
      for (const n of st.nodes) {
        const p = pos.get(n);
        if (!p) continue;
        const important = n === focus || n.id === selectedId || focusSet?.has(n.id) || (filterOn && matches(n));
        const big = n.degree >= 6 && cam.k > 0.6;
        if (!important && !showAll && !big) continue;
        let alpha = important ? 1 : showAll ? Math.min(1, (cam.k - 0.5) * 1.5) : 0.75;
        if (focus && !important) alpha *= 0.35;
        if (filterOn && !matches(n)) alpha = 0;
        if (alpha <= 0.02) continue;
        const y = p.y + nodeRadius(n) * 1.4 + 3 / cam.k;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = 'rgba(5,4,11,0.75)';
        ctx.fillText(n.name, p.x + 0.8 / cam.k, y + 0.8 / cam.k);
        ctx.fillStyle = n.unresolved ? 'rgba(200,190,230,0.6)' : `hsl(${n.hue}, 60%, ${important ? 92 : 80}%)`;
        ctx.fillText(n.name, p.x, y);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    };
    raf = requestAnimationFrame(frame);

    // --- pointer handling (mouse, pen, touch with pinch-zoom)
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      st.camTarget = null;
      if (st.pointers.size === 2) {
        const [a, b] = [...st.pointers.values()];
        st.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: st.cam.k };
        st.drag = null;
        st.pan = null;
        return;
      }
      st.moved = false;
      const n = hitTest(e.clientX, e.clientY);
      if (n) {
        st.drag = n;
        n.fx = n.x;
        n.fy = n.y;
      } else st.pan = { x: e.clientX, y: e.clientY, cx: st.cam.x, cy: st.cam.y };
    };
    const onMove = (e: PointerEvent) => {
      if (st.pointers.has(e.pointerId)) st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (st.pinch && st.pointers.size === 2) {
        const [a, b] = [...st.pointers.values()];
        st.cam.k = Math.min(6, Math.max(0.1, (st.pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / st.pinch.d));
        st.moved = true;
        return;
      }
      if (st.drag) {
        const p = toWorld(e.clientX, e.clientY);
        if (!st.moved && Math.hypot(p.x - st.drag.x!, p.y - st.drag.y!) * st.cam.k < 4) return;
        st.moved = true;
        st.drag.fx = p.x;
        st.drag.fy = p.y;
        st.sim?.alphaTarget(0.25).restart();
      } else if (st.pan) {
        const dx = e.clientX - st.pan.x;
        const dy = e.clientY - st.pan.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) st.moved = true;
        st.cam.x = st.pan.cx + dx;
        st.cam.y = st.pan.cy + dy;
      } else if (e.pointerType === 'mouse') {
        const n = hitTest(e.clientX, e.clientY);
        if (n !== st.hover) {
          st.hover = n;
          canvas.style.cursor = n ? 'pointer' : 'grab';
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      st.pointers.delete(e.pointerId);
      if (st.pinch) {
        if (st.pointers.size < 2) st.pinch = null;
        return;
      }
      const clicked = !st.moved ? hitTest(e.clientX, e.clientY) : null;
      if (st.drag) {
        st.drag.fx = null;
        st.drag.fy = null;
        st.sim?.alphaTarget(0);
        st.drag = null;
      }
      const wasPan = st.pan;
      st.pan = null;
      if (clicked) {
        fire(clicked.id);
        if (clicked.unresolved) propsRef.current.onSelectUnresolved(clicked.name);
        else propsRef.current.onSelect(clicked.id);
      } else if (wasPan && !st.moved) propsRef.current.onBackground();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      st.camTarget = null;
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left - centerX();
      const my = e.clientY - r.top - centerY();
      const { x, y, k } = st.cam;
      const nk = Math.min(6, Math.max(0.1, k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
      st.cam = { k: nk, x: mx - ((mx - x) * nk) / k, y: my - ((my - y) * nk) / k };
    };
    const onLeave = () => {
      st.hover = null;
    };
    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      document.removeEventListener('visibilitychange', onVisibility);
      st.sim?.stop();
    };
  }, []);

  // Fly to the selected thought (and keep it visible beside the panel).
  useEffect(() => {
    const st = s.current;
    if (!props.selected) return;
    const n = st.byId.get(props.selected);
    if (!n || n.x == null) return;
    const k = Math.max(st.cam.k, 1.15);
    st.camTarget = { k, x: -n.x * k, y: -n.y! * k };
  }, [props.selected, props.data]);

  const stats = props.data
    ? { notes: props.data.nodes.filter((n) => !n.unresolved).length, links: props.data.links.length }
    : null;

  const submitFilter = () => {
    const q = s.current.filter;
    if (!q) return;
    const hit = s.current.nodes
      .filter((n) => n.name.toLowerCase().includes(q))
      .sort((a, b) => Number(a.name.toLowerCase() !== q) - Number(b.name.toLowerCase() !== q) || b.degree - a.degree)[0];
    if (hit) {
      if (hit.unresolved) props.onSelectUnresolved(hit.name);
      else props.onSelect(hit.id);
    }
  };

  return (
    <div className="brain" ref={wrapRef}>
      <canvas ref={canvasRef} />
      <div className="brain-hud top">
        <input
          className="brain-search"
          placeholder="Search the mind…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitFilter();
            if (e.key === 'Escape') setFilter('');
          }}
        />
      </div>
      {stats && (
        <div className="brain-hud bottom-left">
          <div className="brain-stats">
            <b>{stats.notes}</b> thoughts · <b>{stats.links}</b> connections
          </div>
          {folders.length > 0 && (
            <div className="brain-legend">
              {folders.map((f) => (
                <span key={f} className="legend-item">
                  <i style={{ background: `hsl(${hueFor(f + '/x', folders)}, 100%, 70%)` }} />
                  {f}
                </span>
              ))}
              <span className="legend-item">
                <i style={{ background: `hsl(${PALETTE[0]}, 100%, 70%)` }} />
                (root)
              </span>
            </div>
          )}
        </div>
      )}
      {stats && stats.notes === 0 && <div className="brain-empty">Your mind is empty. Create a note to spark the first thought.</div>}
    </div>
  );
}
