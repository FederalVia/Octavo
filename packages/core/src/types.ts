import type { Heading, ParsedLink } from './parse.js';

export interface IndexedNote {
  /** Vault-relative POSIX path, e.g. "Projects/Ultron.md". */
  path: string;
  /** File name without extension, used as the note title and link name. */
  name: string;
  folder: string;
  content: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  aliases: string[];
  links: ParsedLink[];
  headings: Heading[];
  mtime: number;
  ctime: number;
  size: number;
}

export interface NoteSummary {
  path: string;
  name: string;
  folder: string;
  tags: string[];
  mtime: number;
  ctime: number;
  size: number;
}

export interface LinkRef {
  /** Target as written in the note. */
  target: string;
  /** Resolved vault path, or null if the note doesn't exist yet. */
  path: string | null;
  heading?: string;
  alias?: string;
  embed: boolean;
  line: number;
}

export interface Backlink {
  path: string;
  name: string;
  /** Lines in the source note that contain the link(s). */
  context: { line: number; text: string }[];
}

export interface NoteDetail extends NoteSummary {
  content: string;
  frontmatter: Record<string, unknown>;
  aliases: string[];
  headings: Heading[];
  links: LinkRef[];
  backlinks: Backlink[];
}

export interface SearchResult {
  path: string;
  name: string;
  score: number;
  tags: string[];
  mtime: number;
  snippets: { line: number; text: string }[];
}

export interface GraphNode {
  id: string;
  name: string;
  tags: string[];
  /** True for link targets that don't exist as files yet. */
  unresolved?: boolean;
  /** Frontmatter `region` override (frontal, parietal, temporal, occipital, cerebellum, stem). */
  region?: string;
  /** Number of links in + out. */
  degree: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: { source: string; target: string }[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export type VaultEvent =
  | { type: 'change'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'rescan' };
