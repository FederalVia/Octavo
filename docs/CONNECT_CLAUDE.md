# Connecting Claude

Ultron Mind includes an [MCP](https://modelcontextprotocol.io) server. Once it's connected, Claude can search, read and write your vault. That gives Claude a long-term memory you can see and edit.

There are two ways to connect:

| Transport | How it runs | Use it for |
| --- | --- | --- |
| **stdio** | Claude starts `ultron mcp` itself. Nothing else needs to be running. | Claude Code and Claude Desktop on the same computer as the vault |
| **HTTP** | Connects to `http://…/mcp` on a running Ultron Mind (web, desktop app or Docker) | Remote servers, or several clients sharing one vault |

Both can be used at the same time on the same vault. The web app shows changes from either one live.

> Before you start, follow the [installation guide](INSTALL.md) as far as `npm run build`. The commands below use the absolute path to your clone. Replace `/path/to/ultron-mind` and the vault path with your own.

---

## Claude Code

### Local (stdio)

```bash
claude mcp add ultron-mind --scope user -- \
  node /path/to/ultron-mind/packages/server/dist/cli.js mcp --vault ~/UltronMind
```

`--scope user` makes the memory available in every project. Leave it out to add it only to the current project.

### Over HTTP

While `npm start`, the desktop app or Docker is running:

```bash
# Local server, no token
claude mcp add --transport http ultron-mind http://127.0.0.1:4321/mcp

# Remote server with a token
claude mcp add --transport http ultron-mind https://mind.example.com/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

Check the connection with `claude mcp list`, or run `/mcp` inside Claude Code.

---

## Claude Desktop

Open the config file. In Claude Desktop, go to **Settings → Developer → Edit Config**, or open it directly:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add an `ultron-mind` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "ultron-mind": {
      "command": "node",
      "args": [
        "/path/to/ultron-mind/packages/server/dist/cli.js",
        "mcp",
        "--vault",
        "/Users/you/UltronMind"
      ]
    }
  }
}
```

On Windows, use paths like `"C:\\Users\\you\\ultron-mind\\packages\\server\\dist\\cli.js"`. JSON needs doubled backslashes.

Restart Claude Desktop. The tools appear under the tools (🔨) menu.

**Shortcut:** the desktop app's **File → Connect Claude…** menu copies this config with your paths already filled in. It uses the Electron runtime, so Node.js doesn't even need to be on your `PATH`.

---

## Remote and cloud Claude

For Claude running somewhere else (another machine, or a cloud session), run Ultron Mind as a server it can reach:

1. Self-host it with a token and HTTPS. See [Docker](INSTALL.md#5-self-hosting-with-docker) and [HTTPS](INSTALL.md#6-accessing-it-from-other-devices-https).
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
- never store secrets (passwords, API keys) in the vault

To reinforce this, you can add a line to your own `CLAUDE.md` or system prompt, for example:

> Use the ultron-mind tools as your long-term memory: check it before answering questions about me or my projects, and save anything worth remembering.

---

## Tool reference

| Tool | What it does | Writes? |
| --- | --- | --- |
| `get_vault_overview` | Note count, folders, top tags, recently updated notes and the home note | |
| `search_notes` | Full-text search with `"phrases"`, `tag:` and `path:` filters; returns matching lines | |
| `read_note` | Full content plus outgoing links and backlinks | |
| `list_notes` | Notes in a folder and/or with a tag, newest first | |
| `get_backlinks` | Notes linking to a note, with the linking lines | |
| `get_related` | Related notes via links, backlinks, shared tags and two-step links | |
| `list_tags` | All tags with counts | |
| `list_tasks` | Tasks (`- [ ] …`) across the vault, or in one note, with line numbers | |
| `write_note` | Create a note or replace its content (`create_only` to never overwrite) | ✓ |
| `append_to_note` | Append to the end, or under a heading (created if missing) | ✓ |
| `edit_note` | Replace an exact snippet of text | ✓ |
| `rename_note` | Rename or move; updates every link to it | ✓ |
| `delete_note` | Move to `.trash` (recoverable) | ✓ |
| `update_task` | Tick, untick or set a task's status (`x`, `-`, `?`…) by note and line | ✓ |
| `log_to_journal` | Add a timestamped entry to today's journal note | ✓ |

Note paths are relative to the vault (`Projects/Ultron.md`). The `.md` extension is optional, and a bare name like `Ultron` resolves the same way a wikilink does.

### Read-only mode

Start the server with `--read-only` (for either `serve` or `mcp`) to expose only the read tools. This is useful when you want Claude to consult your notes without changing them:

```bash
claude mcp add ultron-mind-ro -- node /path/to/ultron-mind/packages/server/dist/cli.js mcp --vault ~/UltronMind --read-only
```

---

## Troubleshooting

- **The tools don't show up.** Run the command from the config yourself, e.g. `node /path/to/.../cli.js mcp --vault ~/UltronMind`. It should print `MCP server (stdio) ready` to stderr and then wait. If it errors, fix that first. Often the path is wrong, or `npm run build` hasn't been run.
- **`node: command not found` in Claude Desktop.** Desktop apps don't always see your shell's `PATH`. Use the full path to node (`which node` on macOS/Linux, `where node` on Windows) as `"command"`.
- **HTTP connection gets 401.** The token is missing or wrong. Check the `Authorization: Bearer …` header.
- **HTTP connection gets 403 "Host not allowed".** You're connecting to a server without a token using a hostname other than `localhost`/`127.0.0.1`. Set a token on the server.
