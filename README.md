# Ultron Mind

**A knowledge base you see as a brain, and that Claude uses as its long-term memory. Completely free: no accounts, no subscriptions, no paid tiers.**

Ultron Mind is an Obsidian-like note app built on plain Markdown files. Your notes appear as points in a 3D brain you can rotate, grouped into anatomical regions: projects in the frontal lobe, people in the temporal lobe, daily notes in the cerebellum, and so on. Click any point to read or edit that note.

It also includes an [MCP](https://modelcontextprotocol.io) server, so Claude can search, read and write the same notes. Claude remembers things between conversations, and you can watch it think: the notes it touches light up live.

![Atlas view: notes arranged as a 3D brain](docs/images/atlas.png)

<table>
  <tr>
    <td><img src="docs/images/note-panel.png" alt="Clicking a point opens its note" /></td>
    <td><img src="docs/images/network.png" alt="Flat network view" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Click a point to open its note</sub></td>
    <td align="center"><sub>Network view</sub></td>
  </tr>
</table>

## Features

- **Brain views**
  - **Atlas**: a 3D brain with notes grouped into six regions, a legend with counts, per-region toggles, and slow auto-rotation.
  - **Network**: a flat force-directed graph, coloured by region.
- **Markdown notes**: plain `.md` files in a folder you choose. They work with git, Obsidian and any text editor.
- **Rich writing**: callouts (including foldable ones), coloured highlights, task checkboxes with custom marks, footnotes, LaTeX maths, Mermaid diagrams, `%%comments%%`, tables, and embedded images, audio, video and PDFs (paste or drag files straight in).
- **Linking**:
  - `[[wikilinks]]` to notes, headings and blocks, and `![[embeds]]` of whole notes or parts of them
  - hover previews, backlinks, unlinked mentions, aliases and nested `#tags`
  - automatic link updates when you rename a note
- **Organise**: file tree, quick switcher (Ctrl/Cmd+O), command palette (Ctrl/Cmd+P), `/` slash commands, full-text search, bookmarks, templates, daily journal, a vault-wide task list, and orphan and dead-end finding.
- **Optional note locking**: turn it on in ⚙ Settings to password-protect individual notes with end-to-end encryption. It's off by default, and notes are never encrypted unless you lock them.
- **Safety net**: version history for every note (compare with the current version and restore), deletes go to a recoverable trash, and you get a conflict warning instead of losing your edits.
- **Claude memory over MCP**: 15 tools (search, read, write, append, edit, tasks, journal, link graph…) over stdio or HTTP. Notes Claude touches light up in the brain.
- **CLI**: `ultron new / read / append / search / daily / task / tasks / move / history …`
- **Runs anywhere**: in the browser (installable on phones), as a desktop app (Electron), or self-hosted with Docker.

See **[docs/FEATURES.md](docs/FEATURES.md)** for the full feature list and what's planned.

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer and git.

```bash
git clone https://github.com/FederalVia/ultron-mind.git
cd ultron-mind
npm install
npm run build
npm run demo          # opens the example vault at http://127.0.0.1:4321
```

Open **http://127.0.0.1:4321** in your browser and click around the brain.

To use your own notes:

```bash
npm start -- --vault ~/UltronMind    # any folder; it's created if missing
```

Prefer an app window? Run `npm run desktop`. To run it as an always-on server on your PC, reachable from your phone anywhere, see **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**.

**On your phone:** run `npm start -- --phone` (or **File → Use on Your Phone** in the desktop app) and scan the QR code. See [Use it on your phone](docs/INSTALL.md#6-use-it-on-your-phone-and-other-devices).

**Full instructions for every platform: [docs/INSTALL.md](docs/INSTALL.md)**

## Give Claude its memory

With the app built, add the vault to Claude Code:

```bash
claude mcp add ultron-mind --scope user -- node "$(pwd)/packages/server/dist/cli.js" mcp --vault ~/UltronMind
```

For Claude Desktop, remote servers and the full tool list, see **[docs/CONNECT_CLAUDE.md](docs/CONNECT_CLAUDE.md)**.

## How notes map to brain regions

Notes are placed by folder name, tag, or a `region:` value in the frontmatter:

| Region | Holds | Folders / tags like |
| --- | --- | --- |
| Frontal | Projects, decisions | `Projects`, `Decisions`, `Goals`, `Tasks`, `Areas` |
| Parietal | Concepts, tools (default) | `Concepts`, `Tools`, `Ideas`, `Notes`, `Wiki` |
| Temporal | People, organisations | `People`, `Contacts`, `Orgs`, `Companies`, `Teams` |
| Occipital | Sources, reading | `Sources`, `Repos`, `Reading`, `Books`, `Articles`, `Resources` |
| Cerebellum | Daily notes, logs | `Journal`, `Daily`, `Logs`, `Meetings`, `Incidents`, date-named notes |
| Brain stem | Index, routing | top-level `Home` / `Index` / `README`, `Inbox`, `MOCs` |

Numbered folders such as `00 - Current Projects` work too. More in the [user guide](docs/USER_GUIDE.md#brain-regions).

## Documentation

| Guide | What's in it |
| --- | --- |
| [Installation](docs/INSTALL.md) | Requirements, installing on macOS/Windows/Linux, desktop app, Docker, running as a service, HTTPS, updating, troubleshooting |
| [User guide](docs/USER_GUIDE.md) | The interface, views, writing syntax, links, search, templates, bookmarks, history, shortcuts |
| [Features](docs/FEATURES.md) | Every feature with its status: done, partly done, or planned |
| [Self-hosting](docs/SELF_HOSTING.md) | Run Ultron on your PC with Docker and reach it from your phone anywhere (Tailscale or your own domain) |
| [Connecting Claude](docs/CONNECT_CLAUDE.md) | Claude Code, Claude Desktop, remote access, tool reference, tips |
| [Architecture](docs/ARCHITECTURE.md) | How it's built, REST API, live events, file handling, security |
| [Contributing](CONTRIBUTING.md) | Development setup, tests, project layout |

## Project layout

```
packages/
  core/      Vault engine: parsing, link index, backlinks, search, rename, file watching
  server/    REST API, web hosting, MCP server (HTTP + stdio), `ultron` CLI
  web/       React + CodeMirror front end (atlas, network, editor)
  desktop/   Electron wrapper
examples/
  demo-vault/  Sample notes for trying the app
docs/          Guides and screenshots
```

## Status

Ultron Mind is at an early stage (v0.1). It works and has tests, but expect rough edges. See [docs/FEATURES.md](docs/FEATURES.md) for what's planned. In particular, packaged desktop installers (`.dmg`/`.exe`) aren't available yet, so the desktop app runs from source.
