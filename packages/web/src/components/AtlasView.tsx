import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphData } from '../api';
import { REGIONS, REGION_BY_KEY, classify, type RegionKey } from '../regions';
import type { BrainHandle } from './BrainView';

interface Props {
  data: GraphData | null;
  selected: string | null;
  rightInset: number;
  onSelect: (id: string) => void;
  onSelectUnresolved: (name: string) => void;
  onBackground: () => void;
  onReady?: (handle: BrainHandle) => void;
  /** Covered by a full-screen panel (phones): stop drawing. */
  paused?: boolean;
}

interface ANode {
  id: string;
  name: string;
  region: RegionKey;
  degree: number;
  unresolved: boolean;
  hub: boolean;
  /** World position (x = left, y = superior, z = anterior). */
  x: number;
  y: number;
  z: number;
  phase: number;
  firedAt: number;
  // Per-frame projection.
  sx: number;
  sy: number;
  depth: number;
  scale: number;
  visible: boolean;
}

interface ALink {
  a: ANode;
  b: ANode;
}

interface Layout {
  nodes: ANode[];
  links: ALink[];
  byId: Map<string, ANode>;
  neighbors: Map<string, Set<string>>;
  adjacency: Map<string, ALink[]>;
  counts: Record<RegionKey, number>;
  /** Brain radius in world units. */
  R: number;
  dust: [number, number, number][];
  /** Links in a stable random order: drawing the first N gives an even sample when there are too many. */
  sampled: ALink[];
}

/** Deterministic pseudo-random numbers from a string, so layouts are stable across reloads. */
function seeded(str: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildLayout(data: GraphData): Layout {
  const regionOf = new Map<string, RegionKey>();
  for (const n of data.nodes) if (!n.unresolved) regionOf.set(n.id, classify(n));
  // Unresolved targets join the region of whoever links to them.
  for (const l of data.links) {
    if (!regionOf.has(l.target) && regionOf.has(l.source)) regionOf.set(l.target, regionOf.get(l.source)!);
  }

  const counts = Object.fromEntries(REGIONS.map((r) => [r.key, 0])) as Record<RegionKey, number>;
  for (const n of data.nodes) if (!n.unresolved) counts[regionOf.get(n.id) ?? 'parietal']++;
  const radiusFor = (count: number) => 34 + Math.cbrt(Math.max(1, count)) * 26;
  const maxR = Math.max(...REGIONS.map((r) => radiusFor(counts[r.key])));
  const R = Math.max(240, maxR * 1.55);

  // Hubs: the most connected notes get a lens glint.
  const degrees = data.nodes.filter((n) => !n.unresolved).map((n) => n.degree).sort((a, b) => b - a);
  const hubCut = Math.max(5, degrees[Math.floor(degrees.length * 0.04)] ?? 5);

  const nodes: ANode[] = [];
  const byId = new Map<string, ANode>();
  for (const n of data.nodes) {
    if (n.unresolved) continue;
    const region = regionOf.get(n.id) ?? 'parietal';
    const def = REGION_BY_KEY[region];
    const rnd = seeded(n.id);
    const rr = radiusFor(counts[region]);
    // Uniform point in a sphere, pulled toward the centre for well-connected notes.
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const dist = Math.cbrt(rnd()) * rr * (1 / (1 + n.degree * 0.025));
    const node: ANode = {
      id: n.id,
      name: n.name,
      region,
      degree: n.degree,
      unresolved: false,
      hub: n.degree >= hubCut,
      x: def.center[0] * R + s * Math.cos(th) * dist,
      y: def.center[1] * R + u * dist * 0.85,
      z: def.center[2] * R + s * Math.sin(th) * dist,
      phase: rnd() * Math.PI * 2,
      firedAt: -1e9,
      sx: 0,
      sy: 0,
      depth: 0,
      scale: 1,
      visible: true,
    };
    nodes.push(node);
    byId.set(n.id, node);
  }
  // Unresolved: faint points floating just outside the note that mentions them.
  for (const n of data.nodes) {
    if (!n.unresolved) continue;
    const link = data.links.find((l) => l.target === n.id);
    const anchor = link ? byId.get(link.source) : undefined;
    if (!anchor) continue;
    const rnd = seeded(n.id);
    const node: ANode = {
      ...anchor,
      id: n.id,
      name: n.name,
      degree: n.degree,
      unresolved: true,
      hub: false,
      x: anchor.x + (rnd() - 0.5) * 50,
      y: anchor.y + (rnd() - 0.5) * 50,
      z: anchor.z + (rnd() - 0.5) * 50,
      phase: rnd() * Math.PI * 2,
    };
    nodes.push(node);
    byId.set(n.id, node);
  }

  const links: ALink[] = [];
  const neighbors = new Map<string, Set<string>>();
  const adjacency = new Map<string, ALink[]>();
  for (const l of data.links) {
    const a = byId.get(l.source);
    const b = byId.get(l.target);
    if (!a || !b) continue;
    const link = { a, b };
    links.push(link);
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      if (!neighbors.has(x.id)) neighbors.set(x.id, new Set());
      neighbors.get(x.id)!.add(y.id);
      if (!adjacency.has(x.id)) adjacency.set(x.id, []);
      adjacency.get(x.id)!.push(link);
    }
  }

  // Faint dust filling a brain-shaped ellipsoid gives the silhouette.
  const rnd = seeded('dust');
  const dust: [number, number, number][] = [];
  for (let i = 0; i < 900; i++) {
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const d = 0.75 + rnd() * 0.45;
    const y = u * d * R * 0.95;
    if (y < -R * 0.75 && Math.abs(s * Math.sin(th)) > 0.4) continue; // flatten underside
    dust.push([s * Math.cos(th) * d * R * 0.95, y, s * Math.sin(th) * d * R * 1.3 - R * 0.05]);
  }

  const shuffle = seeded('links');
  const sampled = [...links];
  for (let i = sampled.length - 1; i > 0; i--) {
    const j = Math.floor(shuffle() * (i + 1));
    [sampled[i], sampled[j]] = [sampled[j], sampled[i]];
  }
  return { nodes, links, byId, neighbors, adjacency, counts, R, dust, sampled };
}

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif';

const glints = new Map<string, HTMLCanvasElement>();
const labelColors = new Map<string, string>();
/** Region colour mixed halfway to white: tinted, but readable on top of its own region. */
function labelColor(rgb: [number, number, number]): string {
  const key = rgb.join(',');
  let c = labelColors.get(key);
  if (!c) labelColors.set(key, (c = `rgb(${rgb.map((v) => Math.round(v + (255 - v) * 0.55)).join(',')})`));
  return c;
}

const lightColors = new Map<string, string>();
/** A region colour, slightly brightened, as a CSS string (cached: no allocation per frame). */
function lightColor(rgb: [number, number, number]): string {
  const key = rgb.join(',');
  let c = lightColors.get(key);
  if (!c) lightColors.set(key, (c = `rgb(${rgb.map((v) => Math.min(255, v + 25)).join(',')})`));
  return c;
}

function softDot(rgb: [number, number, number]): HTMLCanvasElement {
  const key = rgb.join(',');
  let c = glints.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${key}, 0.75)`);
  grad.addColorStop(0.25, `rgba(${key}, 0.28)`);
  grad.addColorStop(0.6, `rgba(${key}, 0.06)`);
  grad.addColorStop(1, `rgba(${key}, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glints.set(key, c);
  return c;
}

const STORE_KEY = 'octavo.atlas';
function loadPrefs(): { labels: boolean; hidden: RegionKey[]; trail: boolean } {
  try {
    return { labels: true, hidden: [], trail: true, ...JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') };
  } catch {
    return { labels: true, hidden: [], trail: true };
  }
}

// ---- Trail: the notes Claude (or you, via the app) read or changed recently, joined in order and fading out.
const TRAIL_KEY = 'octavo.trail';
/** How long a step of the trail stays visible. */
export const TRAIL_MS = 30 * 60 * 1000;
type TrailStep = { id: string; t: number };
let trail: TrailStep[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(TRAIL_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string' && Date.now() - x.t < TRAIL_MS) : [];
  } catch {
    return [];
  }
})();
function addToTrail(id: string) {
  const now = Date.now();
  trail = trail.filter((x) => now - x.t < TRAIL_MS);
  const last = trail[trail.length - 1];
  if (last?.id === id) last.t = now;
  else trail.push({ id, t: now });
  if (trail.length > 300) trail = trail.slice(-300);
  try {
    localStorage.setItem(TRAIL_KEY, JSON.stringify(trail));
  } catch {
    /* ignore */
  }
}

export function AtlasView(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [labels, setLabels] = useState(() => loadPrefs().labels);
  const [hidden, setHidden] = useState<Set<RegionKey>>(() => new Set(loadPrefs().hidden));
  const [showTrail, setShowTrail] = useState(() => loadPrefs().trail);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ labels, hidden: [...hidden], trail: showTrail }));
    } catch {
      /* ignore */
    }
  }, [labels, hidden, showTrail]);

  const layout = useMemo(() => (props.data ? buildLayout(props.data) : null), [props.data]);

  const st = useRef({
    layout: null as Layout | null,
    cam: { yaw: -Math.PI / 2 + 0.38, pitch: 0.16, zoom: 1, tx: 0, ty: 0, tz: 0 },
    camGoal: null as null | { zoom: number; tx: number; ty: number; tz: number },
    lastInteract: 0,
    lastFire: 0,
    kick: () => {},
    zoomBy: (_f: number) => {},
    dismissTip: () => {},
    recenter: () => {},
    drag: null as null | { x: number; y: number; yaw: number; pitch: number; pan: boolean; tx: number; ty: number; tz: number },
    pointers: new Map<number, { x: number; y: number }>(),
    pinch: null as null | { d: number; zoom: number },
    moved: false,
    hover: null as ANode | null,
    labels: true,
    showTrail: true,
    hidden: new Set<RegionKey>(),
    filter: '',
    rings: [] as { node: ANode; start: number }[],
    pulses: [] as { link: ALink; from: ANode; t: number }[],
    W: 0,
    H: 0,
    baseZoom: 1,
    dpr: 1,
  });
  st.current.labels = labels;
  st.current.showTrail = showTrail;
  st.current.hidden = hidden;
  st.current.filter = filter.trim().toLowerCase();

  // Swap in a new layout, carrying over firing state.
  useEffect(() => {
    const s = st.current;
    if (!layout) return;
    if (s.layout) {
      for (const n of layout.nodes) {
        const old = s.layout.byId.get(n.id);
        if (old) n.firedAt = old.firedAt;
      }
    }
    s.layout = layout;
    s.rings = s.rings.filter((r) => layout.byId.has(r.node.id)).map((r) => ({ ...r, node: layout.byId.get(r.node.id)! }));
    s.pulses = [];
  }, [layout]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d')!;
    const s = st.current;
    let raf = 0;
    let scheduled = false;
    let last = performance.now();
    // Draw only when something changes; animations keep asking for the next frame.
    const kick = () => {
      if (scheduled || document.hidden || propsRef.current.paused) return;
      scheduled = true;
      last = Math.max(last, performance.now() - 50);
      raf = requestAnimationFrame((t) => frame(t)); // frame is defined below
    };
    s.kick = kick;
    const coarse = matchMedia('(pointer: coarse)').matches;
    /** 2 = full, 1 = reduced, 0 = minimal. Lowered automatically when frames get slow. */
    let quality = coarse ? 1 : 2;
    let maxQuality = quality;
    let frameMs = 0;
    let slowFrames = 0;
    let fastFrames = 0;
    let bg: CanvasGradient | null = null;
    let bgKey = '';

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      s.W = r.width;
      s.H = r.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      s.dpr = dpr;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      kick();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const cx = () => (s.W * (1 - propsRef.current.rightInset)) / 2;
    const cy = () => s.H / 2;

    /** Rotate + perspective-project a world point. Returns [sx, sy, depth, scale]. */
    const project = (x: number, y: number, z: number, out: number[]) => {
      const { yaw, pitch, zoom, tx, ty, tz } = s.cam;
      const R = s.layout?.R ?? 300;
      const px = x - tx;
      const py = y - ty;
      const pz = z - tz;
      const cyw = Math.cos(yaw);
      const syw = Math.sin(yaw);
      const x1 = px * cyw + pz * syw;
      const z1 = -px * syw + pz * cyw;
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const y2 = py * cp - z1 * sp;
      const z2 = py * sp + z1 * cp;
      const D = R * 3.4;
      const persp = D / (D - z2);
      const k = persp * zoom * s.baseZoom;
      out[0] = cx() + x1 * k;
      out[1] = cy() - y2 * k;
      out[2] = -z2; // larger = farther
      out[3] = k;
    };

    const visibleNode = (n: ANode) => !s.hidden.has(n.region);
    const nodeSize = (n: ANode) => (n.unresolved ? 1.1 : 1.5 + Math.sqrt(n.degree) * 0.75);

    const fire = (id: string) => {
      const n = s.layout?.byId.get(id);
      if (!n) return;
      n.firedAt = performance.now();
      s.lastFire = n.firedAt;
      kick();
      s.rings.push({ node: n, start: n.firedAt });
      for (const l of s.layout!.adjacency.get(id) ?? []) if (s.pulses.length < 300) s.pulses.push({ link: l, from: n, t: 0 });
    };
    const focus = (id: string) => {
      const n = s.layout?.byId.get(id);
      if (!n) return;
      s.camGoal = { tx: n.x, ty: n.y, tz: n.z, zoom: Math.max(s.cam.zoom, 1.7) };
    };
    s.zoomBy = (f: number) => {
      const g = s.camGoal ?? s.cam;
      s.camGoal = { tx: g.tx, ty: g.ty, tz: g.tz, zoom: Math.min(12, Math.max(0.3, g.zoom * f)) };
      s.lastInteract = performance.now();
      kick();
    };
    s.recenter = () => {
      s.camGoal = { tx: 0, ty: 0, tz: 0, zoom: 1 };
      s.lastInteract = performance.now();
      kick();
    };
    const visit = (id: string) => {
      addToTrail(id);
      fire(id);
    };
    propsRef.current.onReady?.({ fire, focus, visit });

    const tmp = [0, 0, 0, 0];

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { W, H } = s;
      const L = s.layout;
      if (!W || !H) return;
      // Big vaults start at reduced quality; it only goes up if frames stay fast.
      const n = L?.nodes.length ?? 0;
      maxQuality = coarse ? (n > 400 ? 1 : 2) : n > 1500 ? 1 : 2;
      if (quality > maxQuality) quality = maxQuality;
      const busy = !!s.drag || !!s.camGoal;
      const autoRotate = !coarse && n <= 800;
      const wobble = quality === 2 && n <= 600;
      const R = L?.R ?? 300;
      s.baseZoom = (Math.min(W * (1 - propsRef.current.rightInset), H) * 0.4) / (R * 1.25);

      // Camera easing and idle auto-rotation.
      if (s.camGoal) {
        const e = 1 - Math.pow(0.002, dt);
        const g = s.camGoal;
        s.cam.tx += (g.tx - s.cam.tx) * e;
        s.cam.ty += (g.ty - s.cam.ty) * e;
        s.cam.tz += (g.tz - s.cam.tz) * e;
        s.cam.zoom += (g.zoom - s.cam.zoom) * e;
        if (Math.abs(g.zoom - s.cam.zoom) < 0.002 && Math.abs(g.tx - s.cam.tx) + Math.abs(g.ty - s.cam.ty) + Math.abs(g.tz - s.cam.tz) < 0.5) {
          s.camGoal = null;
        }
      }
      const rotating = autoRotate && !s.drag && !propsRef.current.selected && now - s.lastInteract > 6000;
      if (rotating) s.cam.yaw += dt * 0.06;

      // Background.
      ctx.globalCompositeOperation = 'source-over';
      const key = `${cx()},${cy()},${W},${H}`;
      if (!bg || bgKey !== key) {
        bg = ctx.createRadialGradient(cx(), cy(), 0, cx(), cy(), Math.max(W, H) * 0.75);
        bg.addColorStop(0, '#1d1c21');
        bg.addColorStop(1, '#111014');
        bgKey = key;
      }
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      if (!L) return;

      // Dust silhouette.
      ctx.fillStyle = 'rgb(205, 200, 190)';
      const dustCount = quality === 2 ? L.dust.length : quality === 1 ? Math.min(L.dust.length, 300) : 0;
      for (let di = 0; di < dustCount; di++) {
        const d = L.dust[di];
        project(d[0], d[1], d[2], tmp);
        const fog = 1 - Math.min(1, Math.max(0, (tmp[2] + R) / (2.4 * R)));
        ctx.globalAlpha = 0.08 + fog * 0.22;
        ctx.fillRect(tmp[0], tmp[1], 1.1, 1.1);
      }
      ctx.globalAlpha = 1;

      // Project nodes.
      for (const n of L.nodes) {
        n.visible = visibleNode(n);
        if (!n.visible) continue;
        const wob = wobble ? Math.sin(now / 1000 * 0.5 + n.phase) * 1.2 : 0;
        project(n.x, n.y + wob, n.z, tmp);
        n.sx = tmp[0];
        n.sy = tmp[1];
        n.depth = tmp[2];
        n.scale = tmp[3];
      }

      const selectedId = propsRef.current.selected;
      const focusNode = s.hover ?? (selectedId ? L.byId.get(selectedId) ?? null : null);
      const near = focusNode ? L.neighbors.get(focusNode.id) : undefined;
      const filterOn = !!s.filter;
      const matches = (n: ANode) => !filterOn || n.name.toLowerCase().includes(s.filter);
      const fogOf = (n: ANode) => 1 - Math.min(1, Math.max(0, (n.depth + R) / (2.4 * R)));

      // Connections: one batched path, additive so bundles glow where they overlap.
      // Connections are drawn exactly one device pixel wide in device coordinates: browsers have a fast
      // path for that (about 15× cheaper than thinner or scaled lines). Additive blending (the glow where
      // lines overlap) only at full quality; fewer lines at lower quality and while dragging.
      const linkCap = quality === 2 ? Infinity : quality === 1 ? (busy ? 4000 : 12000) : busy ? 1500 : 5000;
      const linkList = L.links.length > linkCap ? L.sampled : L.links;
      const drawn = Math.min(linkList.length, linkCap);
      const boostAlpha = Math.min(2.5, Math.sqrt(L.links.length / Math.max(1, drawn)));
      const k = s.dpr;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = quality === 2 ? 'lighter' : 'source-over';
      ctx.lineWidth = 1;
      const baseAlpha = (focusNode || filterOn ? 0.025 : 0.07) * (1.15 / Math.max(1, k * 0.6)) * (quality === 2 ? 1 : 0.9 * boostAlpha);
      const lineAlpha = Math.min(0.5, baseAlpha * Math.max(1, k * 0.6));
      if (quality === 0) {
        // Minimal quality: one neutral batch.
        ctx.strokeStyle = `rgba(200, 196, 188, ${lineAlpha})`;
        ctx.beginPath();
        for (let li = 0; li < drawn; li++) {
          const l = linkList[li];
          if (!l.a.visible || !l.b.visible) continue;
          ctx.moveTo(l.a.sx * k, l.a.sy * k);
          ctx.lineTo(l.b.sx * k, l.b.sy * k);
        }
        ctx.stroke();
      } else {
        // Lines take a tint of the region they start in: six batches, one per region colour.
        for (const reg of REGIONS) {
          ctx.strokeStyle = `rgba(${reg.rgb.join(',')}, ${Math.min(0.55, lineAlpha * 1.35)})`;
          ctx.beginPath();
          for (let li = 0; li < drawn; li++) {
            const l = linkList[li];
            if (l.a.region !== reg.key || !l.a.visible || !l.b.visible) continue;
            ctx.moveTo(l.a.sx * k, l.a.sy * k);
            ctx.lineTo(l.b.sx * k, l.b.sy * k);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
      ctx.globalCompositeOperation = 'lighter';
      if (focusNode && focusNode.visible) {
        const rgb = REGION_BY_KEY[focusNode.region].rgb.join(',');
        ctx.strokeStyle = `rgba(${rgb}, 0.6)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const l of L.adjacency.get(focusNode.id) ?? []) {
          if (!l.a.visible || !l.b.visible) continue;
          ctx.moveTo(l.a.sx, l.a.sy);
          ctx.lineTo(l.b.sx, l.b.sy);
        }
        ctx.stroke();
      }

      // Trail: recent steps joined in order, each segment fading with the age of the step it leads to.
      if (s.showTrail && trail.length) {
        const wall = Date.now();
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineCap = 'round';
        let prev: ANode | null = null;
        for (const step of trail) {
          const age = wall - step.t;
          const n = L.byId.get(step.id);
          if (age >= TRAIL_MS || !n || !n.visible) {
            prev = n && n.visible && age < TRAIL_MS ? n : null;
            continue;
          }
          const fade = Math.pow(1 - age / TRAIL_MS, 1.4);
          const rgb = REGION_BY_KEY[n.region].rgb.join(',');
          if (prev && prev !== n) {
            ctx.strokeStyle = `rgba(${rgb}, ${0.55 * fade})`;
            ctx.lineWidth = 0.6 + 1.4 * fade;
            ctx.beginPath();
            ctx.moveTo(prev.sx, prev.sy);
            ctx.lineTo(n.sx, n.sy);
            ctx.stroke();
          }
          ctx.strokeStyle = `rgba(${rgb}, ${0.7 * fade})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(n.sx, n.sy, 3 + nodeSize(n) * 1.6, 0, Math.PI * 2);
          ctx.stroke();
          prev = n;
        }
        ctx.globalCompositeOperation = 'lighter';
      }

      // Signals from fired notes.
      for (let i = s.pulses.length - 1; i >= 0; i--) {
        const p = s.pulses[i];
        p.t += dt * 0.8;
        if (p.t >= 1) {
          s.pulses.splice(i, 1);
          continue;
        }
        const to = p.link.a === p.from ? p.link.b : p.link.a;
        if (!p.from.visible || !to.visible) continue;
        const x = p.from.sx + (to.sx - p.from.sx) * p.t;
        const y = p.from.sy + (to.sy - p.from.sy) * p.t;
        ctx.globalAlpha = Math.sin(p.t * Math.PI);
        ctx.drawImage(softDot(REGION_BY_KEY[p.from.region].rgb), x - 7, y - 7, 14, 14);
      }
      ctx.globalAlpha = 1;

      // Neurons, far to near. Crowded regions get dimmer halos so they don't wash out.
      const densityDim = Object.fromEntries(
        REGIONS.map((r) => [r.key, Math.min(0.8, 9 / Math.pow(Math.max(1, L.counts[r.key]), 0.55))]),
      ) as Record<RegionKey, number>;
      // Small vaults get bigger, brighter points so the colours read; big ones stay fine-grained.
      const sizeBoost = L.nodes.length < 150 ? 1.6 : L.nodes.length < 600 ? 1.25 : 1;
      const margin = 40;
      const order = L.nodes
        .filter((n) => n.visible && n.sx > -margin && n.sy > -margin && n.sx < W + margin && n.sy < H + margin)
        .sort((a, b) => b.depth - a.depth);
      for (const n of order) {
        const reg = REGION_BY_KEY[n.region];
        const fog = fogOf(n);
        let alpha = 0.35 + fog * 0.65;
        const isFocus = n === focusNode || n.id === selectedId;
        if (focusNode && !isFocus && !near?.has(n.id)) alpha *= 0.3;
        if (filterOn) alpha *= matches(n) ? 1.3 : 0.12;
        if (n.unresolved) alpha *= 0.4;
        const fireAge = Math.max(0, (now - n.firedAt) / 1000);
        const boost = fireAge < 1.5 ? 1 - fireAge / 1.5 : 0;
        const r = nodeSize(n) * sizeBoost * Math.max(0.55, n.scale / s.baseZoom) * (isFocus ? 1.6 : 1) * (1 + boost);
        const density = densityDim[n.region];
        // Halos: everything at full quality; at lower quality only notes that matter right now.
        const important = n.hub || isFocus || boost > 0 || (focusNode !== null && near?.has(n.id));
        if (quality === 2 || (important && (quality === 1 || isFocus || boost > 0))) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = Math.min(1, alpha * (n.hub || isFocus || boost > 0 ? 0.9 : density));
          const glow = r * (n.hub || isFocus ? 6 : 2.6) * (1 + boost * 1.5);
          ctx.drawImage(softDot(reg.rgb), n.sx - glow, n.sy - glow, glow * 2, glow * 2);
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.fillStyle = isFocus || boost > 0 ? '#ffffff' : lightColor(reg.rgb);
        const dot = Math.max(0.6, r * 0.62);
        if (dot < 1.4 && quality < 2) {
          ctx.fillRect(n.sx - dot, n.sy - dot, dot * 2, dot * 2); // tiny dots: a square is much cheaper than a circle
        } else {
          ctx.beginPath();
          ctx.arc(n.sx, n.sy, dot, 0, Math.PI * 2);
          ctx.fill();
        }
        if (n.hub || isFocus) {
          // Hubs and the open note get a soft double halo.
          ctx.strokeStyle = `rgba(${reg.rgb.join(',')}, ${0.32 * alpha})`;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.arc(n.sx, n.sy, r * 1.9, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = `rgba(${reg.rgb.join(',')}, ${0.14 * alpha})`;
          ctx.beginPath();
          ctx.arc(n.sx, n.sy, r * 3.2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // Ripples.
      for (let i = s.rings.length - 1; i >= 0; i--) {
        const ring = s.rings[i];
        const age = Math.max(0, (now - ring.start) / 1000);
        if (age > 1.8) {
          s.rings.splice(i, 1);
          continue;
        }
        if (!ring.node.visible) continue;
        ctx.strokeStyle = `rgba(${REGION_BY_KEY[ring.node.region].rgb.join(',')}, ${(1 - age / 1.8) * 0.9})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(ring.node.sx, ring.node.sy, 6 + age * 70, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Labels.
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = `500 11.5px ${SANS}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const zoomed = s.cam.zoom > 2.2;
      const placed: [number, number, number, number][] = [];
      const fits = (x: number, y: number, w: number, h: number) => {
        for (const b of placed) if (x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]) return false;
        placed.push([x, y, w, h]);
        return true;
      };
      // Most important labels claim space first: focus, neighbours, then hubs by degree.
      const labelOrder = [...order].sort((a, b) => {
        const rank = (n: ANode) => (n === focusNode || n.id === selectedId ? 3 : near?.has(n.id) ? 2 : n.hub ? 1 : 0);
        return rank(b) - rank(a) || b.degree - a.degree || a.depth - b.depth;
      });
      let hubLabels = 0;
      for (const n of labelOrder) {
        const isFocus = n === focusNode || n.id === selectedId;
        const show =
          isFocus ||
          near?.has(n.id) ||
          (filterOn && matches(n)) ||
          (s.labels && !focusNode && !filterOn && (n.hub || L.nodes.length <= 60 || (zoomed && fogOf(n) > 0.45 && !n.unresolved)));
        if (!show) continue;
        const plainHub = !isFocus && !near?.has(n.id) && !(filterOn && matches(n));
        if (plainHub && n.hub && !zoomed && L.nodes.length > 60 && hubLabels >= 14) continue;
        const reg = REGION_BY_KEY[n.region];
        const fog = fogOf(n);
        const text = n.name.length > 34 ? n.name.slice(0, 33) + '…' : n.name;
        const x = n.sx + nodeSize(n) * 2 + 6;
        const w = ctx.measureText(text).width;
        if (!fits(x - 2, n.sy - 7, w + 4, 14) && !isFocus) continue;
        if (plainHub && n.hub) hubLabels++;
        ctx.globalAlpha = isFocus ? 1 : 0.45 + fog * 0.5;
        // A dark outline keeps names readable over bright, dense regions.
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(14,13,17,0.85)';
        ctx.strokeText(text, x, n.sy);
        ctx.fillStyle = isFocus ? '#ffffff' : labelColor(reg.rgb);
        ctx.fillText(text, x, n.sy);
      }
      ctx.globalAlpha = 1;

    };
    const frame = (now: number) => {
      scheduled = false;
      const t0 = performance.now();
      draw(now);
      const took = performance.now() - t0;
      frameMs = frameMs ? frameMs * 0.85 + took * 0.15 : took;
      // Adapt: slow frames lower the quality; a long run of fast ones raises it again.
      if (frameMs > 24) {
        if (++slowFrames > 6 && quality > 0) {
          quality--;
          slowFrames = 0;
          frameMs = 0;
        }
      } else slowFrames = 0;
      if (frameMs < 8 && quality < maxQuality && !s.drag) {
        if (++fastFrames > 90) {
          quality++;
          fastFrames = 0;
        }
      } else fastFrames = 0;
      // Keep animating only while something moves.
      const L = s.layout;
      const n = L?.nodes.length ?? 0;
      const rotating = !coarse && n <= 800 && !s.drag && !propsRef.current.selected && now - s.lastInteract > 6000;
      const wobble = quality === 2 && n <= 600;
      const glowing = now - s.lastFire < 1600;
      if (s.drag || s.camGoal || s.pulses.length || s.rings.length || glowing || rotating || wobble || now - s.lastInteract < 6500) kick();
    };
    // The trail fades slowly: refresh it now and then even when idle.
    const trailTimer = setInterval(kick, 15_000);
    kick();

    // ---------------------------------------------------------------- input
    const hitTest = (x: number, y: number): ANode | null => {
      const L = s.layout;
      if (!L) return null;
      const rect = canvas.getBoundingClientRect();
      const px = x - rect.left;
      const py = y - rect.top;
      let best: ANode | null = null;
      let bestScore = Infinity;
      for (const n of L.nodes) {
        if (!n.visible) continue;
        const d = Math.hypot(n.sx - px, n.sy - py);
        const reach = Math.max(7, nodeSize(n) * 2.2);
        if (d > reach) continue;
        const score = d + n.depth * 0.002; // prefer nearer-to-camera on ties
        if (score < bestScore) (best = n), (bestScore = score);
      }
      return best;
    };

    const onDown = (e: PointerEvent) => {
      s.dismissTip();
      canvas.setPointerCapture(e.pointerId);
      s.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      s.lastInteract = performance.now();
      kick();
      s.camGoal = null;
      if (s.pointers.size === 2) {
        const [a, b] = [...s.pointers.values()];
        s.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: s.cam.zoom };
        s.drag = null;
        return;
      }
      s.moved = false;
      s.drag = {
        x: e.clientX,
        y: e.clientY,
        yaw: s.cam.yaw,
        pitch: s.cam.pitch,
        pan: e.shiftKey || e.button === 2 || e.button === 1,
        tx: s.cam.tx,
        ty: s.cam.ty,
        tz: s.cam.tz,
      };
    };
    const onMove = (e: PointerEvent) => {
      if (s.pointers.has(e.pointerId)) s.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (s.pinch && s.pointers.size === 2) {
        const [a, b] = [...s.pointers.values()];
        s.cam.zoom = Math.min(12, Math.max(0.3, (s.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / s.pinch.d));
        s.moved = true;
        return;
      }
      if (s.drag) {
        const dx = e.clientX - s.drag.x;
        const dy = e.clientY - s.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) s.moved = true;
        s.lastInteract = performance.now();
      kick();
        if (s.drag.pan) {
          // Pan in screen plane: convert screen delta to world delta (approximate, ignoring perspective).
          const k = s.cam.zoom * s.baseZoom;
          const { yaw, pitch } = s.cam;
          // Rows of the world->view rotation: screen-right and screen-up in world space.
          const rx = [Math.cos(yaw), 0, Math.sin(yaw)];
          const uy = [Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), -Math.cos(yaw) * Math.sin(pitch)];
          s.cam.tx = s.drag.tx - (dx * rx[0] - dy * uy[0]) / k;
          s.cam.ty = s.drag.ty - (dx * rx[1] - dy * uy[1]) / k;
          s.cam.tz = s.drag.tz - (dx * rx[2] - dy * uy[2]) / k;
        } else {
          s.cam.yaw = s.drag.yaw + dx * 0.006;
          s.cam.pitch = Math.max(-1.35, Math.min(1.35, s.drag.pitch + dy * 0.006));
        }
        return;
      }
      if (e.pointerType === 'mouse') {
        const n = hitTest(e.clientX, e.clientY);
        if (n !== s.hover) {
          s.hover = n;
          kick();
          canvas.style.cursor = n ? 'pointer' : 'grab';
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      s.pointers.delete(e.pointerId);
      if (s.pinch) {
        if (s.pointers.size < 2) s.pinch = null;
        return;
      }
      const wasDrag = s.drag;
      s.drag = null;
      if (!wasDrag || s.moved) return;
      const n = hitTest(e.clientX, e.clientY);
      if (n) {
        fire(n.id);
        if (n.unresolved) propsRef.current.onSelectUnresolved(n.name);
        else propsRef.current.onSelect(n.id);
      } else propsRef.current.onBackground();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      s.lastInteract = performance.now();
      kick();
      s.camGoal = null;
      s.cam.zoom = Math.min(12, Math.max(0.3, s.cam.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
    };
    const onLeave = () => {
      s.hover = null;
      kick();
    };
    const noMenu = (e: Event) => e.preventDefault();
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        scheduled = false;
      } else {
        last = performance.now();
        kick();
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', noMenu);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(trailTimer);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', noMenu);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Fly to the selected note; return to the whole brain when the panel closes.
  useEffect(() => {
    const s = st.current;
    if (!props.selected) {
      if (s.camGoal || s.cam.zoom > 1.05 || s.cam.tx || s.cam.ty || s.cam.tz) s.camGoal = { tx: 0, ty: 0, tz: 0, zoom: 1 };
      s.kick();
      return;
    }
    const n = layout?.byId.get(props.selected);
    if (n) s.camGoal = { tx: n.x, ty: n.y, tz: n.z, zoom: Math.max(s.cam.zoom, 1.7) };
  }, [props.selected, layout]);

  // Anything that changes the picture needs a redraw (the canvas only draws on demand).
  useEffect(() => {
    st.current.kick();
  }, [props.selected, props.rightInset, props.paused, layout, labels, hidden, filter, showTrail]);

  const toggle = (k: RegionKey) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const submitFilter = () => {
    const q = st.current.filter;
    const L = st.current.layout;
    if (!q || !L) return;
    const hit = L.nodes
      .filter((n) => !n.unresolved && n.visible && n.name.toLowerCase().includes(q))
      .sort((a, b) => Number(a.name.toLowerCase() !== q) - Number(b.name.toLowerCase() !== q) || b.degree - a.degree)[0];
    if (hit) props.onSelect(hit.id);
  };

  st.current.dismissTip = () => dismissTipRef.current();
  const freeRight = `calc(${props.rightInset * 100}% + 12px)`;
  const toolsStyle = { right: freeRight };
  const dockStyle = { right: freeRight };
  const centerStyle = { left: `${(1 - props.rightInset) * 50}%` };
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const [viewOpen, setViewOpen] = useState(false);
  const dismissTipRef = useRef(() => {});
  const [tip, setTip] = useState(() => {
    try {
      return !localStorage.getItem('octavo.atlasTip');
    } catch {
      return false;
    }
  });
  const dismissTip = () => {
    if (!tip) return;
    setTip(false);
    try {
      localStorage.setItem('octavo.atlasTip', '1');
    } catch {
      /* ignore */
    }
  };
  dismissTipRef.current = dismissTip;

  return (
    <div className="atlas" ref={wrapRef}>
      <canvas ref={canvasRef} />

      {tip && (
        <div className="atlas-tip" style={centerStyle} role="status">
          <span>{coarse ? 'Drag to turn the brain, pinch to zoom, tap a point to open it.' : 'Drag to turn the brain, scroll to zoom, Shift-drag to move, click a point to open it.'}</span>
          <button onClick={dismissTip}>Got it</button>
        </div>
      )}

      <div className="atlas-tools" style={toolsStyle}>
        <div className="atlas-view-wrap">
          <button className={`atlas-tool${viewOpen ? ' on' : ''}`} aria-label="View options" aria-expanded={viewOpen} onClick={() => setViewOpen((v) => !v)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          {viewOpen && (
            <div className="atlas-view-menu" role="menu">
              <label>
                <input type="checkbox" checked={labels} onChange={() => setLabels((l) => !l)} /> Note names
              </label>
              <label title="A fading line through the notes Claude read or changed in the last 30 minutes">
                <input type="checkbox" checked={showTrail} onChange={() => setShowTrail((t) => !t)} /> Claude’s trail
              </label>
            </div>
          )}
        </div>
        <button className="atlas-tool" aria-label="Zoom in" onClick={() => st.current.zoomBy(1.4)}>
          ＋
        </button>
        <button className="atlas-tool" aria-label="Zoom out" onClick={() => st.current.zoomBy(1 / 1.4)}>
          −
        </button>
        <button className="atlas-tool" aria-label="Show the whole brain" onClick={() => st.current.recenter()}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
        </button>
      </div>

      {layout && (
        <div className="atlas-dock" style={dockStyle}>
          <label className={`atlas-find${filter ? ' active' : ''}`}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              aria-label="Find in the brain"
              placeholder="Find"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitFilter();
                if (e.key === 'Escape') setFilter('');
              }}
            />
          </label>
          <div className="atlas-regions" role="group" aria-label="Regions: tap to hide or show, double-tap to show only one">
            {hidden.size > 0 && (
              <button className="atlas-pill all" onClick={() => setHidden(new Set())}>
                Show all
              </button>
            )}
            {REGIONS.map((r) => (
              <button
                key={r.key}
                className={`atlas-pill${hidden.has(r.key) ? ' off' : ''}`}
                style={{ ['--region' as string]: r.color }}
                title={`${r.name}: ${r.label} region (${r.subtitle}). Double-tap to show only this.`}
                aria-pressed={!hidden.has(r.key)}
                onClick={() => toggle(r.key)}
                onDoubleClick={() => setHidden(new Set(REGIONS.filter((x) => x.key !== r.key).map((x) => x.key)))}
              >
                <i aria-hidden="true" />
                {r.name}
                <em>{layout.counts[r.key]}</em>
              </button>
            ))}
          </div>
        </div>
      )}

      {props.data && props.data.nodes.length === 0 && <div className="brain-empty">Your mind is empty. Create a note to spark the first thought.</div>}
    </div>
  );
}
