# Connecting Claude

Octavo includes an [MCP](https://modelcontextprotocol.io) server. Once it's connected, Claude can search, read and write your vault. That gives Claude a long-term memory you can see and edit.

There are two ways to connect:

| Transport | How it runs | Use it for |
| --- | --- | --- |
| **stdio** | Claude starts `octavo mcp` itself. Nothing else needs to be running. | Claude Code and Claude Desktop on the same computer as the vault |
| **HTTP** | Connects to `http://…/mcp` on a running Octavo (web, desktop app or Docker) | Remote servers, or several clients sharing one vault |

Both can be used at the same time on the same vault. The web app shows changes from either one live.

> Before you start, follow the [installation guide](INSTALL.md) as far as `npm run build`. The commands below use the absolute path to your clone. Replace `/path/to/octavo` and the vault path with your own.

---

## Claude Code

### Local (stdio)

```bash
claude mcp add octavo --scope user -- \
  node /path/to/octavo/packages/server/dist/cli.js mcp --vault ~/Octavo
```

`--scope user` makes the memory available in every project. Leave it out to add it only to the current project.

### Over HTTP

While `npm start`, the desktop app or Docker is running:

```bash
# Local server, no token
claude mcp add --transport http octavo http://127.0.0.1:4321/mcp

# Remote server with a token
claude mcp add --transport http octavo https://mind.example.com/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

Check the connection with `claude mcp list`, or run `/mcp` inside Claude Code.

---

## Claude Desktop

Open the config file. In Claude Desktop, go to **Settings → Developer → Edit Config**, or open it directly:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add an `octavo` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "octavo": {
      "command": "node",
      "args": [
        "/path/to/octavo/packages/server/dist/cli.js",
        "mcp",
        "--vault",
        "/Users/you/Octavo"
      ]
    }
  }
}
```

On Windows, use paths like `"C:\\Users\\you\\octavo\\packages\\server\\dist\\cli.js"`. JSON needs doubled backslashes.

Restart Claude Desktop. The tools appear under the tools (🔨) menu.

**Shortcut:** the desktop app's **File → Connect Claude…** menu copies this config with your paths already filled in. It uses the Electron runtime, so Node.js doesn't even need to be on your `PATH`.

If you're already using other MCP servers, add the `octavo` entry *inside* your existing `mcpServers` block, next to them, with a comma between entries. Don't paste a second `{ "mcpServers": … }` block, or the file won't parse and Claude ignores all of it.

### Separate brains

You don't have to give every chat the same memory. Each **brain** is its own vault (folder of notes), and Claude gets a separate connection for each one:

1. In the desktop app, open **Settings → Brains** (or **File → Brains → New Brain…**) and create a brain, e.g. `Work`. New brains go in `~/Octavo Brains/<name>`.
2. Click **Copy all** (or **Copy Claude setup** on one brain) and paste it into `claude_desktop_config.json`. Your original brain keeps the name `octavo`; the others are named `octavo-<name>`, e.g. `octavo-work`.
3. Restart Claude. In a chat, open the tools menu and switch on only the brains that chat should use.

Without the app, it's the same thing by hand: one entry per vault, each with its own name and `--vault` path.

```json
{
  "mcpServers": {
    "octavo": { "command": "node", "args": ["/path/to/cli.js", "mcp", "--vault", "/Users/you/Octavo"] },
    "octavo-work": { "command": "node", "args": ["/path/to/cli.js", "mcp", "--vault", "/Users/you/Octavo Brains/Work"] }
  }
}
```

---

## Remote and cloud Claude

For Claude running somewhere else (another machine, or a cloud session), run Octavo as a server it can reach:

1. Self-host it with a token and HTTPS. The easiest route is [SELF_HOSTING.md](SELF_HOSTING.md) (Docker + Tailscale on your PC). See [Docker](INSTALL.md#5-self-hosting-with-docker) and [HTTPS](INSTALL.md#6-use-it-on-your-phone-and-other-devices).
2. Point the client at `https://your-host/mcp` and send `Authorization: Bearer <token>`.
3. If a client can't send custom headers, it can put the token in the URL instead: `https://your-host/mcp?token=<token>`. Only do this over HTTPS, because URLs can end up in logs.

---

## What Claude is told

When it connects, the server gives Claude instructions to:

- call `get_vault_overview` at the start of a conversation, then search for the people, projects and topics involved
- save decisions, facts about you and your preferences, project context and lessons learned
- update existing notes rather than creating near-duplicates, and search before writing
- keep one topic per note and connect notes with `[[wikilinks]]` and `#tags`
- file notes by region: `Projects/`, `Concepts/`, `People/`, `Sources/`, `Journal/`
- keep a short session log with `log_to_journal`
- now and then, resurface an older note with `random_note`
- leave 🔒 locked notes alone: it can see they exist, but can't read, overwrite or delete them
- never store secrets (passwords, API keys) in the vault

To reinforce this, you can add a line to your own `CLAUDE.md` or system prompt, for example:

> Use the octavo tools as your long-term memory: check it before answering questions about me or my projects, and save anything worth remembering.

---

## Tool reference

| Tool | What it does | Writes? |
| --- | --- | --- |
| `get_vault_overview` | Note count, folders, top tags, recently updated notes and the home note | |
| `search_notes` | Full-text search with `"phrases"`, `tag:` and `path:` filters; returns matching lines | |
| `read_note` | Full content, its brain region (and why), outgoing links and backlinks | |
| `random_note` | Read a random note, optionally in a folder, tag or region; `favor` picks old notes (default), under-linked ones, both, or none | |
| `get_note_region` | Which brain region a note is drawn in, and why | |
| `list_notes` | Notes in a folder and/or with a tag, newest first; `since: "3d"` shows only what changed recently | |
| `get_backlinks` | Notes linking to a note, with the linking lines | |
| `get_related` | Related notes via links, backlinks, shared tags and two-step links | |
| `query_notes` | Query notes like a database: `TABLE status, due FROM "Projects" WHERE status != "done" SORT due` | |
| `read_canvas` | Cards and arrows on a `.canvas` board (or the list of canvases) | |
| `find_orphans` | Notes nothing links to, notes that link nowhere, and links to notes that don't exist | |
| `list_tags` | All tags with counts | |
| `list_tasks` | Tasks (`- [ ] …`) across the vault, or in one note, with line numbers and due dates (`📅 2026-11-10`); can filter to overdue, today, next 7 days, and by status (open to-dos by default, `[?]` questions, done, all) | |
| `write_note` | Create a note or replace its content (`create_only` to never overwrite) | ✓ |
| `append_to_note` | Append to the end, or under a heading (created if missing) | ✓ |
| `edit_note` | Replace an exact snippet of text | ✓ |
| `rename_note` | Rename or move; updates every link to it | ✓ |
| `set_note_region` | Pin one note, a list of notes or a whole folder to a region (`region:` in its properties), or back to automatic | ✓ |
| `manage_islands` | List, add or remove islands: folders kept apart from the six regions in the brain views | ✓ |
| `place_note` | Move notes to a spot in the network view, or beside another note, where they stay; unpin or clear | ✓ |
| `set_property` | Set or remove one property (frontmatter field) on a note | ✓ |
| `add_to_canvas` | Add text, note and link cards to a canvas (created if needed), connect them with labelled arrows, optionally in a group | ✓ |
| `merge_notes` | Merge one note into another; links to it are updated and it moves to `.trash` | ✓ |
| `delete_note` | Move to `.trash` (recoverable) | ✓ |
| `restore_note` | Bring a note back from `.trash` | ✓ |
| `update_task` | Tick, untick or set a task's status (`x`, `-`, `?`…) by note and line | ✓ |
| `log_to_journal` | Add a timestamped entry to today's journal note | ✓ |
| `open_periodic_note` | Read (creating if needed) today's, this week's or this month's note | ✓ |

Note paths are relative to the vault (`Projects/Octavo.md`). The `.md` extension is optional, and a bare name like `Octavo` resolves the same way a wikilink does.

### Read-only mode

Start the server with `--read-only` (for either `serve` or `mcp`) to expose only the read tools. This is useful when you want Claude to consult your notes without changing them:

```bash
claude mcp add octavo-ro -- node /path/to/octavo/packages/server/dist/cli.js mcp --vault ~/Octavo --read-only
```

---

## Troubleshooting

- **The tools don't show up.** Run the command from the config yourself, e.g. `node /path/to/.../cli.js mcp --vault ~/Octavo`. It should print `MCP server (stdio) ready` to stderr and then wait. If it errors, fix that first. Often the path is wrong, or `npm run build` hasn't been run.
- **New tools don't appear after updating Octavo.** First check which Octavo Claude is using: ask it to call `get_vault_overview`; the first line ends with the version, e.g. "(Octavo 0.3.9)". If the version is old, fully quit Claude (from the tray icon, not just the window) so it starts a fresh copy, and make sure the update installed. If the version is right but the tools are still missing, Claude is holding on to the tool list from its first connection: rename the entry in `claude_desktop_config.json` (e.g. `"octavo"` → `"octavo-memory"`) and restart Claude, which makes it fetch the full list.
- **`node: command not found` in Claude Desktop.** Desktop apps don't always see your shell's `PATH`. Use the full path to node (`which node` on macOS/Linux, `where node` on Windows) as `"command"`.
- **HTTP connection gets 401.** The token is missing or wrong. Check the `Authorization: Bearer …` header.
- **HTTP connection gets 403 "Host not allowed".** You're connecting to a server without a token using a hostname other than `localhost`/`127.0.0.1`. Set a token on the server.
