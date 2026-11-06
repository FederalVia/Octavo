import type { IndexedNote, SearchResult } from './types.js';

interface ParsedQuery {
  terms: string[];
  phrases: string[];
  tags: string[];
  paths: string[];
}

/**
 * Query syntax:
 *   word            all words must appear (in title, tags, or body)
 *   "exact phrase"  phrase must appear
 *   tag:foo / #foo  note must have the tag (prefix match on nested tags)
 *   path:Projects   note path must contain this
 */
export function parseQuery(query: string): ParsedQuery {
  const q: ParsedQuery = { terms: [], phrases: [], tags: [], paths: [] };
  const re = /"([^"]+)"|(\S+)/g;
  for (const m of query.matchAll(re)) {
    if (m[1]) {
      q.phrases.push(m[1].toLowerCase());
      continue;
    }
    const tok = m[2];
    const lower = tok.toLowerCase();
    if (lower.startsWith('tag:') && tok.length > 4) q.tags.push(lower.slice(4).replace(/^#/, ''));
    else if (lower.startsWith('#') && tok.length > 1) q.tags.push(lower.slice(1));
    else if (lower.startsWith('path:') && tok.length > 5) q.paths.push(lower.slice(5));
    else q.terms.push(lower);
  }
  return q;
}

function countOccurrences(haystack: string, needle: string, cap = 20): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1 && count < cap) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function hasTag(note: IndexedNote, tag: string): boolean {
  return note.tags.some((t) => t === tag || t.startsWith(tag + '/'));
}

function makeSnippets(content: string, needles: string[], max = 3): { line: number; text: string }[] {
  if (needles.length === 0) return [];
  const out: { line: number; text: string }[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const lower = lines[i].toLowerCase();
    const hit = needles.find((n) => lower.includes(n));
    if (!hit) continue;
    let text = lines[i].trim();
    if (text.length > 200) {
      const pos = Math.max(0, text.toLowerCase().indexOf(hit) - 80);
      text = (pos > 0 ? '…' : '') + text.slice(pos, pos + 200) + (pos + 200 < text.length ? '…' : '');
    }
    out.push({ line: i + 1, text });
  }
  return out;
}

export function searchNotes(notes: Iterable<IndexedNote>, query: string, limit = 20): SearchResult[] {
  const q = parseQuery(query);
  const needles = [...q.terms, ...q.phrases];
  const results: SearchResult[] = [];

  for (const note of notes) {
    if (q.tags.length && !q.tags.every((t) => hasTag(note, t))) continue;
    const lowerPath = note.path.toLowerCase();
    if (q.paths.length && !q.paths.every((p) => lowerPath.includes(p))) continue;

    const lowerName = note.name.toLowerCase();
    const lowerContent = note.content.toLowerCase();
    const lowerAliases = note.aliases.map((a) => a.toLowerCase());
    let score = 0;
    let ok = true;

    for (const n of needles) {
      let s = 0;
      if (lowerName === n) s += 30;
      else if (lowerName.includes(n)) s += 12;
      if (lowerAliases.some((a) => a.includes(n))) s += 8;
      if (note.tags.some((t) => t.includes(n))) s += 6;
      if (lowerPath.includes(n)) s += 2;
      s += countOccurrences(lowerContent, n);
      if (s === 0) {
        ok = false;
        break;
      }
      score += s;
    }
    if (!ok) continue;
    // Filter-only queries (e.g. "tag:project") rank by recency.
    if (needles.length === 0) score = 1;

    results.push({
      path: note.path,
      name: note.name,
      score,
      tags: note.tags,
      mtime: note.mtime,
      snippets: makeSnippets(note.content, needles),
    });
  }

  results.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return results.slice(0, limit);
}
