import type { GraphNode } from './api';

export type RegionKey = 'frontal' | 'parietal' | 'temporal' | 'occipital' | 'cerebellum' | 'stem';

export interface Region {
  key: RegionKey;
  label: string;
  short: string;
  subtitle: string;
  /** Muted display colour. */
  color: string;
  /** RGB triple of `color`, for building rgba() strings. */
  rgb: [number, number, number];
  /** Anatomical centre in brain space (x = left, y = superior, z = anterior), in units of brain radius. */
  center: [number, number, number];
}

export const REGIONS: Region[] = [
  { key: 'frontal', label: 'Frontal', short: 'FRO', subtitle: 'Projects · Decisions', color: '#dccaa0', rgb: [220, 202, 160], center: [0, 0.32, 0.78] },
  { key: 'parietal', label: 'Parietal', short: 'PAR', subtitle: 'Concepts · Tools', color: '#c3cbb2', rgb: [195, 203, 178], center: [0, 0.62, -0.12] },
  { key: 'temporal', label: 'Temporal', short: 'TEM', subtitle: 'People · Orgs', color: '#ebdcbc', rgb: [235, 220, 188], center: [0.55, -0.22, 0.2] },
  { key: 'occipital', label: 'Occipital', short: 'OCC', subtitle: 'Sources · Reading', color: '#b8c0cd', rgb: [184, 192, 205], center: [0, 0.12, -0.88] },
  { key: 'cerebellum', label: 'Cerebellum', short: 'CER', subtitle: 'Daily · Logs', color: '#e2c590', rgb: [226, 197, 144], center: [0, -0.5, -0.66] },
  { key: 'stem', label: 'Brain Stem', short: 'STM', subtitle: 'Index · Routing', color: '#d5d6de', rgb: [213, 214, 222], center: [0, -0.86, -0.18] },
];

export const REGION_BY_KEY = Object.fromEntries(REGIONS.map((r) => [r.key, r])) as Record<RegionKey, Region>;

// Folder names, tags and frontmatter values that map to each region.
const RULES: [RegionKey, RegExp][] = [
  ['stem', /^(home|index|readme|start here|mocs?|maps?( of content)?|hubs?|dashboards?|inbox|unsorted|routing)$/],
  ['cerebellum', /^(journals?|daily|dailies|daily notes|logs?|incidents?|meetings?|standups?|diary|calendar|archives?|periodic)$/],
  ['temporal', /^(people|persons?|contacts?|orgs?|organi[sz]ations?|compan(y|ies)|teams?|family|friends|clients?|customers?|crm)$/],
  ['occipital', /^(sources?|repos?|repositories|reading|books?|articles?|papers?|references?|resources?|links?|bookmarks?|media|videos?|podcasts?|courses?|literature|clippings?)$/],
  ['frontal', /^(projects?|current projects|decisions?|goals?|plans?|planning|tasks?|todos?|okrs?|roadmaps?|areas?)$/],
  ['parietal', /^(concepts?|tools?|ideas?|knowledge|topics?|notes|zettels?|zettelkasten|permanent|wiki|tech|skills?|evergreen)$/],
];

function normalize(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/^\d+\s*[-_.)]?\s*/, '') // "00 - Current Projects" -> "current projects"
    .trim();
}

function match(segment: string): RegionKey | null {
  const s = normalize(segment);
  if (!s) return null;
  for (const [key, re] of RULES) if (re.test(s)) return key;
  return null;
}

/**
 * Decide which brain region a note belongs to. Order of precedence:
 * frontmatter `region`, home/index notes, folder names, tags, date-like names,
 * and finally parietal (general knowledge).
 */
export function classify(node: Pick<GraphNode, 'id' | 'name' | 'tags'> & { region?: string }): RegionKey {
  if (node.region) {
    const r = node.region.toLowerCase().replace(/\s+/g, '');
    const direct = REGIONS.find((x) => x.key === r || x.label.toLowerCase().replace(/\s+/g, '') === r || x.short.toLowerCase() === r);
    if (direct) return direct.key;
  }
  const parts = node.id.replace(/\.md$/i, '').split('/');
  const folders = parts.slice(0, -1);
  if (folders.length === 0 && RULES[0][1].test(normalize(node.name))) return 'stem';
  for (const f of folders) {
    const m = match(f);
    if (m) return m;
  }
  for (const t of node.tags) {
    const m = match(t) ?? match(t.split('/')[0]);
    if (m) return m;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(node.name)) return 'cerebellum';
  return 'parietal';
}
