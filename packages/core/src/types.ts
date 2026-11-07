import type { Heading, ParsedLink } from './parse.js';

export interface IndexedNote {
  /** Vault-relative POSIX path, e.g. "Projects/Octavo.md". */
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
  /** Locked note: content is an encrypted envelope only the user's browser can open. */
  encrypted: boolean;
}

export interface NoteSummary {
  path: string;
  name: string;
  folder: string;
  tags: string[];
  mtime: number;
  ctime: number;
  size: number;
  /** Present and true for locked (encrypted) notes. */
  encrypted?: boolean;
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
  /** Tagged #surprise or `surprise: true`: its links are highlighted in the atlas. */
  surprise?: boolean;
  /** Locked (encrypted) note. */
  encrypted?: boolean;
  /** Number of links in + out. */
  degree: number;
  /** Id of the island this note belongs to (see Island), drawn apart from the six regions. */
  island?: string;
}

/**
 * An island: a part of the vault kept apart from the six brain regions, like a separate subject
 * (e.g. a "Theology" folder). Its notes get their own territory and colour in the brain views.
 */
export interface Island {
  /** Stable id, derived from the name. */
  id: string;
  name: string;
  /** Notes in this folder (and its subfolders) belong to the island. */
  folder: string;
  /** "#rrggbb" */
  color: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: { source: string; target: string }[];
  /** Islands defined for this vault (empty when there are none). */
  islands?: Island[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export type VaultEvent =
  /** graphChanged: its links, tags, region or lock state changed (the graph needs refreshing). */
  | { type: 'change'; path: string; graphChanged?: boolean }
  | { type: 'delete'; path: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'rescan' }
  /** Claude (or another MCP client) read a note; the app draws it in the trail. */
  | { type: 'access'; path: string };
