import { useEffect, useRef, useState } from 'react';
import type { GraphData, GraphNode } from '../api';
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

/** What a note belongs to for colour, visibility and link batches: one of the six regions, or an island
 *  (`island:<id>`, a part of the vault kept apart from the brain). */
type Group = RegionKey | `island:${string}`;

interface ANode {
  id: string;
  name: string;
  /** Underlying region (an island note keeps one too, but its group wins). */
  region: RegionKey;
  group: Group;
  /** Colour of the group. */
  rgb: [number, number, number];
  degree: number;
  unresolved: boolean;
  hub: boolean;
  /** World position (x = left, y = superior, z = anterior). */
  x: number;
  y: number;
  z: number;
  phase: number;
  firedAt: number;
  /** Unresolved only: the note it floats beside. */
  anchor?: string;
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
  /** Touches a note linked to a large share of the vault (an index or home): drawn faintly. */
  mega?: boolean;
  /** From or to a note marked #surprise: always highlighted. */
  surprise?: boolean;
  /** Between an island and anything outside it: crosses open space, so drawn very faintly. */
  cross?: boolean;
}

/** An island as drawn: a small cloud of its own beside the brain. */
interface IslandView {
  id: string;
  group: Group;
  name: string;
  color: string;
  rgb: [number, number, number];
  count: number;
}

interface Layout {
  nodes: ANode[];
  links: ALink[];
  byId: Map<string, ANode>;
  neighbors: Map<string, Set<string>>;
  adjacency: Map<string, ALink[]>;
  counts: Record<RegionKey, number>;
  /** Notes per island group. */
  islandCounts: Record<string, number>;
  /** Islands with notes, in the dock's order. */
  islands: IslandView[];
  /** Every group with its colour: the six regions, then the islands (one link batch each). */
  groups: { key: Group; rgb: [number, number, number] }[];
  /** Brain radius in world units. */
  R: number;
  dust: [number, number, number][];
  /** Faint dust around each island, giving it an outline of its own. */
  islandDust: [number, number, number][];
  /** Links in a stable random order: drawing the first N gives an even sample when there are too many. */
  sampled: ALink[];
  /** Degree of about the 8th busiest note: in crowded vaults only notes at least this busy keep a halo. */
  topHubCut: number;
  /** Size and territories the notes were placed in: kept across small updates so existing notes stay put. */
  geo: Geometry;
  /** Notes added, removed or moved to another region since `geo` was computed. */
  drift: number;
}

type RegionDef = (typeof REGIONS)[number];

/** The brain's size and each region's territory, fixed when the layout was last built from scratch. */
interface Geometry {
  /** Brain radius in world units. */
  R: number;
  present: RegionDef[];
  weight: Record<RegionKey, number>;
  /** Where each island floats (ids of islands that have notes, sorted, joined: a different set means a new layout). */
  islandKey: string;
  islands: Map<string, IslandGeo>;
  /** Island sizes the islands were placed for (to re-place them when the view's shape changes). */
  islandSizes: { id: string; count: number }[];
  /** Beside the brain (wide views) or below it (tall views). */
  mode: IslandMode;
  /** Farthest any island reaches from the vertical axis through the brain's centre (0 without islands). */
  reach: number;
  /** Height the camera looks at and turns around by default (0 unless islands sit below the brain). */
  homeY: number;
  /** Half the height of brain and islands together, measured from homeY (below mode only). */
  halfSpan: number;
}

/** Where islands float: on a ring beside the brain (wide views), or below it (tall views, e.g. a phone held upright). */
type IslandMode = 'ring' | 'below';

interface IslandGeo {
  x: number;
  y: number;
  z: number;
  /** Radius of the island's cloud. */
  r: number;
}

/** "#rrggbb" (or "#rgb") to an RGB triple; a neutral grey when it can't be read. */
function hexRgb(hex: string): [number, number, number] {
  let h = (hex ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, (c) => c + c);
  if (!/^[0-9a-f]{6}$/i.test(h)) return [200, 196, 188];
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** The initial camera yaw: the brain seen from its left side, front to the left. */
const START_YAW = -Math.PI / 2 + 0.38;

/**
 * Where islands float: on a ring around the brain in its horizontal plane, outside its silhouette with clear
 * space in between. One island sits to the right of the brain as first seen, a second to the left; more are
 * spread evenly around. Each cloud's radius grows with the square root of its note count.
 */
type IslandPlacement = Pick<Geometry, 'islands' | 'reach' | 'homeY' | 'halfSpan'>;

function placeIslands(R: number, sizes: { id: string; count: number }[], mode: IslandMode): IslandPlacement {
  const islands = new Map<string, IslandGeo>();
  if (!sizes.length) return { islands, reach: 0, homeY: 0, halfSpan: 0 };
  const gap = R * 0.32;
  const k = sizes.length;
  const radii = sizes.map((s) => Math.min(R * 0.62, Math.max(R * 0.13, R * 0.056 * Math.sqrt(s.count))));
  if (mode === 'below') return placeBelow(R, sizes, radii, gap);
  // Screen-right at the start is the direction (cos yaw, 0, sin yaw) in world space.
  const angles = sizes.map((_, i) => START_YAW + (k === 2 ? i * Math.PI : (i * 2 * Math.PI) / k));
  // Distance from the centre to the brain's edge in that direction (the dust silhouette's ellipse).
  const edge = (a: number) => 1 / Math.sqrt((Math.cos(a) / (R * 0.97)) ** 2 + (Math.sin(a) / (R * 1.32)) ** 2);
  const dist = angles.map((a, i) => edge(a) + gap + radii[i]);
  // Neighbours on the ring must not touch: push the whole ring out until they're apart.
  if (k > 1) {
    for (let iter = 0; iter < 40; iter++) {
      let ok = true;
      for (let i = 0; i < k; i++) {
        const j = (i + 1) % k;
        const ax = Math.cos(angles[i]) * dist[i];
        const az = Math.sin(angles[i]) * dist[i];
        const bx = Math.cos(angles[j]) * dist[j];
        const bz = Math.sin(angles[j]) * dist[j];
        if (Math.hypot(ax - bx, az - bz) < radii[i] + radii[j] + gap) ok = false;
      }
      if (ok) break;
      for (let i = 0; i < k; i++) dist[i] *= 1.06;
    }
  }
  let reach = 0;
  sizes.forEach((s, i) => {
    islands.set(s.id, { x: Math.cos(angles[i]) * dist[i], y: R * 0.05, z: Math.sin(angles[i]) * dist[i], r: radii[i] });
    reach = Math.max(reach, dist[i] + radii[i]);
  });
  return { islands, reach, homeY: 0, halfSpan: 0 };
}

/**
 * Tall views: islands float below the brain, centred on the vertical axis it turns around, so they stay below
 * it from every side. Several sit side by side on a small ring (two: left and right as first seen). The camera
 * then aims at the middle of brain and islands together.
 */
function placeBelow(R: number, sizes: { id: string; count: number }[], radii: number[], gap: number): IslandPlacement {
  const islands = new Map<string, IslandGeo>();
  const k = sizes.length;
  const rMax = Math.max(...radii);
  let ring = 0;
  if (k > 1) {
    for (let i = 0; i < k; i++) ring = Math.max(ring, (radii[i] + radii[(i + 1) % k] + gap * 0.6) / (2 * Math.sin(Math.PI / k)));
  }
  // The brain's underside (the notes reach about 0.88R, its dust a little further).
  const y = -(R * 0.98 + gap + rMax);
  sizes.forEach((s, i) => {
    const a = START_YAW + (k === 2 ? i * Math.PI : (i * 2 * Math.PI) / k);
    islands.set(s.id, { x: k > 1 ? Math.cos(a) * ring : 0, y, z: k > 1 ? Math.sin(a) * ring : 0, r: radii[i] });
  });
  const top = R * 1.0;
  const bottom = y - rMax;
  return { islands, reach: ring + rMax, homeY: (top + bottom) / 2, halfSpan: (top - bottom) / 2 };
}

/** Move the islands to where `mode` puts them (the view changed shape), carrying their notes and dust along. */
function relocateIslands(L: Layout, mode: IslandMode) {
  const geo = L.geo;
  const next = placeIslands(geo.R, geo.islandSizes, mode);
  const shift = new Map<string, [number, number, number]>();
  for (const [id, g] of next.islands) {
    const old = geo.islands.get(id);
    if (old) shift.set(`island:${id}`, [g.x - old.x, g.y - old.y, g.z - old.z]);
  }
  for (const n of L.nodes) {
    const d = shift.get(n.group);
    if (!d) continue;
    n.x += d[0];
    n.y += d[1];
    n.z += d[2];
  }
  Object.assign(geo, next, { mode });
  L.islandDust = makeIslandDust(geo.islands);
}

/**
 * Arrange an island's notes inside its cloud: the busiest notes nearest the centre (each note keeps a fixed
 * distance from it, by rank), then a few rounds pull linked notes together and push crowded ones apart.
 */
function arrangeIsland(members: ANode[], geo: IslandGeo, links: Map<string, string[]>) {
  const n = members.length;
  if (!n) return;
  const ranked = [...members].sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1));
  const radial = new Map<ANode, number>();
  const pos = new Map<ANode, [number, number, number]>();
  ranked.forEach((m, i) => {
    const rnd = seeded(m.id + '#island');
    const f = Math.cbrt((i + 0.5) / n);
    const d = geo.r * (n === 1 ? 0 : 0.1 + 0.9 * f) * (0.92 + rnd() * 0.16);
    radial.set(m, d);
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    pos.set(m, [s * Math.cos(th) * d, u * d, s * Math.sin(th) * d]);
  });
  const byId = new Map(members.map((m) => [m.id, m]));
  const spacing = (geo.r * 1.5) / Math.cbrt(n);
  const iters = n <= 400 ? 40 : 10;
  const repel = n <= 400;
  for (let it = 0; it < iters; it++) {
    const step = 1 - it / iters;
    const move = new Map<ANode, [number, number, number]>();
    for (const m of members) {
      const p = pos.get(m)!;
      const mv: [number, number, number] = [0, 0, 0];
      for (const id of links.get(m.id) ?? []) {
        const o = byId.get(id);
        if (!o || o === m) continue;
        const q = pos.get(o)!;
        mv[0] += (q[0] - p[0]) * 0.06;
        mv[1] += (q[1] - p[1]) * 0.06;
        mv[2] += (q[2] - p[2]) * 0.06;
      }
      if (repel) {
        for (const o of members) {
          if (o === m) continue;
          const q = pos.get(o)!;
          const dx = p[0] - q[0];
          const dy = p[1] - q[1];
          const dz = p[2] - q[2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
          if (d >= spacing * 1.6) continue;
          const push = ((spacing * 1.6 - d) / d) * 0.12;
          mv[0] += dx * push;
          mv[1] += dy * push;
          mv[2] += dz * push;
        }
      }
      move.set(m, mv);
    }
    for (const m of members) {
      const p = pos.get(m)!;
      const mv = move.get(m)!;
      const x = p[0] + mv[0] * step;
      const y = p[1] + mv[1] * step;
      const z = p[2] + mv[2] * step;
      // Back to its own distance from the centre: hubs stay central, the cloud stays round.
      const len = Math.sqrt(x * x + y * y + z * z) || 1;
      const d = radial.get(m)!;
      pos.set(m, [(x / len) * d, (y / len) * d, (z / len) * d]);
    }
  }
  for (const m of members) {
    const p = pos.get(m)!;
    m.x = geo.x + p[0];
    m.y = geo.y + p[1];
    m.z = geo.z + p[2];
  }
}

/** A new note joining an island that's already laid out: beside the notes it links to there, or a random spot. */
function placeInIsland(m: ANode, geo: IslandGeo, near: ANode[]) {
  const rnd = seeded(m.id + '#island');
  if (near.length) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const o of near) (x += o.x), (y += o.y), (z += o.z);
    const j = geo.r * 0.18;
    m.x = x / near.length + (rnd() - 0.5) * j;
    m.y = y / near.length + (rnd() - 0.5) * j;
    m.z = z / near.length + (rnd() - 0.5) * j;
    return;
  }
  const u = rnd() * 2 - 1;
  const th = rnd() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  const d = geo.r * (0.4 + 0.6 * rnd());
  m.x = geo.x + s * Math.cos(th) * d;
  m.y = geo.y + u * d;
  m.z = geo.z + s * Math.sin(th) * d;
}

/** Faint dust in a shell around each island. */
function makeIslandDust(islands: Map<string, IslandGeo>): [number, number, number][] {
  const dust: [number, number, number][] = [];
  for (const [id, g] of islands) {
    const rnd = seeded('dust:' + id);
    const count = Math.round(Math.min(260, 50 + g.r * 0.9));
    for (let i = 0; i < count; i++) {
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const d = g.r * (0.8 + rnd() * 0.42) + 8;
      dust.push([g.x + s * Math.cos(th) * d, g.y + u * d, g.z + s * Math.sin(th) * d]);
    }
  }
  return dust;
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

function makeGeometry(counts: Record<RegionKey, number>, total: number, islandSizes: { id: string; count: number }[], mode: IslandMode): Geometry {
  // The brain grows slowly with the vault; notes fill its whole volume (see territory below).
  const R = Math.max(240, 150 + Math.cbrt(total) * 26);
  // Territories: each region owns the part of the brain nearest its anatomical centre, weighted by how
  // many notes it holds (a power diagram), so a region with 800 notes spreads over far more of the
  // brain than one with 50, and regions border each other instead of piling up in the middle.
  const present = REGIONS.filter((r) => counts[r.key] > 0);
  const weight = Object.fromEntries(
    REGIONS.map((r) => [r.key, counts[r.key] ? Math.cbrt(counts[r.key] / total) * R * 0.9 : -Infinity]),
  ) as Record<RegionKey, number>;
  return { R, present, weight, islandKey: islandSizes.map((s) => s.id).join('\n'), islandSizes, mode, ...placeIslands(R, islandSizes, mode) };
}

/** The region whose territory holds this point. */
function owner(geo: Geometry, x: number, y: number, z: number): RegionKey {
  const { R, present, weight } = geo;
  let best: RegionKey = present[0]?.key ?? 'parietal';
  let bestScore = -Infinity;
  for (const r of present) {
    const dx = x - r.center[0] * R * 0.75;
    const dy = y - r.center[1] * R * 0.75;
    const dz = z - r.center[2] * R * 0.75;
    const score = weight[r.key] * weight[r.key] - (dx * dx + dy * dy + dz * dz);
    if (score > bestScore) (bestScore = score), (best = r.key);
  }
  return best;
}

/** A random point inside the brain-shaped ellipsoid (same shape as the dust silhouette). */
function inBrain(R: number, rnd: () => number): [number, number, number] {
  for (let i = 0; i < 30; i++) {
    const x = (rnd() * 2 - 1) * R * 0.92;
    const y = (rnd() * 2 - 1) * R * 0.88;
    const z = (rnd() * 2 - 1) * R * 1.22;
    const e = (x / (R * 0.92)) ** 2 + (y / (R * 0.88)) ** 2 + (z / (R * 1.22)) ** 2;
    if (e <= 1 && !(y < -R * 0.6 && Math.abs(x) > R * 0.45)) return [x, y, z];
  }
  return [0, 0, 0];
}

/** Where a note sits: a random spot in its region's territory, the same on every reload. */
function placeNote(id: string, region: RegionKey, geo: Geometry): { x: number; y: number; z: number; phase: number } {
  const { R } = geo;
  const def = REGION_BY_KEY[region];
  const rnd = seeded(id);
  // Rejection sampling; falls back near the region's centre.
  let pos: [number, number, number] | null = null;
  for (let i = 0; i < 80 && !pos; i++) {
    const p = inBrain(R, rnd);
    if (owner(geo, p[0], p[1], p[2]) === region) pos = p;
  }
  if (!pos) {
    const j = () => (rnd() - 0.5) * R * 0.25;
    pos = [def.center[0] * R * 0.75 + j(), def.center[1] * R * 0.75 + j(), def.center[2] * R * 0.75 + j()];
  }
  return { x: pos[0], y: pos[1], z: pos[2], phase: rnd() * Math.PI * 2 };
}

/** Faint dust filling a brain-shaped ellipsoid gives the silhouette. */
function makeDust(R: number): [number, number, number][] {
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
  return dust;
}

/** A fixed hash of a note id (FNV-1a). */
function idHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A fixed pseudo-random rank per link, from its notes' id hashes, so the sample drawn in crowded vaults doesn't
 *  reshuffle on every edit. */
function linkRank(a: number, b: number): number {
  let h = Math.imul(a ^ Math.imul(b, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Lay out the graph. Given the previous layout, notes that already existed keep their place and only new notes
 * (or ones that moved to another region) are placed, in the same territories: an edit costs one pass over the
 * lists instead of re-placing every note, and the brain doesn't shift under you. After many changes the
 * territories are recomputed and everything is placed from scratch.
 */
function buildLayout(data: GraphData, prev: Layout | null = null, mode: IslandMode = 'ring'): Layout {
  // Islands: only ids the graph defines count; a note naming an unknown island stays in its region.
  const islandDefs = new Map((data.islands ?? []).map((i) => [i.id, i]));
  const islandOf = (n: GraphNode) => (n.island && islandDefs.has(n.island) ? n.island : undefined);
  const regionOf = new Map<string, RegionKey>();
  for (const n of data.nodes) if (!n.unresolved) regionOf.set(n.id, classify(n));
  // Unresolved targets join the region of whoever links to them.
  for (const l of data.links) {
    if (!regionOf.has(l.target) && regionOf.has(l.source)) regionOf.set(l.target, regionOf.get(l.source)!);
  }

  const groupOf = new Map<string, Group>();
  const counts = Object.fromEntries(REGIONS.map((r) => [r.key, 0])) as Record<RegionKey, number>;
  const islandCounts: Record<string, number> = {};
  for (const n of data.nodes) {
    if (n.unresolved) continue;
    const isl = islandOf(n);
    if (isl) {
      const g: Group = `island:${isl}`;
      groupOf.set(n.id, g);
      islandCounts[g] = (islandCounts[g] ?? 0) + 1;
    } else {
      const r = regionOf.get(n.id) ?? 'parietal';
      groupOf.set(n.id, r);
      counts[r]++;
    }
  }
  // The brain's size and territories come from the notes in it: islands float outside and don't count.
  const total = Math.max(1, Object.values(counts).reduce((a, b) => a + b, 0));
  const allNotes = total + Object.values(islandCounts).reduce((a, b) => a + b, 0);
  const islandSizes = (data.islands ?? [])
    .filter((i) => islandCounts[`island:${i.id}`])
    .map((i) => ({ id: i.id, count: islandCounts[`island:${i.id}`] }));
  const islandKey = islandSizes.map((s) => s.id).join('\n');

  // Keep the previous territories unless too much has changed since they were computed.
  let geo: Geometry | null = prev?.geo ?? null;
  let drift = prev?.drift ?? 0;
  if (prev && geo) {
    let kept = 0;
    let changed = 0;
    for (const n of data.nodes) {
      if (n.unresolved) continue;
      const old = prev.byId.get(n.id);
      if (old && !old.unresolved && old.group === groupOf.get(n.id)) kept++;
      else changed++;
    }
    let prevNotes = 0;
    for (const n of prev.nodes) if (!n.unresolved) prevNotes++;
    drift += changed + (prevNotes - kept);
    const g = geo;
    // A region that had no notes has no territory yet; an island added or removed moves the others.
    const newRegion = REGIONS.some((r) => counts[r.key] > 0 && !g.present.includes(r));
    if (newRegion || g.islandKey !== islandKey || drift > Math.max(25, allNotes * 0.1)) geo = null;
  }
  const reuse = prev && geo ? prev : null;
  if (!geo) {
    geo = makeGeometry(counts, total, islandSizes, mode);
    drift = 0;
  }
  const R = geo.R;

  // Hubs: the most connected notes get a lens glint.
  const degrees = data.nodes.filter((n) => !n.unresolved).map((n) => n.degree).sort((a, b) => b - a);
  const hubCut = Math.max(5, degrees[Math.floor(degrees.length * 0.04)] ?? 5);

  const surprising = new Set(data.nodes.filter((n) => n.surprise).map((n) => n.id));
  // Index-like notes linked to a big share of the vault: their hundreds of lines would drown everything else.
  const megaCut = Math.max(30, allNotes * 0.05);

  const islandRgb = new Map<string, [number, number, number]>();
  for (const i of data.islands ?? []) islandRgb.set(`island:${i.id}`, hexRgb(i.color));
  const rgbOf = (g: Group) => islandRgb.get(g) ?? REGION_BY_KEY[g as RegionKey].rgb;

  const nodes: ANode[] = [];
  const byId = new Map<string, ANode>();
  /** Island notes still to be placed, per island. */
  const unplaced = new Map<string, ANode[]>();
  for (const n of data.nodes) {
    if (n.unresolved) continue;
    const region = regionOf.get(n.id) ?? 'parietal';
    const group = groupOf.get(n.id)!;
    const isl = islandOf(n);
    const old = prev?.byId.get(n.id);
    const keep = reuse && old && !old.unresolved && old.group === group;
    // Already placed in these territories (or this island): stay put. Otherwise a random spot in its region's
    // territory; island notes are placed below, once all of them are known.
    const pos = keep ? old : isl ? { x: 0, y: 0, z: 0, phase: seeded(n.id)() * Math.PI * 2 } : placeNote(n.id, region, geo);
    const node: ANode = {
      id: n.id,
      name: n.name,
      region,
      group,
      rgb: rgbOf(group),
      degree: n.degree,
      unresolved: false,
      hub: n.degree >= hubCut,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      phase: pos.phase,
      firedAt: old?.firedAt ?? -1e9,
      sx: 0,
      sy: 0,
      depth: 0,
      scale: 1,
      visible: true,
    };
    nodes.push(node);
    byId.set(n.id, node);
    if (isl && !keep) {
      let list = unplaced.get(isl);
      if (!list) unplaced.set(isl, (list = []));
      list.push(node);
    }
  }
  if (unplaced.size) {
    // Links inside each island, to keep linked notes together.
    const inside = new Map<string, string[]>();
    for (const l of data.links) {
      const a = byId.get(l.source);
      const b = byId.get(l.target);
      if (!a || !b || a === b || a.group !== b.group || !a.group.startsWith('island:')) continue;
      let la = inside.get(a.id);
      if (!la) inside.set(a.id, (la = []));
      la.push(b.id);
      let lb = inside.get(b.id);
      if (!lb) inside.set(b.id, (lb = []));
      lb.push(a.id);
    }
    for (const [isl, list] of unplaced) {
      const g = geo.islands.get(isl);
      if (!g) continue;
      if (!reuse) arrangeIsland(list, g, inside);
      else {
        // An island that's already laid out: new notes go beside those they link to.
        const placed = new Set(list);
        for (const m of list) {
          const near = (inside.get(m.id) ?? []).map((id) => byId.get(id)!).filter((o) => o && !placed.has(o));
          placeInIsland(m, g, near);
          placed.delete(m);
        }
      }
    }
  }
  // Unresolved: faint points floating just outside the note that (first) mentions them. A note in the brain is
  // preferred over an island note, so a name only islands mention floats by its island and no other.
  const firstSource = new Map<string, string>();
  for (const l of data.links) {
    const cur = firstSource.get(l.target);
    if (cur === undefined) firstSource.set(l.target, l.source);
    else if (byId.get(cur)?.group.startsWith('island:') && byId.has(l.source) && !byId.get(l.source)!.group.startsWith('island:')) {
      firstSource.set(l.target, l.source);
    }
  }
  for (const n of data.nodes) {
    if (!n.unresolved) continue;
    const source = firstSource.get(n.id);
    const anchor = source ? byId.get(source) : undefined;
    if (!anchor) continue;
    const old = prev?.byId.get(n.id);
    let pos: { x: number; y: number; z: number; phase: number };
    // Kept while the same note still anchors it; otherwise it moves next to its new anchor.
    if (reuse && old?.unresolved && old.anchor === source) pos = old;
    else {
      const rnd = seeded(n.id);
      pos = {
        x: anchor.x + (rnd() - 0.5) * 50,
        y: anchor.y + (rnd() - 0.5) * 50,
        z: anchor.z + (rnd() - 0.5) * 50,
        phase: rnd() * Math.PI * 2,
      };
    }
    const node: ANode = {
      ...anchor,
      id: n.id,
      name: n.name,
      degree: n.degree,
      unresolved: true,
      hub: false,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      phase: pos.phase,
      firedAt: old?.firedAt ?? -1e9,
      anchor: source,
    };
    nodes.push(node);
    byId.set(n.id, node);
  }

  const links: ALink[] = [];
  const neighbors = new Map<string, Set<string>>();
  const adjacency = new Map<string, ALink[]>();
  const connect = (x: ANode, y: ANode, link: ALink) => {
    let near = neighbors.get(x.id);
    if (!near) neighbors.set(x.id, (near = new Set()));
    near.add(y.id);
    let adj = adjacency.get(x.id);
    if (!adj) adjacency.set(x.id, (adj = []));
    adj.push(link);
  };
  const hash = new Map<ANode, number>();
  const hashOf = (n: ANode) => {
    let h = hash.get(n);
    if (h === undefined) hash.set(n, (h = idHash(n.id)));
    return h;
  };
  const ranks: number[] = [];
  for (const l of data.links) {
    const a = byId.get(l.source);
    const b = byId.get(l.target);
    if (!a || !b) continue;
    const link: ALink = { a, b, mega: a.degree >= megaCut || b.degree >= megaCut, surprise: surprising.has(a.id) || surprising.has(b.id) };
    if (a.group !== b.group && (a.group.startsWith('island:') || b.group.startsWith('island:'))) link.cross = true;
    links.push(link);
    ranks.push(linkRank(hashOf(a), hashOf(b)));
    connect(a, b, link);
    connect(b, a, link);
  }

  const dust = reuse ? reuse.dust : makeDust(R);
  const islandDust = reuse ? reuse.islandDust : makeIslandDust(geo.islands);

  // A random but stable order: an edit adds or drops its own links without reshuffling the rest of the sample.
  // Each key packs the link's rank above its index, so a plain numeric sort (no comparator) orders them.
  let sampled: ALink[];
  if (links.length < 2 ** 21) {
    const keys = new Float64Array(links.length);
    for (let i = 0; i < links.length; i++) keys[i] = ranks[i] * 2 ** 21 + i;
    keys.sort();
    sampled = Array.from(keys, (k) => links[k % 2 ** 21]);
  } else {
    sampled = Array.from(links.keys())
      .sort((i, j) => ranks[i] - ranks[j])
      .map((i) => links[i]);
  }
  const topHubCut = degrees[Math.min(degrees.length - 1, 7)] ?? Infinity;
  const islands: IslandView[] = islandSizes.map((s) => {
    const def = islandDefs.get(s.id)!;
    const group: Group = `island:${s.id}`;
    return { id: s.id, group, name: def.name, color: def.color, rgb: rgbOf(group), count: s.count };
  });
  const groups = [...REGIONS.map((r) => ({ key: r.key as Group, rgb: r.rgb })), ...islands.map((i) => ({ key: i.group, rgb: i.rgb }))];
  return { nodes, links, byId, neighbors, adjacency, counts, islandCounts, islands, groups, R, dust, islandDust, sampled, topHubCut, geo, drift };
}

/** Camera distance for perspective: further back when islands float around the brain, so one swinging towards
 *  you doesn't balloon. Exactly the old distance without islands. */
function viewDistance(L: Layout): number {
  return Math.max(L.R * 3.4, L.geo.mode === 'ring' ? L.geo.reach * 2.4 : 0);
}

/** Pixels per world unit at zoom 1: the brain fills the view; with islands, they fit across it too. */
function fitZoom(w: number, h: number, L: Layout | null): number {
  const R = L?.R ?? 300;
  const brain = (Math.min(w, h) * 0.5) / (R * 1.25);
  if (!L || !L.islands.length) return brain;
  if (L.geo.mode === 'below') {
    // Islands below: the brain keeps its width; brain and islands together share the height.
    return Math.min(brain, (w * 0.5) / (Math.max(R * 1.25, L.geo.reach * 1.1)), (h * 0.5) / (L.geo.halfSpan * 1.1));
  }
  // Islands sit in the brain's horizontal plane, so they need width; height still only needs the brain.
  return Math.min(brain, (w * 0.5) / (L.geo.reach * 1.12), (h * 0.5) / (R * 1.25));
}

/** How long a note that isn't laid out yet stays waiting to light up. */
const PENDING_FIRE_MS = 15_000;

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
function loadPrefs(): { labels: boolean; hidden: string[]; trail: boolean; bridges: boolean } {
  try {
    return { labels: true, hidden: [], trail: true, bridges: false, ...JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') };
  } catch {
    return { labels: true, hidden: [], trail: true, bridges: false };
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
  // The same note reported again moments later (a new note, by its event and once the graph has it): one step.
  if (last?.id !== id && trail.some((x) => x.id === id && now - x.t < 3000)) return;
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
  // Hidden groups: region keys, and `island:<id>` for islands (no region key contains a colon).
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(loadPrefs().hidden));
  const [showTrail, setShowTrail] = useState(() => loadPrefs().trail);
  const [bridges, setBridges] = useState(() => loadPrefs().bridges);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ labels, hidden: [...hidden], trail: showTrail, bridges }));
    } catch {
      /* ignore */
    }
  }, [labels, hidden, showTrail, bridges]);

  // The layout on screen (for the legend's counts and flying to the selection). Built from props.data below.
  const [layout, setLayout] = useState<Layout | null>(null);

  const st = useRef({
    layout: null as Layout | null,
    /** Newer graph data waiting for the drag to end. */
    pending: null as GraphData | null,
    /** Notes asked to light up before the layout has them (a note Claude just created or renamed: its event
     *  arrives before the graph refresh that adds it). Fired as soon as a layout with them is swapped in. */
    pendingFires: [] as { id: string; t: number }[],
    fire: (_id: string) => {},
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
    pinch: null as null | { d: number; zoom: number; mx: number; my: number; tx: number; ty: number; tz: number },
    moved: false,
    hover: null as ANode | null,
    labels: true,
    showTrail: true,
    bridges: false,
    hidden: new Set<string>(),
    filter: '',
    rings: [] as { node: ANode; start: number }[],
    pulses: [] as { link: ALink; from: ANode; t: number }[],
    W: 0,
    H: 0,
    /** The camera's default height (see Geometry.homeY) last applied; NaN before the first layout. */
    homeY: NaN,
    baseZoom: 1,
    dpr: 1,
  });
  st.current.labels = labels;
  st.current.showTrail = showTrail;
  st.current.bridges = bridges;
  st.current.hidden = hidden;
  st.current.filter = filter.trim().toLowerCase();

  // Lay out new graph data, building on the layout on screen so existing notes keep their place (and their
  // firing state). Not mid-drag: even a cheap update would hitch the rotation, and a full re-layout would move
  // notes under the pointer. Data that arrives while dragging waits for the release, and newer data replaces it.
  useEffect(() => {
    const s = st.current;
    const data = props.data;
    if (!data) return;
    const apply = () => {
      const box = wrapRef.current?.getBoundingClientRect();
      const next = buildLayout(data, s.layout, box && box.height > box.width ? 'below' : 'ring');
      s.layout = next;
      s.pending = null;
      s.rings = s.rings.filter((r) => next.byId.has(r.node.id)).map((r) => ({ ...r, node: next.byId.get(r.node.id)! }));
      s.pulses = [];
      if (s.hover) s.hover = next.byId.get(s.hover.id) ?? null;
      // Light up waiting notes the new layout has; keep the rest a while (the graph may not include them yet).
      const now = performance.now();
      const waiting = s.pendingFires;
      s.pendingFires = [];
      for (const f of waiting) {
        if (next.byId.has(f.id)) s.fire(f.id);
        else if (now - f.t < PENDING_FIRE_MS) s.pendingFires.push(f);
      }
      setLayout(next);
      s.kick();
    };
    const busy = () => !!s.drag || s.pointers.size > 0;
    if (!s.layout || !busy()) {
      apply();
      return;
    }
    s.pending = data;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    const tryApply = () => {
      if (busy()) return;
      stop();
      apply();
    };
    // The canvas's own pointerup handler runs first (the event bubbles here), then this checks it ended the drag.
    const onUp = () => {
      clearTimeout(timer);
      timer = setTimeout(tryApply);
    };
    // In case a pointer's release never reaches us (lost capture, window switch): check now and then too.
    const poll = setInterval(tryApply, 1000);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return stop;
  }, [props.data]);

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
    let maxQuality = -1;
    let frameMs = 0;
    let slowFrames = 0;
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
      const D = s.layout ? viewDistance(s.layout) : 300 * 3.4;
      const persp = D / (D - z2);
      const k = persp * zoom * s.baseZoom;
      out[0] = cx() + x1 * k;
      out[1] = cy() - y2 * k;
      out[2] = -z2; // larger = farther
      out[3] = k;
    };

    const visibleNode = (n: ANode) => !s.hidden.has(n.group);
    const nodeSize = (n: ANode) => (n.unresolved ? 1.1 : 1.5 + Math.sqrt(n.degree) * 0.75);

    const fire = (id: string) => {
      const n = s.layout?.byId.get(id);
      if (!n) {
        // Not laid out yet (a new note): light it up as soon as a layout has it.
        const t = performance.now();
        s.pendingFires = s.pendingFires.filter((f) => f.id !== id && t - f.t < PENDING_FIRE_MS).slice(-299);
        s.pendingFires.push({ id, t });
        return;
      }
      // Asked twice at once (a new note, by its own event and again once the graph has it): one ripple is enough.
      if (performance.now() - n.firedAt < 300) return;
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
      s.camGoal = { tx: 0, ty: s.layout?.geo.homeY ?? 0, tz: 0, zoom: 1 };
      s.lastInteract = performance.now();
      kick();
    };
    const visit = (id: string) => {
      addToTrail(id);
      fire(id);
    };
    s.fire = fire;
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
      const best = coarse ? (n > 400 ? 1 : 2) : n > 1500 ? 1 : 2;
      if (best !== maxQuality) quality = best; // a different size class (or the first frame): start at its best
      maxQuality = best;
      if (quality > maxQuality) quality = maxQuality;
      const autoRotate = !coarse && n <= 800;
      const wobble = quality === 2 && n <= 600;
      const R = L?.R ?? 300;
      if (L) {
        // Tall views put islands below the brain, wide ones beside it: re-place them when the shape changes.
        const mode: IslandMode = H > W ? 'below' : 'ring';
        if (L.islands.length && L.geo.mode !== mode) relocateIslands(L, mode);
        // The default view aims between brain and islands: follow it when that point moves.
        const homeY = L.geo.homeY;
        if (homeY !== s.homeY) {
          const atHome = !Number.isNaN(s.homeY) && Math.abs(s.cam.ty - s.homeY) < 1 && !s.cam.tx && !s.cam.tz;
          if (Number.isNaN(s.homeY)) s.cam.ty = homeY;
          else if (!propsRef.current.selected && (atHome || s.camGoal)) {
            const g = s.camGoal ?? s.cam;
            s.camGoal = { tx: g.tx, ty: g.ty === s.homeY ? homeY : g.ty, tz: g.tz, zoom: g.zoom };
            if (atHome) s.camGoal.ty = homeY;
          }
          s.homeY = homeY;
        }
      }
      s.baseZoom = fitZoom(W * (1 - propsRef.current.rightInset), H, L);

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
      // Each island's own faint outline.
      const islandDustCount = quality === 2 ? L.islandDust.length : quality === 1 ? Math.ceil(L.islandDust.length / 3) : 0;
      const islandStep = quality === 1 ? 3 : 1;
      for (let di = 0; di < islandDustCount * islandStep && di < L.islandDust.length; di += islandStep) {
        const d = L.islandDust[di];
        project(d[0], d[1], d[2], tmp);
        const fog = 1 - Math.min(1, Math.max(0, (tmp[2] + R) / (2.4 * R)));
        ctx.globalAlpha = 0.07 + fog * 0.2;
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
      // path for that (about 15× cheaper than thinner or scaled lines). The same lines are drawn whether or
      // not the brain is being dragged, so nothing brightens when the drag ends.
      const linkCap = quality === 2 ? 20000 : quality === 1 ? 8000 : 3000;
      const linkList = L.links.length > linkCap ? L.sampled : L.links;
      const drawn = Math.min(linkList.length, linkCap);
      const boostAlpha = Math.min(2.5, Math.sqrt(L.links.length / Math.max(1, drawn)));
      const k = s.dpr;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Plain (not additive) lines: overlapping bundles don't flare up into white.
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = 1;
      const baseAlpha = (focusNode || filterOn ? 0.025 : 0.07) * (1.15 / Math.max(1, k * 0.6)) * (drawn < L.links.length ? 0.9 * boostAlpha : 1);
      const lineAlpha = Math.min(0.5, baseAlpha * Math.max(1, k * 0.6));
      if (quality === 0) {
        // Minimal quality: one neutral batch.
        ctx.strokeStyle = `rgba(200, 196, 188, ${lineAlpha})`;
        ctx.beginPath();
        for (let li = 0; li < drawn; li++) {
          const l = linkList[li];
          if (l.cross || !l.a.visible || !l.b.visible) continue;
          ctx.moveTo(l.a.sx * k, l.a.sy * k);
          ctx.lineTo(l.b.sx * k, l.b.sy * k);
        }
        ctx.stroke();
      } else {
        // Lines take a tint of the region (or island) they start in: one batch per colour.
        // Lines to index-like hubs go in a much fainter pass (all of them show when the hub is hovered or open),
        // and so do lines between an island and the rest (they cross open space).
        const showBridges = s.bridges;
        for (const reg of L.groups) {
          ctx.strokeStyle = `rgba(${reg.rgb.join(',')}, ${Math.min(0.55, lineAlpha * (showBridges ? 0.45 : 1.35))})`;
          ctx.beginPath();
          for (let li = 0; li < drawn; li++) {
            const l = linkList[li];
            if (l.mega || l.surprise || l.cross || l.a.group !== reg.key || !l.a.visible || !l.b.visible) continue;
            if (showBridges && l.a.group !== l.b.group && l.a.group !== 'stem' && l.b.group !== 'stem') continue;
            ctx.moveTo(l.a.sx * k, l.a.sy * k);
            ctx.lineTo(l.b.sx * k, l.b.sy * k);
          }
          ctx.stroke();
        }
        if (showBridges) {
          // Links between regions, in the colour of where they start, much brighter.
          for (const reg of REGIONS) {
            // Hub notes link everywhere by design; those aren't bridges, so they stay dim.
            if (reg.key === 'stem') continue;
            ctx.strokeStyle = `rgba(${reg.rgb.join(',')}, ${Math.min(0.75, Math.max(0.28, lineAlpha * 4))})`;
            ctx.beginPath();
            for (const l of L.links) {
              if (l.mega || l.surprise || l.cross || l.a.group !== reg.key || l.b.group === reg.key || l.b.group === 'stem' || !l.a.visible || !l.b.visible) continue;
              ctx.moveTo(l.a.sx * k, l.a.sy * k);
              ctx.lineTo(l.b.sx * k, l.b.sy * k);
            }
            ctx.stroke();
          }
        }
        // Links from notes marked #surprise: always highlighted.
        ctx.strokeStyle = 'rgba(255, 244, 214, 0.55)';
        ctx.lineWidth = Math.max(1, k);
        ctx.setLineDash([4 * k, 3 * k]);
        ctx.beginPath();
        for (const l of L.links) {
          if (!l.surprise || !l.a.visible || !l.b.visible) continue;
          ctx.moveTo(l.a.sx * k, l.a.sy * k);
          ctx.lineTo(l.b.sx * k, l.b.sy * k);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        {
          ctx.strokeStyle = `rgba(200, 196, 188, ${Math.min(0.12, lineAlpha * 0.22)})`;
          ctx.beginPath();
          for (let li = 0; li < drawn; li++) {
            const l = linkList[li];
            if (!l.mega || l.cross || !l.a.visible || !l.b.visible) continue;
            ctx.moveTo(l.a.sx * k, l.a.sy * k);
            ctx.lineTo(l.b.sx * k, l.b.sy * k);
          }
          ctx.stroke();
        }
        if (L.islands.length) {
          // Between an island and the rest: barely there, so no bright bridge spans the gap.
          ctx.strokeStyle = `rgba(200, 196, 188, ${Math.min(0.05, lineAlpha * 0.28)})`;
          ctx.beginPath();
          for (let li = 0; li < drawn; li++) {
            const l = linkList[li];
            if (!l.cross || l.surprise || !l.a.visible || !l.b.visible) continue;
            ctx.moveTo(l.a.sx * k, l.a.sy * k);
            ctx.lineTo(l.b.sx * k, l.b.sy * k);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
      ctx.globalCompositeOperation = 'lighter';
      if (focusNode && focusNode.visible) {
        const rgb = focusNode.rgb.join(',');
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
          const rgb = n.rgb.join(',');
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
        ctx.drawImage(softDot(p.from.rgb), x - 7, y - 7, 14, 14);
      }
      ctx.globalAlpha = 1;

      // Neurons, far to near. Crowded regions get dimmer halos so they don't wash out.
      const densityDim: Record<string, number> = {};
      for (const r of REGIONS) densityDim[r.key] = Math.min(0.8, 9 / Math.pow(Math.max(1, L.counts[r.key]), 0.55));
      for (const i of L.islands) densityDim[i.group] = Math.min(0.8, 9 / Math.pow(Math.max(1, i.count), 0.55));
      // Small vaults get bigger, brighter points so the colours read; big ones stay fine-grained.
      const count = L.nodes.length;
      const sizeBoost = (count < 150 ? 1.6 : count < 600 ? 1.25 : count < 1500 ? 0.85 : 0.62) * (W < 600 && count > 300 ? 0.75 : 1);
      // In crowded vaults, halos everywhere add up to a white blob: keep them for notes that matter.
      const crowded = count > 800;
      const margin = 40;
      const order = L.nodes
        .filter((n) => n.visible && n.sx > -margin && n.sy > -margin && n.sx < W + margin && n.sy < H + margin)
        .sort((a, b) => b.depth - a.depth);
      for (const n of order) {
        const reg = n;
        const fog = fogOf(n);
        let alpha = 0.35 + fog * 0.65;
        const isFocus = n === focusNode || n.id === selectedId;
        if (focusNode && !isFocus && !near?.has(n.id)) alpha *= 0.3;
        if (filterOn) alpha *= matches(n) ? 1.3 : 0.12;
        if (n.unresolved) alpha *= 0.4;
        const fireAge = Math.max(0, (now - n.firedAt) / 1000);
        const boost = fireAge < 1.5 ? 1 - fireAge / 1.5 : 0;
        const r = nodeSize(n) * sizeBoost * Math.max(0.55, n.scale / s.baseZoom) * (isFocus ? 1.6 : 1) * (1 + boost);
        const density = densityDim[n.group];
        // Halos: everything at full quality; at lower quality only notes that matter right now.
        // In crowded vaults only the very busiest hubs keep a halo; dozens of halos together turn white.
        const bigHub = n.hub && (!crowded || n.degree >= L.topHubCut);
        const important = bigHub || isFocus || boost > 0 || (focusNode !== null && near?.has(n.id));
        if ((quality === 2 && !crowded) || (important && (quality >= 1 || isFocus || boost > 0))) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = Math.min(1, alpha * (n.hub || isFocus || boost > 0 ? 0.9 : density));
          const glow = r * (isFocus ? 6 : bigHub ? (crowded ? 3.5 : 6) : 2.6) * (1 + boost * 1.5);
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
        ctx.strokeStyle = `rgba(${ring.node.rgb.join(',')}, ${(1 - age / 1.8) * 0.9})`;
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
      // Islands on screen: other notes' names keep clear of them (and of their captions).
      const discs: { x: number; y: number; r: number; group: Group }[] = [];
      for (const isl of L.islands) {
        const g = L.geo.islands.get(isl.id);
        if (!g || s.hidden.has(isl.group)) continue;
        project(g.x, g.y, g.z, tmp);
        discs.push({ x: tmp[0], y: tmp[1], r: g.r * tmp[3] + 10, group: isl.group });
      }
      const clearOfIslands = (n: ANode, x: number, y: number, w: number, h: number) => {
        for (const d of discs) {
          if (d.group === n.group) continue;
          const nx = Math.max(x, Math.min(d.x, x + w));
          const ny = Math.max(y, Math.min(d.y, y + h));
          if ((nx - d.x) ** 2 + (ny - d.y) ** 2 < d.r * d.r) return false;
        }
        return true;
      };
      // Each island's name, above its cloud: it reads as a place of its own.
      if (s.labels && !filterOn) {
        ctx.font = `600 12px ${SANS}`;
        ctx.textAlign = 'center';
        for (const isl of L.islands) {
          const g = L.geo.islands.get(isl.id);
          if (!g || s.hidden.has(isl.group)) continue;
          project(g.x, g.y, g.z, tmp);
          const x = tmp[0];
          const y = tmp[1] - g.r * tmp[3] - 16;
          const w = ctx.measureText(isl.name).width;
          if (x < -w || x > W + w || y < -20 || y > H + 20) continue;
          placed.push([x - w / 2 - 6, y - 10, w + 12, 20]);
          ctx.globalAlpha = focusNode ? 0.35 : 0.75;
          ctx.lineWidth = 3;
          ctx.lineJoin = 'round';
          ctx.strokeStyle = 'rgba(14,13,17,0.75)';
          ctx.strokeText(isl.name, x, y);
          ctx.fillStyle = labelColor(isl.rgb);
          ctx.fillText(isl.name, x, y);
        }
        ctx.font = `500 11.5px ${SANS}`;
        ctx.textAlign = 'left';
        ctx.globalAlpha = 1;
      }
      for (const n of labelOrder) {
        const isFocus = n === focusNode || n.id === selectedId;
        const show =
          isFocus ||
          near?.has(n.id) ||
          (filterOn && matches(n)) ||
          (s.labels && !focusNode && !filterOn && (n.hub || L.nodes.length <= 60 || (zoomed && fogOf(n) > 0.45 && !n.unresolved)));
        if (!show) continue;
        const plainHub = !isFocus && !near?.has(n.id) && !(filterOn && matches(n));
        if (plainHub && n.hub && !zoomed && L.nodes.length > 60 && hubLabels >= (W < 600 ? 6 : 12)) continue;
        const reg = n;
        const fog = fogOf(n);
        const text = n.name.length > 34 ? n.name.slice(0, 33) + '…' : n.name;
        const x = n.sx + nodeSize(n) * 2 + 6;
        const w = ctx.measureText(text).width;
        // Generous spacing so names never stack into a column.
        if (!isFocus && (!clearOfIslands(n, x - 4, n.sy - 8, w + 8, 16) || !fits(x - 8, n.sy - 12, w + 16, 24))) continue;
        if (plainHub && n.hub) hubLabels++;
        ctx.globalAlpha = isFocus ? 1 : 0.45 + fog * 0.5;
        // A dark outline keeps names readable over bright, dense regions.
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(14,13,17,0.7)';
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
      // Quality never climbs back up by itself: that made the whole brain brighten a moment after a drag.
      // It's reset to the best level when the vault changes size class (see draw).
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
        // Two fingers: pinch to zoom, move both together to slide the brain around.
        const [a, b] = [...s.pointers.values()];
        s.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: s.cam.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, tx: s.cam.tx, ty: s.cam.ty, tz: s.cam.tz };
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
    /**
     * The world-space vector from the camera target to the point drawn at screen offset (ox, oy) from the view's
     * centre, at scale k (approximate: exact on the plane through the target, ignoring perspective elsewhere).
     */
    const screenToWorld = (ox: number, oy: number, k: number) => {
      const { yaw, pitch } = s.cam;
      // Rows of the world->view rotation: screen-right and screen-up in world space.
      const cyw = Math.cos(yaw);
      const syw = Math.sin(yaw);
      const sp = Math.sin(pitch);
      const cp = Math.cos(pitch);
      return [(ox * cyw - oy * syw * sp) / k, (-oy * cp) / k, (ox * syw + oy * cyw * sp) / k];
    };
    /** Move the camera target so the scene follows a screen-space drag of (dx, dy) from a start position. */
    const panFrom = (start: { tx: number; ty: number; tz: number }, dx: number, dy: number) => {
      const v = screenToWorld(dx, dy, s.cam.zoom * s.baseZoom);
      s.cam.tx = start.tx - v[0];
      s.cam.ty = start.ty - v[1];
      s.cam.tz = start.tz - v[2];
    };
    /**
     * Zoom from `zoom0` (with the camera target at `start`) to the current zoom so that the point that was under
     * screen position (x0, y0) is now under (x1, y1): pinch and wheel zoom towards the fingers or the cursor.
     */
    const zoomAbout = (start: { tx: number; ty: number; tz: number }, zoom0: number, x0: number, y0: number, x1: number, y1: number) => {
      const r = canvas.getBoundingClientRect();
      const ox = (x: number) => x - r.left - cx();
      const oy = (y: number) => y - r.top - cy();
      const a = screenToWorld(ox(x0), oy(y0), zoom0 * s.baseZoom);
      const b = screenToWorld(ox(x1), oy(y1), s.cam.zoom * s.baseZoom);
      s.cam.tx = start.tx + a[0] - b[0];
      s.cam.ty = start.ty + a[1] - b[1];
      s.cam.tz = start.tz + a[2] - b[2];
    };
    const onMove = (e: PointerEvent) => {
      if (s.pointers.has(e.pointerId)) s.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (s.pinch && s.pointers.size === 2) {
        const [a, b] = [...s.pointers.values()];
        s.cam.zoom = Math.min(12, Math.max(0.3, (s.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / s.pinch.d));
        // The point between the fingers stays between them as they spread and move.
        zoomAbout(s.pinch, s.pinch.zoom, s.pinch.mx, s.pinch.my, (a.x + b.x) / 2, (a.y + b.y) / 2);
        s.moved = true;
        s.lastInteract = performance.now();
        kick();
        return;
      }
      if (s.drag) {
        const dx = e.clientX - s.drag.x;
        const dy = e.clientY - s.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) s.moved = true;
        s.lastInteract = performance.now();
      kick();
        if (s.drag.pan) {
          panFrom(s.drag, dx, dy);
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
      const zoom0 = s.cam.zoom;
      const start = { tx: s.cam.tx, ty: s.cam.ty, tz: s.cam.tz };
      s.cam.zoom = Math.min(12, Math.max(0.3, zoom0 * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
      // Zoom towards the cursor.
      zoomAbout(start, zoom0, e.clientX, e.clientY, e.clientX, e.clientY);
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
      const homeY = s.layout?.geo.homeY ?? 0;
      if (s.camGoal || s.cam.zoom > 1.05 || s.cam.tx || s.cam.ty !== homeY || s.cam.tz) s.camGoal = { tx: 0, ty: homeY, tz: 0, zoom: 1 };
      s.kick();
      return;
    }
    const n = layout?.byId.get(props.selected);
    if (n) s.camGoal = { tx: n.x, ty: n.y, tz: n.z, zoom: Math.max(s.cam.zoom, 1.7) };
  }, [props.selected, layout]);

  // Anything that changes the picture needs a redraw (the canvas only draws on demand).
  useEffect(() => {
    st.current.kick();
  }, [props.selected, props.rightInset, props.paused, layout, labels, hidden, filter, showTrail, bridges]);

  const toggle = (k: string) => {
    dismissTip();
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  /** Show only this region or island. */
  const solo = (k: string) =>
    setHidden(
      new Set(
        [
          // Only what has a pill: hiding an empty region would bring its pill back, switched off.
          ...REGIONS.filter((x) => (layout?.counts[x.key] ?? 0) > 0).map((x) => x.key as string),
          ...(layout?.islands.map((i) => i.group as string) ?? []),
        ].filter((x) => x !== k),
      ),
    );

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
          <span>{coarse ? 'Drag to turn the brain, pinch to zoom, two fingers to move it, tap a point to open it.' : 'Drag to turn the brain, scroll to zoom, Shift-drag to move, click a point to open it.'}</span>
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
              <label title="Brighten links that cross from one region to another, dim the rest">
                <input type="checkbox" checked={bridges} onChange={() => setBridges((b) => !b)} /> Bridges between regions
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
          {/* Floats above the row, so its appearing never shifts the pills under a finger mid double-tap. */}
          {[...hidden].some((k) => !k.startsWith('island:') || layout.islands.some((i) => i.group === k)) && (
            <button className="atlas-pill all atlas-showall" onClick={() => setHidden(new Set())}>
              Show all
            </button>
          )}
          <div className="atlas-regions" role="group" aria-label="Regions: tap to hide or show, double-tap to show only one">
            {REGIONS.filter((r) => layout.counts[r.key] > 0 || hidden.has(r.key)).map((r) => (
              <button
                key={r.key}
                className={`atlas-pill${hidden.has(r.key) ? ' off' : ''}`}
                style={{ ['--region' as string]: r.color }}
                title={`${r.name}: ${r.label} region (${r.subtitle}). Double-tap to show only this.`}
                aria-pressed={!hidden.has(r.key)}
                onClick={() => toggle(r.key)}
                onDoubleClick={() => solo(r.key)}
              >
                <i aria-hidden="true" />
                {r.name}
                <em>{layout.counts[r.key]}</em>
              </button>
            ))}
            {layout.islands.map((isl) => (
              <button
                key={isl.group}
                className={`atlas-pill island${hidden.has(isl.group) ? ' off' : ''}`}
                style={{ ['--region' as string]: isl.color }}
                title={`${isl.name}: an island, kept apart from the brain. Double-tap to show only this.`}
                aria-pressed={!hidden.has(isl.group)}
                onClick={() => toggle(isl.group)}
                onDoubleClick={() => solo(isl.group)}
              >
                <i aria-hidden="true" />
                {isl.name}
                <em>{isl.count}</em>
              </button>
            ))}
          </div>
        </div>
      )}

      {props.data && props.data.nodes.length === 0 && <div className="brain-empty">Your mind is empty. Create a note to spark the first thought.</div>}
    </div>
  );
}
