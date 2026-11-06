/**
 * Canvases: boards of cards and arrows, stored as `.canvas` files in the open JSON Canvas format
 * (https://jsoncanvas.org), so they work in other apps that read it too.
 */
import path from 'node:path';
import { VaultPathError } from './paths.js';

export type CanvasColor = string; // "1"–"6" (preset palette) or "#rrggbb"
export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';

interface NodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  [extra: string]: unknown;
}

export type CanvasNode =
  | (NodeBase & { type: 'text'; text: string })
  | (NodeBase & { type: 'file'; file: string; subpath?: string })
  | (NodeBase & { type: 'link'; url: string })
  | (NodeBase & { type: 'group'; label?: string; background?: string; backgroundStyle?: 'cover' | 'ratio' | 'repeat' });

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: CanvasSide;
  fromEnd?: 'none' | 'arrow';
  toNode: string;
  toSide?: CanvasSide;
  toEnd?: 'none' | 'arrow';
  color?: CanvasColor;
  label?: string;
  [extra: string]: unknown;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [extra: string]: unknown;
}

export class CanvasFormatError extends Error {}

const SIDES = new Set(['top', 'right', 'bottom', 'left']);

/** Check and tidy canvas data (unknown fields are kept, as the format allows). */
export function validateCanvas(input: unknown): CanvasData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CanvasFormatError('A canvas is an object with "nodes" and "edges"');
  const raw = input as Record<string, unknown>;
  const nodesIn = raw.nodes ?? [];
  const edgesIn = raw.edges ?? [];
  if (!Array.isArray(nodesIn) || !Array.isArray(edgesIn)) throw new CanvasFormatError('"nodes" and "edges" must be lists');
  if (nodesIn.length > 20000 || edgesIn.length > 50000) throw new CanvasFormatError('That canvas is too large');
  const ids = new Set<string>();
  const nodes: CanvasNode[] = nodesIn.map((n, i) => {
    if (!n || typeof n !== 'object') throw new CanvasFormatError(`Node ${i + 1} isn't an object`);
    const o = n as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) throw new CanvasFormatError(`Node ${i + 1} has no id`);
    if (ids.has(o.id)) throw new CanvasFormatError(`Two nodes share the id ${o.id}`);
    ids.add(o.id);
    for (const k of ['x', 'y', 'width', 'height']) {
      if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) throw new CanvasFormatError(`Node ${o.id} needs a numeric ${k}`);
    }
    const t = o.type;
    if (t === 'text') {
      if (typeof o.text !== 'string') throw new CanvasFormatError(`Text node ${o.id} needs "text"`);
    } else if (t === 'file') {
      if (typeof o.file !== 'string' || !o.file) throw new CanvasFormatError(`File node ${o.id} needs "file"`);
    } else if (t === 'link') {
      if (typeof o.url !== 'string') throw new CanvasFormatError(`Link node ${o.id} needs "url"`);
    } else if (t !== 'group') throw new CanvasFormatError(`Node ${o.id} has an unknown type`);
    return { ...o, width: Math.max(1, o.width as number), height: Math.max(1, o.height as number) } as CanvasNode;
  });
  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  for (const [i, e] of edgesIn.entries()) {
    if (!e || typeof e !== 'object') throw new CanvasFormatError(`Edge ${i + 1} isn't an object`);
    const o = e as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id || edgeIds.has(o.id)) throw new CanvasFormatError(`Edge ${i + 1} needs a unique id`);
    if (typeof o.fromNode !== 'string' || typeof o.toNode !== 'string') throw new CanvasFormatError(`Edge ${o.id} needs fromNode and toNode`);
    if (!ids.has(o.fromNode) || !ids.has(o.toNode)) continue; // dangling edge: drop it
    for (const k of ['fromSide', 'toSide']) if (o[k] !== undefined && !SIDES.has(o[k] as string)) delete o[k];
    edgeIds.add(o.id);
    edges.push(o as CanvasEdge);
  }
  return { ...raw, nodes, edges };
}

/** Pretty JSON, tab-indented like other JSON Canvas apps write it. */
export function serializeCanvas(data: CanvasData): string {
  return JSON.stringify(data, null, '\t') + '\n';
}

/** Normalize a canvas path: vault-relative, no hidden folders, ending in `.canvas`. */
export function normalizeCanvasPath(input: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new VaultPathError('Path is empty');
  let p = input.trim().replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw new VaultPathError(`Path must be relative to the vault: ${input}`);
  const segments = path.posix.normalize(p).split('/').filter((s) => s && s !== '.');
  if (!segments.length) throw new VaultPathError('Path is empty');
  for (const s of segments) if (s === '..' || s.startsWith('.')) throw new VaultPathError(`Invalid path: ${input}`);
  p = segments.join('/');
  if (!p.toLowerCase().endsWith('.canvas')) p += '.canvas';
  return p;
}

/** Notes a canvas points at (its file cards), for backlinks. */
export function canvasFileRefs(data: CanvasData): string[] {
  return data.nodes.filter((n): n is Extract<CanvasNode, { type: 'file' }> => n.type === 'file').map((n) => n.file);
}

// ---------------------------------------------------------------------------------------------
// Drawings: Excalidraw scenes stored as `.excalidraw` files (Excalidraw's own JSON format).

export interface DrawingData {
  type: 'excalidraw';
  version: number;
  source?: string;
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
  [extra: string]: unknown;
}

export function emptyDrawing(): DrawingData {
  return { type: 'excalidraw', version: 2, source: 'octavo', elements: [], appState: { gridSize: 20 }, files: {} };
}

export function validateDrawing(input: unknown): DrawingData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CanvasFormatError('A drawing is an Excalidraw scene object');
  const o = input as Record<string, unknown>;
  if (o.type !== undefined && o.type !== 'excalidraw') throw new CanvasFormatError('That file isn’t an Excalidraw drawing');
  if (!Array.isArray(o.elements ?? [])) throw new CanvasFormatError('"elements" must be a list');
  if (o.files !== undefined && (typeof o.files !== 'object' || Array.isArray(o.files))) throw new CanvasFormatError('"files" must be an object');
  return { ...o, type: 'excalidraw', version: typeof o.version === 'number' ? o.version : 2, elements: (o.elements as unknown[]) ?? [] } as DrawingData;
}

export function normalizeDrawingPath(input: string): string {
  const p = normalizeCanvasPath(input.replace(/\.excalidraw$/i, '')).replace(/\.canvas$/i, '');
  return `${p}.excalidraw`;
}
