/**
 * Brain regions: which part of the brain a note is drawn in. Shared by the app
 * (to draw the atlas) and the server (so Claude sees the same thing).
 */
export type RegionKey = 'frontal' | 'parietal' | 'temporal' | 'occipital' | 'cerebellum' | 'stem';

export const REGION_INFO: { key: RegionKey; label: string; short: string; subtitle: string }[] = [
  { key: 'frontal', label: 'Frontal', short: 'FRO', subtitle: 'Projects · Decisions' },
  { key: 'parietal', label: 'Parietal', short: 'PAR', subtitle: 'Concepts · Tools' },
  { key: 'temporal', label: 'Temporal', short: 'TEM', subtitle: 'People · Orgs' },
  { key: 'occipital', label: 'Occipital', short: 'OCC', subtitle: 'Sources · Reading' },
  { key: 'cerebellum', label: 'Cerebellum', short: 'CER', subtitle: 'Daily · Logs' },
  { key: 'stem', label: 'Brain Stem', short: 'STM', subtitle: 'Index · Routing' },
];

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
export function classifyRegion(node: { id: string; name: string; tags: string[]; region?: string }): { region: RegionKey; reason: string } {
  if (node.region) {
    const r = node.region.toLowerCase().replace(/\s+/g, '');
    const direct = REGION_INFO.find((x) => x.key === r || x.label.toLowerCase().replace(/\s+/g, '') === r || x.short.toLowerCase() === r);
    if (direct) return { region: direct.key, reason: 'set in the note’s properties (region:)' };
  }
  const parts = node.id.replace(/\.md$/i, '').split('/');
  const folders = parts.slice(0, -1);
  if (folders.length === 0 && RULES[0][1].test(normalize(node.name))) return { region: 'stem', reason: 'a home/index note' };
  for (const f of folders) {
    const m = match(f);
    if (m) return { region: m, reason: `in the “${f}” folder` };
  }
  for (const t of node.tags) {
    const m = match(t) ?? match(t.split('/')[0]);
    if (m) return { region: m, reason: `tagged #${t}` };
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(node.name)) return { region: 'cerebellum', reason: 'named after a date' };
  return { region: 'parietal', reason: 'the default for general notes' };
}
