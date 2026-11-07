import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { GraphData, GraphNode, Island } from '../api';
import { REGIONS, classify, type RegionKey } from '../regions';

/** Same colours as the atlas, so a region looks the same in both views. */
export const NETWORK_COLORS: Record<RegionKey, [number, number, number]> = Object.fromEntries(
  REGIONS.map((r) => [r.key, r.rgb]),
) as Record<RegionKey, [number, number, number]>;
// v2: the layout changed (regions spread over the area), so positions saved by the old layout are ignored.
const POS_KEY = 'octavo.networkPositions2';
const OLD_POS_KEY = 'octavo.networkPositions';
/** The islands the saved positions were laid out with. */
const POS_ISL_KEY = 'octavo.networkPositions2.islands';
const UNRESOLVED_RGB: [number, number, number] = [110, 112, 118];
const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
/** A lighter tint of a region colour for label text. */
const labelColor = (c: [number, number, number]) => `rgb(${c.map((v) => Math.round(v + (255 - v) * 0.55)).join(',')})`;
/** "#rrggbb" (or "#rgb") to an RGB triple; a soft grey if it can't be read. */
function hexRgb(hex: string | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return [170, 170, 180];
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
/** Group key of an island (regions use their own key as group). */
const islandGroup = (id: string) => `isl:${id}`;

/** Imperative controls the app uses to make the brain react to events. */
export interface BrainHandle {
  /** Light up a node and send signals along its connections (e.g. when Claude edits it). */
  fire(id: string): void;
  /** Fly the camera to a node. */
  focus(id: string): void;
  /** Like fire, and also adds the note to the atlas trail (Claude read or changed it). */
  visit?(id: string): void;
}

interface Node extends GraphNode, SimulationNodeDatum {
  rgb: [number, number, number];
  region: RegionKey;
  /** What the note is drawn, hidden and labelled as: its region key, or `isl:<id>` for an island's notes. */
  group: string;
  /** Island id when the note lives on an island (laid out apart from the six regions). */
  isl?: string;
  born: number;
  firedAt: number;
  /** Linked to a big share of the vault (index notes): its links are drawn faint and barely pull. */
  mega: boolean;
  hub: boolean;
  /** Where its region's territory is: a weak pull keeps regions spread over the area. */
  ax: number;
  ay: number;
  /** Cached label text and its width at the label font. */
  text?: string;
  textW?: number;
}
interface Link extends SimulationLinkDatum<Node> {
  source: Node;
  target: Node;
  mega: boolean;
  /** Joins an island to the main map (or another island): no pull, drawn very faint. */
  cross: boolean;
}
interface Pulse {
  link: Link;
  /** 0..1 progress along the link. */
  t: number;
  speed: number;
  forward: boolean;
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
  /** Covered by a full-screen panel (phones): stop drawing. */
  paused?: boolean;
}

/** Pre-rendered glow sprites, one per hue, for cheap drawing. */
const glowCache = new Map<string, HTMLCanvasElement>();
function glowSprite(rgb: [number, number, number]): HTMLCanvasElement {
  const key = rgb.join(',');
  let c = glowCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${key}, 0.8)`);
  grad.addColorStop(0.25, `rgba(${key}, 0.3)`);
  grad.addColorStop(0.6, `rgba(${key}, 0.06)`);
  grad.addColorStop(1, `rgba(${key}, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowCache.set(key, c);
  return c;
}

/** Screen margins kept free of the graph: the toolbar at the top, the region dock at the bottom. */
const MARGIN = { top: 64, bottom: 66, side: 14 };
const isCoarse = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

/** Seeded random numbers, so a note starts in the same spot every time. */
function seeded(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/** Regions around the ring, in brain order; hub notes sit in the middle. */
const RING: RegionKey[] = ['frontal', 'parietal', 'occipital', 'cerebellum', 'temporal'];

/**
 * Lay the regions out as slices of an ellipse shaped like the free screen area, each slice sized by
 * how many notes it holds, so the notes spread over the whole view instead of piling up in a ball.
 */
function territories(counts: Record<RegionKey, number>, R: number, aspect: number) {
  const sx = Math.sqrt(aspect);
  const sy = 1 / sx;
  const ring = RING.filter((k) => counts[k] > 0);
  const total = ring.reduce((a, k) => a + counts[k], 0) || 1;
  const out = new Map<RegionKey, { a0: number; a1: number }>();
  let a = -Math.PI / 2 - (Math.PI * counts[ring[0]]) / total;
  for (const k of ring) {
    const span = (Math.PI * 2 * counts[k]) / total;
    out.set(k, { a0: a, a1: a + span });
    a += span;
  }
  /** A spot in a region's territory: a random point in its slice (the core for hubs). */
  return (region: RegionKey, rnd: () => number): [number, number] => {
    const t = out.get(region);
    if (region === 'stem' || !t) {
      const r = R * 0.28 * Math.sqrt(rnd());
      const th = rnd() * Math.PI * 2;
      return [Math.cos(th) * r * sx, Math.sin(th) * r * sy];
    }
    const r = R * (0.3 + 0.7 * Math.sqrt(rnd()));
    const th = t.a0 + (t.a1 - t.a0) * (0.08 + 0.84 * rnd());
    return [Math.cos(th) * r * sx, Math.sin(th) * r * sy];
  };
}

interface IslandArea {
  x: number;
  y: number;
  r: number;
}

/**
 * Where the islands go: each a round area sized by its note count, packed in columns beside the main
 * ellipse on a wide screen (rows below it on a tall one), with open water between. Returns the main
 * ellipse's aspect, reshaped so main map plus islands together fill the free screen area.
 */
function islandPlan(A: number, R0: number, spacing: number, sizes: { id: string; n: number }[]) {
  const areas = new Map<string, IslandArea>();
  // Links pull a cloud of notes in to about 80% of the area its slots cover: plan with the sizes it really takes.
  const SHRINK = 0.8;
  const R = R0 * SHRINK;
  const radius = (n: number) => spacing * Math.sqrt(Math.max(n, 3) / Math.PI) * 1.05;
  const gap = Math.max(spacing * 3.4, R0 * 0.15);
  const items = [...sizes].sort((p, q) => q.n - p.n).map((it) => ({ id: it.id, r: radius(it.n) * SHRINK, slot: radius(it.n) }));
  const side = A >= 1;
  /** Packs the islands into lines (columns or rows) no longer than `max`; returns the lines' total thickness. */
  const pack = (max: number) => {
    const lines: { items: typeof items; len: number; thick: number }[] = [];
    for (const it of items) {
      const d = it.r * 2;
      const line = lines[lines.length - 1];
      if (line && line.len + gap * 0.6 + d <= max) {
        line.items.push(it);
        line.len += gap * 0.6 + d;
        line.thick = Math.max(line.thick, d);
      } else lines.push({ items: [it], len: d, thick: d });
    }
    return { lines, thick: lines.reduce((a, l) => a + l.thick, 0) + gap * 0.6 * (lines.length - 1) + gap };
  };
  let a = Math.min(2, Math.max(0.5, A));
  let plan = pack(1);
  for (let i = 0; i < 4; i++) {
    const sx = Math.sqrt(a);
    plan = pack(side ? 2 * R / sx : 2 * R * sx);
    const c = plan.thick;
    // Solve for the main ellipse's aspect u² so that ellipse + island band has the screen's aspect A.
    const u = side ? (-c + Math.sqrt(c * c + 16 * R * R * A)) / (4 * R) : (c + Math.sqrt(c * c + (16 * R * R) / A)) / ((4 * R) / A);
    a = Math.min(2, Math.max(0.5, u * u));
  }
  const sx = Math.sqrt(a);
  const sy = 1 / sx;
  let off = (side ? R * sx : R * sy) + gap;
  for (const line of plan.lines) {
    let at = -line.len / 2;
    for (const it of line.items) {
      const along = at + it.r;
      const across = off + line.thick / 2;
      areas.set(it.id, side ? { x: across, y: along, r: it.slot } : { x: along, y: across, r: it.slot });
      at += it.r * 2 + gap * 0.6;
    }
    off += line.thick + gap * 0.6;
  }
  return { aspect: a, areas };
}

export function BrainView(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [filter, setFilter] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const propsRef = useRef(props);
  propsRef.current = props;
  const zoomRef = useRef((_f: number) => {});
  const fitRef = useRef(() => {});
  const resizeRef = useRef(() => {});

  const islands = useMemo<Island[]>(() => props.data?.islands ?? [], [props.data]);
  const regionCounts = useMemo(() => {
    const c = Object.fromEntries(REGIONS.map((r) => [r.key, 0])) as Record<RegionKey, number>;
    const known = new Set(islands.map((i) => i.id));
    for (const n of props.data?.nodes ?? []) if (!n.unresolved && !(n.island && known.has(n.island))) c[classify(n)]++;
    return c;
  }, [props.data, islands]);
  const islandCounts = useMemo(() => {
    const c = new Map<string, number>(islands.map((i) => [i.id, 0]));
    for (const n of props.data?.nodes ?? []) if (!n.unresolved && n.island && c.has(n.island)) c.set(n.island, c.get(n.island)! + 1);
    return c;
  }, [props.data, islands]);

  const s = useRef({
    nodes: [] as Node[],
    /** Nodes by importance (degree), for picking which names to show. */
    ranked: [] as Node[],
    links: [] as Link[],
    byId: new Map<string, Node>(),
    neighbors: new Map<string, Set<string>>(),
    adjacency: new Map<string, Link[]>(),
    pulses: [] as Pulse[],
    ripples: [] as Ripple[],
    sim: null as Simulation<Node, Link> | null,
    /** True while the layout is still moving (ticked by the render loop, within a time budget). */
    settling: false,
    cam: { x: 0, y: 0, k: 1 },
    /** The zoom at which the whole graph fits; node and label sizes are tuned for it. */
    kFit: 1,
    camTarget: null as { x: number; y: number; k: number } | null,
    hover: null as Node | null,
    drag: null as Node | null,
    pan: null as { x: number; y: number; cx: number; cy: number } | null,
    pointers: new Map<number, { x: number; y: number }>(),
    pinch: null as { d: number; k: number; mx: number; my: number; cx: number; cy: number } | null,
    moved: false,
    /** The user has moved the camera: stop auto-fitting while the layout settles. */
    userCam: false,
    filter: '',
    hidden: new Set<string>(),
    /** Colour of each group (region keys and `isl:<id>`), for batched drawing. */
    groupRgb: new Map<string, [number, number, number]>(REGIONS.map((r) => [r.key, r.rgb])),
    /** Islands on screen, for their heading labels. */
    islands: [] as { group: string; name: string; rgb: [number, number, number] }[],
    /** Islands signature: a change re-lays everything out. */
    islandSig: '',
    width: 0,
    height: 0,
    dpr: 1,
    lastSig: '',
    lastBorn: 0,
    lastFire: 0,
    fitted: false,
    /** Ask the render loop to re-fit (e.g. the "show everything" button). */
    refit: false,
    aspect: 1,
    big: false,
    sizes: { leaf: 2, font: 12 },
    linkAlpha: 0.2,
    meanDegree: 4,
  });
  s.current.filter = filter.trim().toLowerCase();
  s.current.hidden = hidden;

  // ------------------------------------------------------------ data -> simulation
  useEffect(() => {
    const st = s.current;
    const data = props.data;
    if (!data) return;
    const now = performance.now();
    const total = data.nodes.filter((n) => !n.unresolved).length;
    const N = data.nodes.length;
    st.big = N > 600;

    // Islands: notes kept apart from the six regions. Unresolved names only linked from one island live there too.
    const islandList = (data.islands ?? []).filter((i) => i && i.id);
    const islandById = new Map(islandList.map((i) => [i.id, i]));
    const islandOf = new Map<string, string>();
    for (const n of data.nodes) if (!n.unresolved && n.island && islandById.has(n.island)) islandOf.set(n.id, n.island);
    if (islandOf.size) {
      const seen = new Map<string, string | null>();
      const note = (u: string, other: string) => {
        const isl = islandOf.get(other) ?? null;
        seen.set(u, seen.has(u) && seen.get(u) !== isl ? null : isl);
      };
      const unresolved = new Set(data.nodes.filter((n) => n.unresolved).map((n) => n.id));
      for (const l of data.links) {
        if (unresolved.has(l.target) && !unresolved.has(l.source)) note(l.target, l.source);
        if (unresolved.has(l.source) && !unresolved.has(l.target)) note(l.source, l.target);
      }
      for (const [u, isl] of seen) if (isl) islandOf.set(u, isl);
    }
    const islandSig = islandList.map((i) => `${i.id}:${i.folder}`).join('|');
    const fresh = st.byId.size === 0;
    // Islands added, removed or changed: lay everything out afresh.
    const relayout = !fresh && islandSig !== st.islandSig;
    const old = relayout ? new Map<string, Node>() : st.byId;
    const first = old.size === 0;
    st.islandSig = islandSig;
    st.groupRgb = new Map<string, [number, number, number]>(REGIONS.map((x) => [x.key, x.rgb]));
    for (const i of islandList) st.groupRgb.set(islandGroup(i.id), hexRgb(i.color));

    // The free screen area's shape, so the layout fills a phone's tall screen as well as a wide monitor.
    const r = wrapRef.current?.getBoundingClientRect();
    const fw = Math.max(200, (r?.width ?? 800) * (1 - props.rightInset) - MARGIN.side * 2);
    const fh = Math.max(200, (r?.height ?? 600) - MARGIN.top - MARGIN.bottom);
    if (first || !st.aspect) st.aspect = Math.min(2, Math.max(0.5, fw / fh));

    // Spacing between notes in world units; small vaults get more room so every name fits.
    const spacing = 30 * Math.max(1, Math.pow(150 / Math.max(N, 1), 0.3));
    const nMain = N - islandOf.size;
    const R = spacing * Math.sqrt(Math.max(nMain, 4) / Math.PI);
    const counts = Object.fromEntries(REGIONS.map((x) => [x.key, 0])) as Record<RegionKey, number>;
    const regionOf = new Map<string, RegionKey>();
    const perIsland = new Map<string, GraphNode[]>();
    for (const n of data.nodes) {
      const k = classify(n);
      regionOf.set(n.id, k);
      const isl = islandOf.get(n.id);
      if (isl) {
        if (!perIsland.has(isl)) perIsland.set(isl, []);
        perIsland.get(isl)!.push(n);
      } else if (!n.unresolved) counts[k]++;
    }
    // With islands, the main ellipse is reshaped to leave room for them beside it.
    const plan = perIsland.size
      ? islandPlan(st.aspect, R, spacing, [...perIsland.entries()].map(([id, l]) => ({ id, n: l.length })))
      : null;
    const spot = territories(counts, R, plan ? plan.aspect : st.aspect);
    // Inside an island its busiest notes sit near the centre.
    const islandRank = new Map<string, number>();
    for (const l of perIsland.values()) {
      const sorted = [...l].sort((p, q) => Number(!!p.unresolved) - Number(!!q.unresolved) || q.degree - p.degree);
      sorted.forEach((n, i) => islandRank.set(n.id, i / Math.max(1, sorted.length)));
    }
    const islandSpot = (id: string, isl: string, rnd: () => number): [number, number] => {
      const a = plan!.areas.get(isl)!;
      const f = islandRank.get(id) ?? 1;
      const rr = a.r * (f < 0.12 ? 0.32 * Math.sqrt(rnd()) : 0.3 + 0.7 * Math.sqrt(rnd()));
      const th = rnd() * Math.PI * 2;
      return [a.x + Math.cos(th) * rr, a.y + Math.sin(th) * rr];
    };
    st.islands = plan
      ? islandList.filter((i) => perIsland.has(i.id)).map((i) => ({ group: islandGroup(i.id), name: i.name, rgb: hexRgb(i.color) }))
      : [];

    const degrees = data.nodes.filter((n) => !n.unresolved).map((n) => n.degree).sort((a, b) => b - a);
    const hubCut = Math.max(4, degrees[Math.floor(degrees.length * 0.03)] ?? 4);
    // Index-like notes linked to 5%+ of the vault: their hundreds of lines would drown everything else.
    const megaCut = Math.max(30, total * 0.05);

    const firstNeighbor = new Map<string, string>();
    for (const l of data.links) {
      if (!firstNeighbor.has(l.source)) firstNeighbor.set(l.source, l.target);
      if (!firstNeighbor.has(l.target)) firstNeighbor.set(l.target, l.source);
    }
    const nodes: Node[] = data.nodes.map((n) => {
      const region = regionOf.get(n.id)!;
      const isl = islandOf.get(n.id);
      const group = isl ? islandGroup(isl) : region;
      const rgb = n.unresolved ? UNRESOLVED_RGB : st.groupRgb.get(group)!;
      const [ax, ay] = isl ? islandSpot(n.id, isl, seeded(n.id)) : spot(region, seeded(n.id));
      const extra = { rgb, region, group, isl, ax, ay, mega: !n.unresolved && n.degree >= megaCut, hub: !n.unresolved && n.degree >= hubCut, text: undefined, textW: undefined };
      const prev = old.get(n.id);
      if (prev) return Object.assign(prev, n, extra);
      // New thoughts appear near a connected node if there is one.
      const anchorId = first ? undefined : firstNeighbor.get(n.id);
      const anchor0 = anchorId ? old.get(anchorId) : undefined;
      // Never start next to a note on the other side of the water.
      const anchor = anchor0 && anchor0.isl === isl ? anchor0 : undefined;
      if (!first) st.lastBorn = now;
      const keep = relayout ? st.byId.get(n.id) : undefined;
      if (keep) {
        // Re-layout after the islands changed: keep the note's identity (and spot, unless it changed sides).
        const moved = keep.isl !== isl;
        return Object.assign(keep, n, extra, moved ? { x: ax, y: ay, vx: 0, vy: 0 } : {});
      }
      return {
        ...n,
        ...extra,
        born: first ? now - 10000 : now,
        firedAt: -1e9,
        x: anchor?.x != null ? anchor.x + (Math.random() - 0.5) * 30 : ax,
        y: anchor?.y != null ? anchor.y + (Math.random() - 0.5) * 30 : ay,
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: Link[] = [];
    for (const l of data.links) {
      const a = byId.get(l.source);
      const b = byId.get(l.target);
      if (!a || !b || a === b) continue;
      links.push({ source: a, target: b, mega: a.mega || b.mega, cross: a.isl !== b.isl });
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
    // Ranked by links, taking turns between regions, so every region gets a few names rather than only the hub notes.
    {
      const per = new Map<string, Node[]>();
      for (const n of [...nodes].sort((a, b) => b.degree - a.degree)) {
        const key = n.unresolved ? 'u' : n.group;
        if (!per.has(key)) per.set(key, []);
        per.get(key)!.push(n);
      }
      const lists = [...per.entries()].filter(([k]) => k !== 'u').map(([, l]) => l);
      st.ranked = [];
      for (let i = 0; st.ranked.length < nodes.length - (per.get('u')?.length ?? 0); i++)
        for (const l of lists) if (l[i]) st.ranked.push(l[i]);
      st.ranked.push(...(per.get('u') ?? []));
    }
    st.links = links;
    st.byId = byId;
    const live = new Set(links);
    st.pulses = st.pulses.filter((p) => live.has(p.link));
    // Fainter lines the more of them there are; lines to index notes fainter still.
    const plain = links.filter((l) => !l.mega && !l.cross).length;
    st.linkAlpha = Math.min(0.32, Math.max(0.07, 1.1 / Math.sqrt(Math.max(plain, 1) / 6)));
    st.meanDegree = Math.max(1, (2 * links.length) / Math.max(1, N)) + 1;
    st.sizes = { leaf: N > 800 ? 1.8 : N > 250 ? 2.3 : N > 60 ? 3 : 3.8, font: 12 };

    st.sim?.stop();
    // Start from the positions saved last time (big vaults otherwise take a while to lay out).
    let restored = 0;
    if (fresh) {
      try {
        localStorage.removeItem(OLD_POS_KEY);
        // Positions saved under other islands would put notes on the wrong side of the water.
        if ((localStorage.getItem(POS_ISL_KEY) ?? '') !== islandSig) throw new Error('islands changed');
        const saved = JSON.parse(localStorage.getItem(POS_KEY) ?? '{}') as Record<string, [number, number]>;
        for (const n of nodes) {
          const p = saved[n.id];
          if (p) {
            n.x = p[0];
            n.y = p[1];
            restored++;
          }
        }
      } catch {
        /* none saved */
      }
    }
    const linkCount = new Map<Node, number>();
    for (const l of links) {
      linkCount.set(l.source, (linkCount.get(l.source) ?? 0) + 1);
      linkCount.set(l.target, (linkCount.get(l.target) ?? 0) + 1);
    }
    const sim = forceSimulation<Node, Link>(nodes)
      .stop()
      .force(
        'link',
        forceLink<Node, Link>(links)
          .distance(spacing * 1.1)
          // Lines to index notes barely pull, or every note would collapse onto them.
          // Lines across the water don't pull at all: an island stays an island.
          .strength((l) => (l.cross ? 0 : l.mega ? 0.004 : 0.5 / Math.min(linkCount.get(l.source)!, linkCount.get(l.target)!))),
      )
      .force('charge', forceManyBody<Node>().strength(-spacing * 0.35).distanceMax(spacing * 4).theta(st.big ? 1.1 : 0.9))
      .force('collide', forceCollide<Node>().radius((d) => spacing * (d.mega ? 0.9 : d.hub ? 0.55 : 0.38)).iterations(1))
      // A weak pull towards each note's region territory: regions stay spread over the whole area.
      // Island notes are held a little firmer, so an island with few inner links still reads as one place.
      .force('x', forceX<Node>((d) => d.ax).strength((d) => (d.unresolved ? (d.isl ? 0.05 : 0.01) : d.mega || d.isl ? 0.3 : 0.22)))
      .force('y', forceY<Node>((d) => d.ay).strength((d) => (d.unresolved ? (d.isl ? 0.05 : 0.01) : d.mega || d.isl ? 0.3 : 0.22)))
      .velocityDecay(0.5)
      // Settle within a few seconds and then stop for good: no endless jiggle, no work while idle.
      .alphaMin(0.01)
      .alphaDecay(st.big ? 0.06 : 0.035);
    st.sim = sim;
    if (first) {
      const mostlyRestored = restored > nodes.length * 0.8;
      sim.alpha(mostlyRestored ? 0.06 : 1);
      // Settle most of the layout before the first frame (within a time limit), so it doesn't move much on screen.
      const t0 = performance.now();
      const limit = mostlyRestored ? 30 : isCoarse() ? 250 : 400;
      while (sim.alpha() > 0.12 && performance.now() - t0 < limit) sim.tick();
      // After the islands changed the camera glides to the new layout; on first load it starts there.
      if (relayout) st.refit = true;
      else st.fitted = false;
      st.userCam = false;
    } else {
      sim.alpha(0.15);
    }
    st.settling = true;
    // The drawing resolution depends on the vault size.
    resizeRef.current();
  }, [props.data]);

  // ------------------------------------------------------------ render loop + interaction
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d')!;
    const st = s.current;
    let raf = 0;
    let timer = 0;
    let last = performance.now();
    const coarse = isCoarse();

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      st.width = r.width;
      st.height = r.height;
      // Big vaults on phones draw at a lower resolution: three times the pixels costs three times the battery.
      const cap = coarse && st.nodes.length > 400 ? 1.5 : 2;
      const dpr = Math.min(window.devicePixelRatio || 1, cap);
      st.dpr = dpr;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      st.lastSig = '';
    };
    resizeRef.current = resize;
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    // The free area: between the toolbar and the dock, left of any open panel.
    const freeW = () => st.width * (1 - propsRef.current.rightInset);
    const centerX = () => freeW() / 2;
    const centerY = () => (MARGIN.top + st.height - MARGIN.bottom) / 2;
    /** How much bigger than at "fit" things are drawn: they grow slower than the zoom, so zooming in spreads them apart. */
    const zoomGrow = () => Math.min(2, Math.max(0.7, Math.sqrt(st.cam.k / st.kFit)));
    const nodePx = (n: Node) => {
      const leaf = st.sizes.leaf * (st.width > 700 ? 1.15 : 1);
      // Sized against the vault's typical note, so an average note is a small dot whatever the link density.
      const r = n.unresolved ? leaf * 0.7 : leaf * Math.min(st.width < 600 ? 2.6 : 3.2, Math.max(0.75, Math.sqrt((n.degree + 1) / st.meanDegree)));
      return r * zoomGrow();
    };

    const fitCam = () => {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const n of st.nodes) {
        if (n.x == null || st.hidden.has(n.group)) continue;
        xs.push(n.x);
        ys.push(n.y!);
      }
      if (!xs.length) return null;
      xs.sort((p, q) => p - q);
      ys.sort((p, q) => p - q);
      // In big vaults a few stray notes far out shouldn't shrink everything else: fit 99% of them.
      const cut = xs.length > 200 ? Math.floor(xs.length * 0.005) : 0;
      const minX = xs[cut], maxX = xs[xs.length - 1 - cut], minY = ys[cut], maxY = ys[ys.length - 1 - cut];
      const w = freeW() - MARGIN.side * 2;
      const h = st.height - MARGIN.top - MARGIN.bottom;
      const pad = 24;
      // Room above the islands for their names.
      const head = st.islands.some((i) => !st.hidden.has(i.group)) ? 26 : 0;
      const k = Math.min(6, Math.max(0.02, Math.min((w - pad * 2) / (maxX - minX || 1), (h - pad * 2 - head) / (maxY - minY || 1))));
      return { k, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k + head / 2 };
    };

    const toWorld = (cx: number, cy: number) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: (cx - r.left - centerX() - st.cam.x) / st.cam.k,
        y: (cy - r.top - centerY() - st.cam.y) / st.cam.k,
      };
    };
    /** The note under a point, with a generous reach for fingers. */
    const hitTest = (cx: number, cy: number, finger: boolean): Node | null => {
      const p = toWorld(cx, cy);
      let best: Node | null = null;
      let bestD = Infinity;
      const slop = finger ? 14 : 5;
      for (const n of st.nodes) {
        if (n.x == null || st.hidden.has(n.group)) continue;
        const d = Math.hypot(n.x - p.x, n.y! - p.y) * st.cam.k;
        const reach = nodePx(n) + slop;
        // Prefer the closest edge, so a big hub doesn't swallow taps on its small neighbours.
        const score = d - nodePx(n);
        if (d < reach && score < bestD) (best = n), (bestD = score);
      }
      return best;
    };

    const spawnPulse = (link: Link, forward: boolean) => {
      if (st.pulses.length > 200) return;
      st.pulses.push({ link, t: 0, speed: 0.9 + Math.random() * 0.4, forward });
    };

    const fire = (id: string) => {
      const n = st.byId.get(id);
      if (!n) return;
      n.firedAt = performance.now();
      st.lastFire = n.firedAt;
      st.ripples.push({ node: n, start: n.firedAt });
      const ls = st.adjacency.get(id) ?? [];
      // Index notes link to hundreds of notes: send signals along a sample, not all of them.
      const step = Math.max(1, Math.ceil(ls.length / 40));
      for (let i = 0; i < ls.length; i += step) spawnPulse(ls[i], ls[i].source === n);
    };

    const focusOn = (id: string) => {
      const n = st.byId.get(id);
      if (!n || n.x == null) return;
      const k = Math.max(st.cam.k, st.kFit * 2.2);
      st.camTarget = { k, x: -n.x * k, y: -n.y! * k };
      st.userCam = true;
    };

    propsRef.current.onReady?.({ fire, focus: focusOn });

    const placed: number[] = [];
    const fits = (x: number, y: number, w: number, h: number) => {
      for (let i = 0; i < placed.length; i += 4) {
        if (x < placed[i] + placed[i + 2] && x + w > placed[i] && y < placed[i + 1] + placed[i + 3] && y + h > placed[i + 1]) return false;
      }
      placed.push(x, y, w, h);
      return true;
    };

    const schedule = () => {
      if (!raf && !timer) raf = requestAnimationFrame(frame);
    };

    const frame = (now: number) => {
      raf = 0;
      if (propsRef.current.paused) {
        // Hidden behind a full-screen panel: check back a few times a second instead of drawing.
        timer = window.setTimeout(() => {
          timer = 0;
          schedule();
        }, 300);
        return;
      }
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { width: W, height: H, cam } = st;
      if (!W || !H) return;

      // Advance the layout within a time budget, and stop simulating once it has settled.
      const sim = st.sim;
      if (sim && st.settling) {
        const t0 = performance.now();
        const budget = coarse ? 6 : 9;
        let n = 0;
        do {
          sim.tick();
          n++;
        } while (n < 4 && performance.now() - t0 < budget && sim.alpha() > sim.alphaMin());
        if (sim.alpha() <= sim.alphaMin() && !st.drag) {
          st.settling = false;
          savePositions();
        }
      }
      if (st.nodes.length && (!st.fitted || st.refit || (st.settling && !st.userCam))) {
        const f = fitCam();
        if (f) {
          if (st.refit) st.camTarget = f;
          else {
            st.cam = f;
            st.kFit = f.k;
          }
          if (!st.fitted || st.refit) st.kFit = f.k;
          st.fitted = true;
          st.refit = false;
        }
      }
      if (st.camTarget) {
        const e = 1 - Math.pow(0.0015, dt);
        cam.x += (st.camTarget.x - cam.x) * e;
        cam.y += (st.camTarget.y - cam.y) * e;
        cam.k += (st.camTarget.k - cam.k) * e;
        if (Math.abs(st.camTarget.x - cam.x) + Math.abs(st.camTarget.y - cam.y) < 0.5 && Math.abs(st.camTarget.k - cam.k) < 0.001) {
          Object.assign(cam, st.camTarget);
          st.camTarget = null;
        }
      }

      const selectedId = propsRef.current.selected;
      const focus = st.hover ?? (selectedId ? st.byId.get(selectedId) ?? null : null);
      const focusSet = focus ? st.neighbors.get(focus.id) : undefined;
      const filterOn = !!st.filter;
      const hiddenSet = st.hidden;
      const matches = (n: Node) => !filterOn || n.name.toLowerCase().includes(st.filter);

      // Skip the redraw when nothing on screen can have changed (saves battery and keeps big vaults smooth).
      const animating = st.settling || !!st.camTarget || st.pulses.length > 0 || st.ripples.length > 0 || now - st.lastBorn < 1300 || now - st.lastFire < 1600;
      const sig = `${cam.x.toFixed(1)},${cam.y.toFixed(1)},${cam.k.toFixed(5)},${st.hover?.id ?? ''},${selectedId ?? ''},${st.filter},${[...hiddenSet].join()},${W},${H},${st.nodes.length},${propsRef.current.rightInset}`;
      if (!animating && sig === st.lastSig) return;
      st.lastSig = sig;

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#1e1e21';
      ctx.fillRect(0, 0, W, H);

      const ox = centerX() + cam.x;
      const oy = centerY() + cam.y;
      const k = cam.k;
      const grow = zoomGrow();
      const visible = (n: Node) => !hiddenSet.has(n.group);
      const dim = !!focus || filterOn;

      // Links: one device pixel wide, drawn in device coordinates (a fast path in every browser),
      // in batches: tinted by the region they start in; lines to index notes in a much fainter pass.
      {
        const d = st.dpr || 1;
        const dx = ox * d;
        const dy = oy * d;
        const dk = k * d;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.lineWidth = 1;
        // Zoomed in, fewer lines are on screen, so each can be a little brighter.
        const a = Math.min(0.4, st.linkAlpha * Math.min(1.4, grow)) * (dim ? 0.35 : 1);
        const batch = (pick: (l: Link) => boolean) => {
          ctx.beginPath();
          for (const l of st.links) {
            if (!pick(l)) continue;
            const s0 = l.source;
            const t0 = l.target;
            if (s0.x == null || t0.x == null || !visible(s0) || !visible(t0)) continue;
            ctx.moveTo(dx + s0.x * dk, dy + s0.y! * dk);
            ctx.lineTo(dx + t0.x * dk, dy + t0.y! * dk);
          }
          ctx.stroke();
        };
        for (const [key, rgb] of st.groupRgb) {
          ctx.strokeStyle = rgba(rgb, a);
          batch((l) => !l.mega && !l.cross && !l.source.unresolved && l.source.group === key);
        }
        ctx.strokeStyle = `rgba(160,160,170,${a * 0.8})`;
        batch((l) => !l.mega && !l.cross && !!l.source.unresolved);
        // Lines to index notes: a faint haze (left out on phones with big vaults, where they cost more than they show).
        if (!(coarse && st.big)) {
          ctx.strokeStyle = `rgba(190,180,220,${Math.min(a, 0.12) * 0.3})`;
          batch((l) => l.mega && !l.cross);
        }
        // Lines between an island and the rest: barely there, so the water between stays open.
        if (st.islands.length) {
          ctx.strokeStyle = `rgba(200,200,215,${Math.min(a, 0.2) * 0.22})`;
          batch((l) => l.cross);
        }
        ctx.restore();
      }

      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(k, k);

      if (focus && visible(focus)) {
        // A note with hundreds of links gets fainter, thinner lines, or they merge into a solid fan.
        const count = st.adjacency.get(focus.id)?.length ?? 0;
        ctx.strokeStyle = rgba(focus.rgb, Math.min(0.8, 3 / Math.sqrt(count + 1)));
        ctx.lineWidth = (count > 40 ? 0.8 : 1.3) / k;
        ctx.beginPath();
        for (const l of st.adjacency.get(focus.id) ?? []) {
          if (l.source.x == null || l.target.x == null || !visible(l.source) || !visible(l.target)) continue;
          ctx.moveTo(l.source.x, l.source.y!);
          ctx.lineTo(l.target.x, l.target.y!);
        }
        ctx.stroke();
      }

      // Signals from fired notes.
      for (let i = st.pulses.length - 1; i >= 0; i--) {
        const p = st.pulses[i];
        p.t += dt * p.speed;
        if (p.t >= 1) {
          st.pulses.splice(i, 1);
          continue;
        }
        const a = p.link.source;
        const b = p.link.target;
        if (a.x == null || b.x == null) continue;
        const u = p.forward ? p.t : 1 - p.t;
        const from = p.forward ? a : b;
        const size = (10 * grow) / k;
        ctx.globalAlpha = Math.sin(p.t * Math.PI);
        ctx.drawImage(glowSprite(from.rgb), a.x + (b.x - a.x) * u - size / 2, a.y! + (b.y! - a.y!) * u - size / 2, size, size);
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
        if (r.node.x == null) continue;
        ctx.strokeStyle = rgba(r.node.rgb, (1 - age / 1.6) * 0.8);
        ctx.lineWidth = 1.5 / k;
        ctx.beginPath();
        ctx.arc(r.node.x, r.node.y!, (nodePx(r.node) + age * 40) / k, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Nodes. Plain ones are batched by colour (one fill per region); special ones are drawn singly.
      const special: Node[] = [];
      const batches = new Map<string, Path2D>();
      const m = 40;
      for (const n of st.nodes) {
        if (n.x == null || !visible(n)) continue;
        const sx = ox + n.x * k;
        const sy = oy + n.y! * k;
        if (sx < -m || sy < -m || sx > W + m || sy > H + m) continue;
        const isSel = n.id === selectedId;
        const recent = now - n.born < 1300 || now - n.firedAt < 1500;
        if (isSel || n === st.hover || n === focus || recent || focusSet?.has(n.id) || (filterOn && matches(n))) {
          special.push(n);
          continue;
        }
        const key = n.unresolved ? 'u' : n.group;
        let path = batches.get(key);
        if (!path) batches.set(key, (path = new Path2D()));
        const r = nodePx(n) / k;
        path.moveTo(n.x + r, n.y!);
        path.arc(n.x, n.y!, r, 0, Math.PI * 2);
      }
      const baseAlpha = dim ? (filterOn ? 0.12 : 0.28) : 1;
      for (const [key, path] of batches) {
        ctx.globalAlpha = baseAlpha * (key === 'u' ? 0.55 : 0.95);
        ctx.fillStyle = rgba(key === 'u' ? UNRESOLVED_RGB : st.groupRgb.get(key) ?? UNRESOLVED_RGB, 1);
        ctx.fill(path);
      }
      for (const n of special) {
        const isSel = n.id === selectedId;
        const isHover = n === st.hover;
        let alpha = 1;
        if (filterOn && !matches(n)) alpha = focusSet?.has(n.id) || n === focus ? 0.6 : 0.12;
        const age = Math.max(0, (now - n.born) / 1000);
        const born = age < 1.2 ? Math.max(0.05, 1 - Math.pow(1 - age / 1.2, 3)) : 1;
        const fireAge = Math.max(0, (now - n.firedAt) / 1000);
        const fireBoost = fireAge < 1.5 ? 1 - fireAge / 1.5 : 0;
        const r = (nodePx(n) * born * (1 + fireBoost * 0.5) * (isSel || isHover ? 1.35 : 1)) / k;
        if (fireBoost > 0 || isSel) {
          const glow = r * 4;
          ctx.globalAlpha = alpha * Math.max(fireBoost, isSel ? 0.6 : 0);
          ctx.drawImage(glowSprite(n.rgb), n.x! - glow, n.y! - glow, glow * 2, glow * 2);
        }
        ctx.globalAlpha = alpha * (n.unresolved ? 0.6 : 1);
        ctx.fillStyle = isHover || fireBoost > 0.5 ? '#ffffff' : rgba(n.rgb, 1);
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2);
        ctx.fill();
        if (isSel) {
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 1.5 / k;
          ctx.beginPath();
          ctx.arc(n.x!, n.y!, r + 3.5 / k, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      // Names, in screen space at a fixed size. The most important claim space first (the focused note,
      // its neighbours, search matches, then hubs by number of links); a name that would overlap another is skipped.
      const font = W < 600 ? 11.5 : 12;
      ctx.font = `500 ${font}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      placed.length = 0;
      // Keep names off the toolbar, the zoom buttons and the dock.
      placed.push(0, 0, 400, MARGIN.top - 8, 0, H - MARGIN.bottom + 4, W, MARGIN.bottom, freeW() - 64, 0, 64, 170);
      // With islands: the area each one (and the main map) covers, so plain names don't spill across the water.
      const box = new Map<string, { x0: number; x1: number; y0: number; y1: number }>();
      if (st.islands.length) {
        for (const n of st.nodes) {
          if (n.x == null || !visible(n)) continue;
          const key = n.isl ? n.group : '';
          const b = box.get(key);
          if (!b) box.set(key, { x0: n.x, x1: n.x, y0: n.y!, y1: n.y! });
          else {
            if (n.x < b.x0) b.x0 = n.x;
            if (n.x > b.x1) b.x1 = n.x;
            if (n.y! < b.y0) b.y0 = n.y!;
            if (n.y! > b.y1) b.y1 = n.y!;
          }
        }
      }
      /** Whether a plain name at this screen rectangle would reach into another island (or the main map). */
      const crosses = (n: Node, x: number, y: number, w: number, h: number) => {
        const own = n.isl ? n.group : '';
        for (const [key, b] of box) {
          if (key === own) continue;
          const bx = ox + b.x0 * k - 6, by = oy + b.y0 * k - 6, bw = (b.x1 - b.x0) * k + 12, bh = (b.y1 - b.y0) * k + 12;
          if (x < bx + bw && x + w > bx && y < by + bh && y + h > by) return true;
        }
        return false;
      };
      // Island names: a soft map heading above each island, placed before the note names.
      if (st.islands.length) {
        const hf = font + 1.5;
        ctx.save();
        ctx.font = `600 ${hf}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        const lc = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
        if ('letterSpacing' in lc) lc.letterSpacing = '0.14em';
        for (const isl of st.islands) {
          const b = box.get(isl.group);
          if (!b) continue;
          const text = isl.name.toUpperCase();
          const w = ctx.measureText(text).width;
          const x = ox + ((b.x0 + b.x1) / 2) * k;
          const y = Math.max(MARGIN.top + hf / 2, oy + b.y0 * k - 10 * grow - hf / 2);
          if (x + w / 2 < 0 || x - w / 2 > W || y > H) continue;
          placed.push(x - w / 2 - 6, y - hf * 0.8, w + 12, hf * 1.6);
          ctx.globalAlpha = dim ? 0.45 : 0.82;
          ctx.lineWidth = 4;
          ctx.strokeStyle = 'rgba(22,22,25,0.9)';
          ctx.strokeText(text, x, y);
          ctx.fillStyle = labelColor(isl.rgb);
          ctx.fillText(text, x, y);
        }
        ctx.restore();
      }
      const zoomRatio = k / st.kFit;
      // How many plain hub names fit: few at "fit" on a phone, more on big screens and when zoomed in.
      const small = st.nodes.length <= 60;
      const budget = small ? Infinity : Math.round(Math.max(6, (W * H) / 55000) * Math.min(4, Math.pow(zoomRatio, 1.2)));
      const draw = (n: Node, strong: boolean) => {
        if (n.x == null || !visible(n)) return false;
        const sx = ox + n.x * k;
        const sy = oy + n.y! * k;
        if (sx < -50 || sy < 0 || sx > W || sy > H) return false;
        if (n.text === undefined) {
          n.text = n.name.length > 30 ? n.name.slice(0, 29) + '…' : n.name;
          n.textW = undefined;
        }
        const w = (n.textW ??= ctx.measureText(n.text).width);
        let x = sx + nodePx(n) + 4;
        // Near the right edge (or the open panel), the name goes on the left of its dot.
        if (x + w > freeW() - 6) x = sx - nodePx(n) - 4 - w;
        if (x < 4 && !strong) return false;
        // Generous spacing around plain names, so they never stack into a column.
        const pad = strong ? 3 : 10;
        if (!strong && box.size > 1 && crosses(n, x, sy - font * 0.75, w, font * 1.5)) {
          // Try the other side of the dot before giving up.
          x = x > sx ? sx - nodePx(n) - 4 - w : sx + nodePx(n) + 4;
          if (x < 4 || x + w > freeW() - 6 || crosses(n, x, sy - font * 0.75, w, font * 1.5)) return false;
        }
        if (!fits(x - pad, sy - font * 0.75 - pad / 2, w + pad * 2, font * 1.5 + pad) && !strong) return false;
        ctx.globalAlpha = strong ? 1 : n.hub ? 0.9 : 0.75;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(22,22,25,0.85)';
        ctx.strokeText(n.text, x, sy);
        ctx.fillStyle = strong ? '#ffffff' : labelColor(n.rgb);
        ctx.fillText(n.text, x, sy);
        return true;
      };
      if (focus) draw(focus, true);
      if (selectedId && selectedId !== focus?.id) {
        const sel = st.byId.get(selectedId);
        if (sel) draw(sel, true);
      }
      if (focusSet) {
        // Neighbours of the focused note, busiest first (a hub's hundreds of neighbours are capped by space).
        let shown = 0;
        const cap = small ? Infinity : Math.max(12, Math.min(budget, 36));
        for (const n of st.ranked) if (focusSet.has(n.id) && draw(n, false) && ++shown >= cap) break;
      }
      if (filterOn) {
        let shown = 0;
        for (const n of st.ranked) if (matches(n) && draw(n, false) && ++shown > 60) break;
      } else if (!focus || !focusSet) {
        let shown = 0;
        // Every island gets at least its busiest name, even where the budget is small (phones).
        if (st.islands.length) {
          const named = new Set<string>();
          const tries = new Map<string, number>();
          for (const n of st.ranked) {
            if (!n.isl || n.unresolved || named.has(n.group)) continue;
            const t = (tries.get(n.group) ?? 0) + 1;
            tries.set(n.group, t);
            if (draw(n, false)) shown++, named.add(n.group);
            else if (t >= 6) named.add(n.group);
            if (named.size >= st.islands.length) break;
          }
        }
        for (const n of st.ranked) {
          if (shown >= budget) break;
          if (n.unresolved && !small) continue;
          if (draw(n, false)) shown++;
        }
      }
      ctx.globalAlpha = 1;
    };

    const savePositions = () => {
      if (st.nodes.length < 50) return;
      try {
        const out: Record<string, [number, number]> = {};
        for (const n of st.nodes) if (n.x != null) out[n.id] = [Math.round(n.x), Math.round(n.y!)];
        localStorage.setItem(POS_KEY, JSON.stringify(out));
        if (st.islandSig) localStorage.setItem(POS_ISL_KEY, st.islandSig);
        else localStorage.removeItem(POS_ISL_KEY);
      } catch {
        /* storage full or blocked */
      }
    };

    raf = requestAnimationFrame(frame);

    // --- pointer handling: mouse drags notes or pans; one finger pans, two fingers pinch; a tap opens a note.
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      st.camTarget = null;
      if (st.pointers.size === 2) {
        const [a, b] = [...st.pointers.values()];
        st.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: st.cam.k, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, cx: st.cam.x, cy: st.cam.y };
        if (st.drag) {
          st.drag.fx = st.drag.fy = null;
          st.drag = null;
        }
        st.pan = null;
        st.moved = true;
        return;
      }
      if (st.pointers.size > 2) return;
      st.moved = false;
      // Touch always pans (notes are small under a finger); mouse and pen can drag a note around.
      const n = e.pointerType === 'touch' ? null : hitTest(e.clientX, e.clientY, false);
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
        const r = canvas.getBoundingClientRect();
        const p = st.pinch;
        const nk = Math.min(st.kFit * 25, Math.max(st.kFit * 0.4, (p.k * Math.hypot(a.x - b.x, a.y - b.y)) / p.d));
        // Zoom about the point between the fingers, and follow it as they move.
        const mx0 = p.mx - r.left - centerX();
        const my0 = p.my - r.top - centerY();
        const mx = (a.x + b.x) / 2 - r.left - centerX();
        const my = (a.y + b.y) / 2 - r.top - centerY();
        st.cam = { k: nk, x: mx - ((mx0 - p.cx) * nk) / p.k, y: my - ((my0 - p.cy) * nk) / p.k };
        st.userCam = true;
        schedule();
        return;
      }
      if (st.drag) {
        const p = toWorld(e.clientX, e.clientY);
        if (!st.moved && Math.hypot(p.x - st.drag.x!, p.y - st.drag.y!) * st.cam.k < 4) return;
        st.moved = true;
        st.drag.fx = p.x;
        st.drag.fy = p.y;
        st.sim?.alphaTarget(0.12);
        if (st.sim && st.sim.alpha() < 0.12) st.sim.alpha(0.12);
        st.settling = true;
        st.userCam = true;
      } else if (st.pan) {
        const dx = e.clientX - st.pan.x;
        const dy = e.clientY - st.pan.y;
        if (!st.moved && Math.abs(dx) + Math.abs(dy) <= (e.pointerType === 'touch' ? 8 : 3)) return;
        st.moved = true;
        st.userCam = true;
        st.cam.x = st.pan.cx + dx;
        st.cam.y = st.pan.cy + dy;
      } else if (e.pointerType === 'mouse') {
        const n = hitTest(e.clientX, e.clientY, false);
        if (n !== st.hover) {
          st.hover = n;
          canvas.style.cursor = n ? 'pointer' : 'grab';
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      const had = st.pointers.delete(e.pointerId);
      if (st.pinch) {
        if (st.pointers.size < 2) st.pinch = null;
        // The finger left on the screen carries on panning from here.
        if (st.pointers.size === 1) {
          const [p] = [...st.pointers.values()];
          st.pan = { x: p.x, y: p.y, cx: st.cam.x, cy: st.cam.y };
        }
        return;
      }
      if (!had) return;
      const clicked = !st.moved && e.type === 'pointerup' ? hitTest(e.clientX, e.clientY, e.pointerType !== 'mouse') : null;
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
      } else if (wasPan && !st.moved && e.type === 'pointerup') propsRef.current.onBackground();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      st.camTarget = null;
      st.userCam = true;
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left - centerX();
      const my = e.clientY - r.top - centerY();
      const { x, y, k } = st.cam;
      const nk = Math.min(st.kFit * 25, Math.max(st.kFit * 0.4, k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
      st.cam = { k: nk, x: mx - ((mx - x) * nk) / k, y: my - ((my - y) * nk) / k };
    };
    const onLeave = () => {
      st.hover = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
        raf = timer = 0;
      } else {
        last = performance.now();
        schedule();
      }
    };
    // Buttons: zoom about the centre, and fit everything back in view.
    zoomRef.current = (f: number) => {
      const { x, y, k } = st.cam;
      const nk = Math.min(st.kFit * 25, Math.max(st.kFit * 0.4, k * f));
      st.camTarget = { k: nk, x: (x * nk) / k, y: (y * nk) / k };
      st.userCam = true;
    };
    fitRef.current = () => {
      st.refit = true;
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
      clearTimeout(timer);
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

  // Forget hidden islands that no longer exist.
  useEffect(() => {
    const live = new Set(islands.map((i) => islandGroup(i.id)));
    setHidden((h) => {
      const stale = [...h].filter((g) => g.startsWith('isl:') && !live.has(g));
      if (!stale.length) return h;
      const next = new Set(h);
      for (const g of stale) next.delete(g);
      return next;
    });
  }, [islands]);

  // Hiding or showing a region re-frames what is left.
  const firstHidden = useRef(true);
  useEffect(() => {
    if (firstHidden.current) firstHidden.current = false;
    else s.current.refit = true;
  }, [hidden]);

  // Fly to the selected thought (and keep it visible beside the panel).
  useEffect(() => {
    const st = s.current;
    if (!props.selected) return;
    const n = st.byId.get(props.selected);
    if (!n || n.x == null) return;
    const k = Math.max(st.cam.k, st.kFit * 2.2);
    st.camTarget = { k, x: -n.x * k, y: -n.y! * k };
    st.userCam = true;
  }, [props.selected, props.data]);

  const submitFilter = () => {
    const q = s.current.filter;
    if (!q) return;
    const hit = s.current.nodes
      .filter((n) => n.name.toLowerCase().includes(q) && !s.current.hidden.has(n.group))
      .sort((a, b) => Number(a.name.toLowerCase() !== q) - Number(b.name.toLowerCase() !== q) || b.degree - a.degree)[0];
    if (hit) {
      if (hit.unresolved) props.onSelectUnresolved(hit.name);
      else props.onSelect(hit.id);
    }
  };
  const toggle = (k: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  /** Show only this region or island. */
  const solo = (k: string) =>
    setHidden(
      new Set(
        [
          ...REGIONS.filter((r) => regionCounts[r.key] > 0).map((r) => r.key as string),
          ...islands.filter((i) => (islandCounts.get(i.id) ?? 0) > 0).map((i) => islandGroup(i.id)),
        ].filter((x) => x !== k),
      ),
    );

  const total = props.data ? props.data.nodes.filter((n) => !n.unresolved).length : 0;
  const freeRight = `calc(${props.rightInset * 100}% + 12px)`;

  return (
    <div className="brain" ref={wrapRef}>
      <canvas ref={canvasRef} />
      <div className="atlas-tools brain-tools" style={{ right: freeRight }}>
        <button className="atlas-tool" aria-label="Zoom in" title="Zoom in" onClick={() => zoomRef.current(1.5)}>
          ＋
        </button>
        <button className="atlas-tool" aria-label="Zoom out" title="Zoom out" onClick={() => zoomRef.current(1 / 1.5)}>
          −
        </button>
        <button className="atlas-tool" aria-label="Show everything" title="Show everything" onClick={() => fitRef.current()}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
        </button>
      </div>
      {total > 0 && (
        <div className="atlas-dock" style={{ right: freeRight }}>
          <label className={`atlas-find${filter ? ' active' : ''}`}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              aria-label="Search the mind"
              placeholder="Search the mind…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitFilter();
                if (e.key === 'Escape') setFilter('');
              }}
            />
          </label>
          {/* Floats above the row, so its appearing never shifts the pills under a finger mid double-tap. */}
          {hidden.size > 0 && (
            <button className="atlas-pill all atlas-showall" onClick={() => setHidden(new Set())}>
              Show all
            </button>
          )}
          <div className="atlas-regions" role="group" aria-label="Regions: tap to hide or show, double-tap to show only one">
            {REGIONS.filter((r) => regionCounts[r.key] > 0 || hidden.has(r.key)).map((r) => (
              <button
                key={r.key}
                className={`atlas-pill${hidden.has(r.key) ? ' off' : ''}`}
                style={{ ['--region' as string]: r.color }}
                title={`${r.name} (${r.subtitle}): tap to hide or show, double-tap to show only this`}
                aria-pressed={!hidden.has(r.key)}
                onClick={() => toggle(r.key)}
                onDoubleClick={() => solo(r.key)}
              >
                <i aria-hidden="true" />
                {r.name}
                <em>{regionCounts[r.key]}</em>
              </button>
            ))}
            {islands
              .filter((i) => (islandCounts.get(i.id) ?? 0) > 0 || hidden.has(islandGroup(i.id)))
              .map((i) => {
                const g = islandGroup(i.id);
                return (
                  <button
                    key={g}
                    className={`atlas-pill island${hidden.has(g) ? ' off' : ''}`}
                    style={{ ['--region' as string]: i.color }}
                    title={`${i.name} (island: ${i.folder}): tap to hide or show, double-tap to show only this`}
                    aria-pressed={!hidden.has(g)}
                    onClick={() => toggle(g)}
                    onDoubleClick={() => solo(g)}
                  >
                    <i aria-hidden="true" />
                    {i.name}
                    <em>{islandCounts.get(i.id)}</em>
                  </button>
                );
              })}
          </div>
        </div>
      )}
      {props.data && total === 0 && <div className="brain-empty">Your mind is empty. Create a note to spark the first thought.</div>}
    </div>
  );
}
