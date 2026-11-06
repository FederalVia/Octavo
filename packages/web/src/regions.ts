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
  /** Display colour: vivid, and distinct in lightness as well as hue so regions stay tellable apart. */
  color: string;
  /** RGB triple of `color`, for building rgba() strings. */
  rgb: [number, number, number];
  /** Anatomical centre in brain space (x = left, y = superior, z = anterior), in units of brain radius. */
  center: [number, number, number];
}

export const REGIONS: Region[] = [
  { key: 'frontal', name: 'Projects', label: 'Frontal', short: 'FRO', subtitle: 'Projects · Decisions', color: '#ff9b3d', rgb: [255, 155, 61], center: [0, 0.32, 0.78] },
  { key: 'parietal', name: 'Knowledge', label: 'Parietal', short: 'PAR', subtitle: 'Concepts · Tools', color: '#2fd9c6', rgb: [47, 217, 198], center: [0, 0.62, -0.12] },
  { key: 'temporal', name: 'People', label: 'Temporal', short: 'TEM', subtitle: 'People · Orgs', color: '#ff5c8a', rgb: [255, 92, 138], center: [0.55, -0.22, 0.2] },
  { key: 'occipital', name: 'Sources', label: 'Occipital', short: 'OCC', subtitle: 'Sources · Reading', color: '#5aa2ff', rgb: [90, 162, 255], center: [0, 0.12, -0.88] },
  { key: 'cerebellum', name: 'Journal', label: 'Cerebellum', short: 'CER', subtitle: 'Daily · Logs', color: '#d8ef4f', rgb: [216, 239, 79], center: [0, -0.5, -0.66] },
  { key: 'stem', name: 'Hubs', label: 'Brain Stem', short: 'STM', subtitle: 'Index · Routing', color: '#b79bff', rgb: [183, 155, 255], center: [0, -0.86, -0.18] },
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
