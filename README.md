# Ultron Mind

An Obsidian-like knowledge base that also works as **Claude's long-term memory**.

Notes are plain Markdown files in a folder (a *vault*), linked with `[[wikilinks]]` and `#tags`. You use the web or desktop app; Claude uses the same vault through an MCP server: it searches it at the start of a conversation, saves decisions and facts as notes, and keeps a journal. Changes from either side show up live.

## Features

- **The brain**: the home screen is a living neural network. Every note is a glowing point, every link is a connection, and signals pulse along the links. Top-level folders get their own colours, like regions of a brain. Click a point to fly to it and open its note in a slide-in panel. Scroll or pinch to zoom, drag to pan, and drag points to rearrange them. Use "Search the mind…" to highlight matches (Enter opens the best one).
- **Watch Claude think**: when Claude (or anything else) writes to a note, that point fires and sends signals to its neighbours. New notes grow into the network as they're created.
- **Editor**: Markdown with syntax highlighting, `[[` link and `#` tag autocomplete, and Ctrl/Cmd-click to follow links. Toggle between reading and editing.
- **Links**: wikilinks (`[[Note]]`, `[[Note#Heading]]`, `[[Note|label]]`), relative `[text](note.md)` links, frontmatter `aliases`, and links to notes that don't exist yet. These show as faint hollow points, and clicking one creates the note.
- **Connections** for each note (linked from, links to, tags) appear under the note.
- **Drawer** (☰) with a file tree (drag to move, right-click to rename or delete), full-text search (`"phrases"`, `tag:x`, `path:folder`) and tags.
- **Quick switcher** (Ctrl/Cmd+O) to open or create notes, and **daily journal** notes (Ctrl/Cmd+D).
- **Safe file handling**: atomic writes, conflict detection when a note changes under you (e.g. Claude edits it while you type), rename and move that rewrite every link to the note, and deletes that go to `.trash/`.
- **Live sync**: the server watches the folder, so edits from Claude, other windows or another editor (including Obsidian itself) appear immediately.
- Works in the **browser** (self-hosted, phone-friendly) and as a **desktop app** (Electron).

## Layout

```
packages/
  core/     vault engine: parsing, link index, backlinks, search, rename, file watching
  server/   REST API + web UI hosting + MCP server (HTTP and stdio) + CLI
  web/      React + CodeMirror front end
  desktop/  Electron wrapper (runs the server in-process)
```

## Quick start

Requires Node.js 20+.

```bash
npm install
npm run build
npm start -- --vault ~/UltronMind     # http://127.0.0.1:4321
```

An empty vault gets a couple of starter notes. Use `--no-seed` to skip them.

**Desktop app:**

```bash
npm run desktop                        # builds, then opens the Electron app
```

The desktop app remembers the last vault. Use **File → Open Vault Folder…** to switch, and **File → Connect Claude…** to copy ready-made MCP configs.

**Development** (hot reload):

```bash
npm run dev:server    # API on :4321, using ./vault
npm run dev:web       # Vite on :5173, proxying /api and /mcp to :4321
```

## Connecting Claude

The MCP server exposes these tools: `get_vault_overview`, `search_notes`, `read_note`, `list_notes`, `get_backlinks`, `get_related`, `list_tags`, `write_note`, `append_to_note`, `edit_note`, `rename_note`, `delete_note` and `log_to_journal`. It also sends instructions telling Claude to use the vault as its memory. Add `--read-only` to expose only the read tools.

**Claude Code** (stdio, no server needed):

```bash
claude mcp add ultron-mind -- node /path/to/ultron-mind/packages/server/dist/cli.js mcp --vault ~/UltronMind
```

…or over HTTP while `npm start` or the desktop app is running:

```bash
claude mcp add --transport http ultron-mind http://127.0.0.1:4321/mcp
```

**Claude Desktop**: add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ultron-mind": {
      "command": "node",
      "args": ["/path/to/ultron-mind/packages/server/dist/cli.js", "mcp", "--vault", "/Users/you/UltronMind"]
    }
  }
}
```

**Remote / cloud Claude sessions**: run the server somewhere reachable with a token:

```bash
ULTRON_TOKEN=$(openssl rand -hex 32) npm start -- --host 0.0.0.0 --vault /data/vault
```

Clients then send `Authorization: Bearer <token>` (or `?token=<token>`) to `/mcp` and `/api`. Put it behind HTTPS (e.g. a reverse proxy) before exposing it to the internet.

## CLI

```
ultron serve [--vault DIR] [--port 4321] [--host 127.0.0.1] [--token SECRET] [--read-only] [--daily Journal] [--no-seed]
ultron mcp   [--vault DIR] [--read-only] [--daily Journal] [--no-seed]
```

Environment variables: `ULTRON_VAULT`, `PORT`, `ULTRON_HOST`, `ULTRON_TOKEN`.

## Security notes

- Without a token, the server only accepts requests whose `Host` is `localhost`/`127.0.0.1` (this protects against DNS-rebinding attacks), and it binds to loopback by default. It warns if you bind to another address without a token.
- Note paths are confined to the vault. `..`, absolute paths and hidden folders are rejected.
- Don't store secrets in the vault: Claude is told not to.

## Tests

```bash
npm test          # core + server (includes an MCP client round-trip)
npm run typecheck
```
