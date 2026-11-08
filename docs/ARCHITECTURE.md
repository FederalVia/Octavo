# Architecture

Octavo is a TypeScript monorepo (npm workspaces) with four packages:

```
┌─────────────── packages/web ───────────────┐   ┌──── packages/desktop ────┐
│ React UI: Atlas (3D canvas), Network       │   │ Electron main process:   │
│ (d3-force), CodeMirror editor, preview     │   │ starts the server        │
└──────────────┬─────────────────────────────┘   │ in-process, opens window │
               │ REST + Server-Sent Events        └────────────┬─────────────┘
┌──────────────▼──────────── packages/server ──────────────────▼─────────────┐
│ Express app: /api (REST), /api/events (SSE), /mcp (MCP over HTTP),         │
│ static web UI · `octavo mcp` (MCP over stdio) · CLI · auth & host checks  │
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
- **History**: before a note is overwritten, its previous content is saved to `.octavo/history/<path>/<timestamp>.md`. This happens at most once every 5 minutes per note, and the newest 50 versions are kept.
- **Attachments**: non-Markdown files are indexed by name, so `![[photo.png]]` resolves anywhere in the vault. `[[file.pdf]]`-style references aren't counted as links between notes.
- **Tasks**: `- [ ]`-style items (any single-character status) are found outside code blocks and can be toggled by line.
- **Islands and placements**: folders kept apart from the six regions are stored in `.octavo/islands.json`, and notes placed by hand in the network view in `.octavo/layout.json`. Both are returned with the graph.
- **Watching**: a recursive `fs.watch` with debounced per-file refreshes, plus a full rescan for directory-level changes. Refreshes compare mtime and size, so the vault's own writes don't cause duplicate events. Every change is emitted as a `VaultEvent` (`change`, `delete`, `rename`, `rescan`).

## packages/server

- `createApp()` (`src/app.ts`) builds the Express app, `startServer()` (`src/index.ts`) wires it to a vault and an HTTP listener, `src/cli.ts` is the `octavo` command, and `src/commands.ts` holds its note commands.
- **MCP** (`src/mcp.ts`) registers 28 tools and the server instructions. Over HTTP, `/mcp` uses the Streamable HTTP transport in stateless mode: each POST gets a fresh MCP server bound to the shared vault. Over stdio, `octavo mcp` connects one server to stdin/stdout and logs to stderr.
- **Starter notes** (`src/seed.ts`) are written into an empty vault on first run.
- **Backups** (`src/backup.ts`) zip the whole vault (version history optional) for `/api/backup.zip` and `octavo backup`, and make the optional daily automatic backups into `<vault> backups` next to the vault.
- **Notes from other apps** (`src/folderSync.ts`) mirror folders outside the vault into it, one way (`--watch-folder`, `octavo sync-folder`, or the desktop app's settings). PDFs and images become notes that embed them; Markdown and text files are copied. Which folders are watched can only be set on the computer itself, never over the API.
- **Terminal UI** (`src/tui.ts`) is `octavo tui`: plain ANSI escapes and raw keyboard input, no dependencies.

### REST API

All endpoints are under `/api` and need `Authorization: Bearer <token>` (or `?token=`) when a token is configured.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/vault` | `{ name, noteCount, dailyFolder, version }` |
| GET | `/api/notes?folder=&tag=` | `{ notes: NoteSummary[], folders: string[] }` |
| GET | `/api/notes/<path>` | `NoteDetail`: content, frontmatter, tags, headings, links (resolved), backlinks (with context) |
| PUT | `/api/notes/<path>` | Body `{ content, expectedMtime? }`. Creates or overwrites; `409` on conflict |
| POST | `/api/notes` | Body `{ path, content? }`. Create only; `409` if it exists |
| DELETE | `/api/notes/<path>` | Move to `.trash` |
| POST | `/api/rename` | Body `{ from, to, updateLinks? }` → `{ from, to, updatedNotes, updatedLinks }` |
| POST | `/api/merge` | Body `{ from, into }`. Merge one note into another; the first goes to `.trash` |
| GET | `/api/resolve?link=&from=` | Resolve a link target → `{ path \| null, trashed? }` (`trashed` when the note is in `.trash`) |
| POST | `/api/trash/restore` | Body `{ trashPath }`. Bring a note back from `.trash` |
| GET | `/api/search?q=&limit=` | `{ results: SearchResult[] }` |
| GET | `/api/tags` | `{ tags: { tag, count }[] }` |
| GET | `/api/graph` | `{ nodes, links, islands?, pins? }`. Nodes include `degree`, `tags`, `unresolved`, `region` |
| GET / PUT | `/api/islands` | `{ islands }` / body `{ islands }` to replace them |
| PUT | `/api/pins` | Body `{ pins }` (path → spot, or `null` to unpin) or `{ clear: true }`. Notes placed by hand in the network view |
| GET | `/api/related/<path>` | Related notes with reasons |
| POST | `/api/daily` | Create (if needed) and return today's journal note |
| POST | `/api/periodic/<day\|week\|month>?date=` | Create (if needed) and return that period's note |
| GET | `/api/files/<path-or-name>?from=` | Stream an attachment (resolved by path or bare file name, like `![[photo.png]]`) |
| POST | `/api/attachments?name=&folder=` | Upload raw bytes; saved under `attachments/` with a free name |
| GET | `/api/history/<path>` / `?id=` | List saved versions / read one |
| POST | `/api/restore` | Body `{ path, id }`. Restore a version (the current content is snapshotted first) |
| GET | `/api/mentions/<path>` | Unlinked mentions of a note |
| GET | `/api/insights` | `{ orphans, deadEnds, unresolved }` |
| GET | `/api/backup.zip?history=1` | The whole vault as a zip (`history=1` adds version history); `413` if too large |
| GET / PUT | `/api/autobackup` | Daily automatic backup status / body `{ on?, keep? }` |
| POST | `/api/autobackup/now` | Make an automatic backup now |
| GET | `/api/folder-sync` | Folders mirrored from other apps, with their status |
| POST | `/api/folder-sync/run` | Sync those folders now (folders can't be added over the API) |
| GET | `/api/publish.zip?scope=&folder=&tag=&title=` | The published website as a zip |
| GET | `/api/query?q=&lang=&from=` | Run a query (`query`, `dql` or `base`) |
| GET | `/api/canvases`, `/api/drawings` | List `.canvas` / `.excalidraw` files |
| GET / PUT | `/api/canvas/<path>`, `/api/drawing/<path>` | Read / write one. Body `{ data, expectedMtime?, createOnly? }` |
| GET | `/api/web/read?url=` | Reader-mode version of a public web page |
| POST | `/api/web/clip` | Body `{ url, folder? }`. Save a page as a note (default `Clippings/`) |
| POST | `/api/append` | Body `{ path, text, heading? }` |
| POST | `/api/property` | Body `{ path, key, value }`. Set a property (`null` removes it) |
| GET / POST | `/api/tasks` | List tasks (`?done=1` for all) / body `{ path, line, status? }` to set one |
| GET / PUT | `/api/config/<name>` | `bookmarks`, `settings`, `hotkeys`, `workspaces` or `snippets`, stored in `.octavo/<name>.json` |
| GET | `/api/snippets` | CSS snippets from `.octavo/snippets` |
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
- `markdown.ts` renders the reading view with marked plus extensions for wikilinks and embeds, `#tags`, `==highlights==`, callouts, custom task marks, `%%comments%%`, `^block` anchors, footnotes (marked-footnote) and maths (KaTeX). Output is sanitised with DOMPurify.
- `pdfEmbed.ts` draws embedded PDFs page by page as pictures (pdf.js, loaded on demand), and `drawingEmbed.ts` shows embedded `.excalidraw` drawings as pictures. Both are used by the reading view and the editor's live preview.
- `components/Preview.tsx` hydrates the rendered HTML: it transcludes embedded notes (up to 3 levels), renders Mermaid diagrams (loaded on demand), shows hover previews, and maps checkbox clicks back to source lines.
- `components/CommandPalette.tsx`, `HistoryDialog.tsx` and the drawer panels in `Panels.tsx` provide the palette, version history, bookmarks, tasks and insights.

## packages/desktop

`src/main.js` starts `startServer()` inside Electron's main process on `127.0.0.1:4321`, falling back to a random port. It then loads that URL in a sandboxed `BrowserWindow`. The renderer gets no Node integration, and external links open in the system browser. The selected vault is stored in `config.json` in Electron's `userData` folder.

## Security model

- The server **binds to 127.0.0.1** by default.
- **Without a token**, only requests with a `Host` of `localhost`, `127.0.0.1` or `::1` are accepted. This blocks DNS-rebinding attacks from websites. CORS isn't enabled, so other origins can't read responses.
- **With a token**, every `/api` and `/mcp` request needs it. Comparisons are constant-time. The CLI warns if you bind to a non-loopback address without one.
- **Paths** from clients and from Claude are normalised and confined to the vault. Absolute paths, `..` and hidden segments are rejected.
- **Rendered Markdown is sanitised**. External links open in a new tab with `noopener`.
- **Locked notes** are end-to-end encrypted by the browser (`packages/web/src/crypto.ts`):
  - AES-256-GCM, with a fresh 96-bit IV for every save and a key from PBKDF2-SHA256 (600,000 iterations, a random 128-bit salt per note).
  - The file keeps `octavo-encrypted: v1` in its frontmatter and the JSON envelope in an `octavo-encrypted` code block.
  - The core marks such notes `encrypted` and indexes nothing from them. Plain-text operations (`append`, `edit`, `setTask`) refuse them with `EncryptedNoteError` (HTTP 423), and MCP read/write/delete return a "locked" message instead.
  - The first encrypted write purges the note's plain-text history.
  - Keys live only in the tab's memory and are cleared on reload, on "Lock", or after 15 minutes idle.
  - Web Crypto is used when available. On insecure origins (a phone on plain-http Wi-Fi) the same algorithms run via `@noble/hashes` and `@noble/ciphers`, producing identical envelopes.
  - Locking is opt-in per vault (`.octavo/settings.json` → `locking`).
- **Access from Anywhere** (`packages/server/src/remote/`, `octavo serve --remote`, desktop **File → Access from Anywhere**):
  - Finds the router via UPnP (`@achingbrain/nat-port-mapper`) and reads its WAN address. It refuses CGNAT (100.64/10) and double-NAT addresses with an explanation.
  - Maps internet port 80 → a local http-01 challenge server, and 443 (falling back to 8443, then 47321) → a local HTTPS server running the same Express app.
  - Gets a Let's Encrypt **IP address certificate** using the `shortlived` profile (`acme-client`). The certificate is cached in `remote.json` (mode 600) outside the vault, renewed when under 3 days remain, and swapped in with `setSecureContext`.
  - Polls the WAN address every 5 minutes and re-issues on change (`address-changed` event → new QR code).
  - A safety check refuses to start unless the local server answers `401` without the access key. Failed keys are rate-limited per address: 10 failures → 15-minute lockout.
- **Phone access** (`octavo serve --phone`, or the desktop app's **Use on Your Phone**): listens on `0.0.0.0` with a saved random access key, stored outside the vault, and prints a QR code linking to `http://<lan-ip>:<port>/?token=…`. The web app stores the key and removes it from the URL.
