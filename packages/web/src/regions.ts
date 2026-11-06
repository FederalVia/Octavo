import type { GraphNode } from './api';

import { classifyRegion, type RegionKey } from '@octavo/core/regions';

export type { RegionKey };

export interface Region {
  key: RegionKey;
  /** Everyday name shown in the app (the anatomical name is in the tooltip). */
  name: string;
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
  { key: 'frontal', name: 'Projects', label: 'Frontal', short: 'FRO', subtitle: 'Projects · Decisions', color: '#dccaa0', rgb: [220, 202, 160], center: [0, 0.32, 0.78] },
  { key: 'parietal', name: 'Knowledge', label: 'Parietal', short: 'PAR', subtitle: 'Concepts · Tools', color: '#c3cbb2', rgb: [195, 203, 178], center: [0, 0.62, -0.12] },
  { key: 'temporal', name: 'People', label: 'Temporal', short: 'TEM', subtitle: 'People · Orgs', color: '#ebdcbc', rgb: [235, 220, 188], center: [0.55, -0.22, 0.2] },
  { key: 'occipital', name: 'Sources', label: 'Occipital', short: 'OCC', subtitle: 'Sources · Reading', color: '#b8c0cd', rgb: [184, 192, 205], center: [0, 0.12, -0.88] },
  { key: 'cerebellum', name: 'Journal', label: 'Cerebellum', short: 'CER', subtitle: 'Daily · Logs', color: '#e2c590', rgb: [226, 197, 144], center: [0, -0.5, -0.66] },
  { key: 'stem', name: 'Hubs', label: 'Brain Stem', short: 'STM', subtitle: 'Index · Routing', color: '#d5d6de', rgb: [213, 214, 222], center: [0, -0.86, -0.18] },
];

export const REGION_BY_KEY = Object.fromEntries(REGIONS.map((r) => [r.key, r])) as Record<RegionKey, Region>;

/**
 * Decide which brain region a note belongs to. Order of precedence:
 * frontmatter `region`, home/index notes, folder names, tags, date-like names,
 * and finally parietal (general knowledge). Shared with the server.
 */
export function classify(node: Pick<GraphNode, 'id' | 'name' | 'tags'> & { region?: string }): RegionKey {
  return classifyRegion(node).region;
}
