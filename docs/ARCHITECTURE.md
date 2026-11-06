# Architecture

Ultron Mind is a TypeScript monorepo (npm workspaces) with four packages:

```
┌─────────────── packages/web ───────────────┐   ┌──── packages/desktop ────┐
│ React UI: Atlas (3D canvas), Network       │   │ Electron main process:   │
│ (d3-force), CodeMirror editor, preview     │   │ starts the server        │
└──────────────┬─────────────────────────────┘   │ in-process, opens window │
               │ REST + Server-Sent Events        └────────────┬─────────────┘
┌──────────────▼──────────── packages/server ──────────────────▼─────────────┐
│ Express app: /api (REST), /api/events (SSE), /mcp (MCP over HTTP),         │
│ static web UI · `ultron mcp` (MCP over stdio) · CLI · auth & host checks  │
└──────────────┬─────────────────────────────────────────────────────────────┘
┌──────────────▼──────────── packages/core ──────────────────────────────────┐
│ Vault: index of Markdown files, link resolution, backlinks, search,       │
│ rename-with-link-rewriting, journal, atomic writes, file watching         │
└──────────────┬─────────────────────────────────────────────────────────────┘
               ▼
        Vault folder on disk (plain .md files)
```

## packages/core

The `Vault` class (`src/vault.ts`) holds an in-memory index of every `.md` file in the vault folder. Hidden folders (`.git`, `.obsidian`, `.trash`) and `node_modules` are skipped.

- **Parsing** (`src/parse.ts`): YAML frontmatter, `#tags` (including frontmatter `tags`), `aliases`, headings, `[[wikilinks]]` (with `#heading`, `|alias` and `!` embeds) and relative `[text](note.md)` links. Code blocks and inline code are masked first, so links inside code are ignored. Line numbers are kept for backlink context.
- **Link resolution** follows Obsidian's rules. A bare name matches a note's file name, case-insensitively. If several notes share the name, the one in the same folder wins, then the one with the shortest path. Paths (`Folder/Note`) match by suffix. Aliases are tried last. Markdown links are resolved relative to the linking note.
- **Search** (`src/search.ts`): AND semantics over words and phrases, with `tag:` and `path:` filters. Matches score higher in the title than in aliases, tags, the path and the body, in that order. Results include snippets of the matching lines.
- **Writes are atomic**: each write goes to a hidden temp file, which is then renamed over the target. `write()` can take an `expectedMtime` and throws `NoteConflictError` if the file changed since it was read.
- **Rename** rewrites every wiki and Markdown link pointing to the note, using the pre-rename index to decide which links match. Links made through an alias are left alone, since they still resolve.
- **Delete** moves the file into `.trash/`.
- **Watching**: a recursive `fs.watch` with debounced per-file refreshes, plus a full rescan for directory-level changes. Refreshes compare mtime and size, so the vault's own writes don't cause duplicate events. Every change is emitted as a `VaultEvent` (`change`, `delete`, `rename`, `rescan`).

## packages/server

- `createApp()` (`src/app.ts`) builds the Express app, `startServer()` (`src/index.ts`) wires it to a vault and an HTTP listener, and `src/cli.ts` is the `ultron` command.
- **MCP** (`src/mcp.ts`) registers 13 tools and the server instructions. Over HTTP, `/mcp` uses the Streamable HTTP transport in stateless mode: each POST gets a fresh MCP server bound to the shared vault. Over stdio, `ultron mcp` connects one server to stdin/stdout and logs to stderr.
- **Starter notes** (`src/seed.ts`) are written into an empty vault on first run.

### REST API

All endpoints are under `/api` and need `Authorization: Bearer <token>` (or `?token=`) when a token is configured.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/vault` | `{ name, noteCount, dailyFolder }` |
| GET | `/api/notes?folder=&tag=` | `{ notes: NoteSummary[], folders: string[] }` |
| GET | `/api/notes/<path>` | `NoteDetail`: content, frontmatter, tags, headings, links (resolved), backlinks (with context) |
| PUT | `/api/notes/<path>` | Body `{ content, expectedMtime? }`. Creates or overwrites; `409` on conflict |
| POST | `/api/notes` | Body `{ path, content? }`. Create only; `409` if it exists |
| DELETE | `/api/notes/<path>` | Move to `.trash` |
| POST | `/api/rename` | Body `{ from, to, updateLinks? }` → `{ from, to, updatedNotes, updatedLinks }` |
| GET | `/api/resolve?link=&from=` | Resolve a link target → `{ path \| null }` |
| GET | `/api/search?q=&limit=` | `{ results: SearchResult[] }` |
| GET | `/api/tags` | `{ tags: { tag, count }[] }` |
| GET | `/api/graph` | `{ nodes, links }`. Nodes include `degree`, `tags`, `unresolved`, `region` |
| GET | `/api/related/<path>` | Related notes with reasons |
| POST | `/api/daily` | Create (if needed) and return today's journal note |
| GET | `/api/events` | Server-Sent Events stream of `VaultEvent`s |

Errors are JSON `{ error }` with status `400` (bad path or edit), `401`, `403` (host), `404`, `409` (conflict or exists) or `500`.

## packages/web

A Vite + React single-page app, served by the server (or by Vite in development, with requests proxied to the server).

- `App.tsx` handles routing (`#/` and `#/note/<path>`), loading and autosaving notes with conflict detection, the live-update subscription, and dialogs and shortcuts.
- `components/AtlasView.tsx` is the 3D view. It's a hand-written perspective projection on a 2D canvas, with no WebGL dependency.
  - Notes get stable positions: a seeded random point inside their region's sphere, pulled toward the centre by degree. Region centres sit at anatomical positions, scaled by the size of the largest region.
  - Links are drawn in one additive batch, which is what makes the bundles glow.
  - Labels use greedy collision avoidance.
- `components/BrainView.tsx` is the Network view: d3-force simulation on a canvas, with a pre-settled initial layout, pinch and wheel zoom, and node dragging.
- `regions.ts` holds the region definitions and the `classify()` rules shared by both views.
- `components/Editor.tsx` is CodeMirror 6 with Markdown, wikilink and tag decorations, `[[` and `#` autocomplete, and Ctrl/Cmd-click to follow links.
- `markdown.ts` renders the reading view with marked (plus wikilink and hashtag extensions), sanitised with DOMPurify.

## packages/desktop

`src/main.js` starts `startServer()` inside Electron's main process on `127.0.0.1:4321`, falling back to a random port. It then loads that URL in a sandboxed `BrowserWindow`. The renderer gets no Node integration, and external links open in the system browser. The selected vault is stored in `config.json` in Electron's `userData` folder.

## Security model

- The server **binds to 127.0.0.1** by default.
- **Without a token**, only requests with a `Host` of `localhost`, `127.0.0.1` or `::1` are accepted. This blocks DNS-rebinding attacks from websites. CORS isn't enabled, so other origins can't read responses.
- **With a token**, every `/api` and `/mcp` request needs it. Comparisons are constant-time. The CLI warns if you bind to a non-loopback address without one.
- **Paths** from clients and from Claude are normalised and confined to the vault. Absolute paths, `..` and hidden segments are rejected.
- **Rendered Markdown is sanitised**. External links open in a new tab with `noopener`.
