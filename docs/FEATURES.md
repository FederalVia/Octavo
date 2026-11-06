# Features

Status of every feature on the Ultron feature list.

**Everything in Ultron is free.** There are no paid tiers, subscriptions or accounts, and features that other apps sell, like sync and publishing, will be free here too.

✅ done · 🟡 partly done · 🚧 planned · ❌ not planned (needs a separate product or service)

How-tos for the finished features are in the [user guide](USER_GUIDE.md).

## Core

| Feature | Status | Notes |
| --- | --- | --- |
| Local-first notes as plain Markdown files | ✅ | Your vault is an ordinary folder of `.md` files |
| Works fully offline | 🟡 | The desktop app and a locally run server need no internet. A hosted server needs a connection, and there's no offline cache yet |
| No account needed | ✅ | |
| Free, no paid tiers | ✅ | Every feature, including future sync and publishing |
| Lock individual notes with a password | ✅ | Optional, off by default (⚙ Settings). End-to-end encrypted on your device (AES-256-GCM, PBKDF2 600k), including on phones over plain Wi-Fi. The server and Claude can't read locked notes. See the [user guide](USER_GUIDE.md#locked-encrypted-notes) |
| Open formats, no lock-in | ✅ | Markdown + YAML frontmatter, compatible with Obsidian |
| Mac, Windows, Linux | ✅ | Desktop app (Electron) or any browser |
| iOS and Android | 🟡 | Scan a QR code (`--phone` or desktop **File → Use on Your Phone**) and add Ultron to your home screen. Works on home Wi-Fi, or anywhere with Tailscale or your own server. No native apps |
| Multiple vaults | 🟡 | Desktop: **File → Open Vault Folder…**; server: run one per vault (`--vault`, `--port`). No in-app vault switcher yet |
| Open a single Markdown file outside a vault | 🚧 | |

## Writing

| Feature | Status | Notes |
| --- | --- | --- |
| Source mode and Reading view | ✅ | Ctrl/Cmd+E toggles |
| Live Preview (rendered while editing) | 🚧 | |
| Headings, bold, italics, strikethrough, quotes, nested lists | ✅ | |
| Task checkboxes with custom marks (`[x]`, `[-]`, `[?]`, `[!]`…) | ✅ | Click to tick in reading view |
| Tables | 🟡 | Rendered, and inserted with `/table`. No right-click sort/move/edit menu yet |
| Coloured highlights | ✅ | `==text==`, or `=={red}text==` (red, orange, yellow, green, blue, purple) |
| Callouts (`note`, `tip`, `warning`, `question`, `bug`, `todo`…) | 🟡 | All types, plus foldable (`[!tip]-` / `[!tip]+`). Callouts nested inside callouts aren't styled yet |
| Code blocks with syntax highlighting | 🟡 | Highlighted in the editor. Plain in reading view |
| Inline comments hidden in reading view | ✅ | `%%like this%%` |
| Footnotes | ✅ | `[^1]` … `[^1]: text`, or `/footnote` |
| Math (LaTeX) | ✅ | `$inline$` and `$$block$$` via KaTeX |
| Mermaid diagrams | 🟡 | Rendered (flowcharts, sequence, timelines…). Diagram nodes can't link to notes yet |
| Embed images, audio, video, PDFs; resize images | ✅ | `![[photo.png\|300]]`; paste or drag files into the editor to upload them |

## Links and knowledge

| Feature | Status | Notes |
| --- | --- | --- |
| Wikilinks and Markdown links | ✅ | |
| Link to a heading or a block | ✅ | `[[Note#Heading]]`, `[[Note#^block-id]]`, with `^block-id` at the end of a line |
| Aliases | ✅ | `aliases:` in frontmatter |
| Embed / transclude a note, heading or block | ✅ | `![[Note]]`, `![[Note#Heading]]`, `![[Note#^id]]` (nested up to 3 levels) |
| Hover preview of links | ✅ | |
| Backlinks and unlinked mentions | ✅ | Under each note: *Linked from* / *Mentioned in* |
| Outgoing links | ✅ | *Links to* under each note |
| Graph view | ✅ | Two views: 3D anatomical **Atlas** and flat **Network** |
| Outline / table of contents | ✅ | ≡ button on each note |
| Tags, including nested tags | ✅ | `#project/hooked` also matches `#project` |
| Orphan and dead-end notes | ✅ | Drawer → Insights (◇), and `ultron orphans` |

## Organisation

| Feature | Status | Notes |
| --- | --- | --- |
| File explorer with folders | ✅ | Drag to move; right-click to rename/delete |
| Quick switcher | ✅ | Ctrl/Cmd+O |
| Search by text, path, tag | ✅ | `"phrase"`, `tag:x`, `#x`, `path:folder` |
| Bookmarks | 🟡 | Notes, searches and web links. Headings can't be bookmarked yet |
| Daily notes | ✅ | Ctrl/Cmd+D |
| Templates with `{{date}}`, `{{time}}`, `{{title}}` | ✅ | Notes in `Templates/`; also `{{date:YYYY-MM-DD}}` formats. `/template` or the command palette |
| Unique note creator (timestamp titles) | ✅ | Command palette → *New unique note* |
| Properties / metadata | 🟡 | Shown as a properties table and used for tags, aliases and region. Edited as YAML; no typed property editor yet |
| Bases (database views) | 🚧 | |
| Canvas | 🚧 | |
| Workspaces (saved layouts) | 🚧 | |
| Note composer (split / merge) | 🟡 | *Extract selection to new note* works. Merging isn't built yet |
| File recovery snapshots | ✅ | ⟲ on each note: diff against the current version, restore. Kept in `.ultron/history/` |
| Rename/move updates every link | ✅ | |

## Editor and layout

| Feature | Status | Notes |
| --- | --- | --- |
| Command palette | ✅ | Ctrl/Cmd+P |
| Slash commands | ✅ | Type `/` in the editor |
| Custom hotkeys | 🚧 | |
| Tabs, split panes, pop-out windows | 🚧 | |
| Stacked tabs | 🚧 | |
| Vim keybindings | ✅ | Command palette → *Turn on Vim keybindings* |
| Web viewer | 🚧 | |
| Word and character count | ✅ | Status bar |

## Capture and media

| Feature | Status | Notes |
| --- | --- | --- |
| Random note | ✅ | Command palette |
| Audio recorder | 🚧 | |
| Slides (note → presentation) | 🚧 | |
| Web Clipper browser extension | ❌ | A separate product |
| iOS Quick Capture, Share Sheet, Siri/Shortcuts, voice capture, widgets | ❌ | Needs a native mobile app |
| Mobile PDF export | 🚧 | |
| macOS Quick Look | ❌ | Needs a native macOS extension |

## Automation

| Feature | Status | Notes |
| --- | --- | --- |
| Links that open a note | 🟡 | Every note has a URL (`…/#/note/Folder/Note.md`); command palette → *Copy link*. No custom `ultron://` scheme |
| CLI: create, read, append, search, move notes | ✅ | `ultron new / read / append / search / move` |
| CLI: daily note, add a task | ✅ | `ultron daily [text]`, `ultron task <text>` |
| CLI: list tags and tasks, toggle checkboxes | ✅ | `ultron tags`, `ultron tasks`, `ultron done <note> <line>` |
| CLI: version history and restore | ✅ | `ultron history`, `ultron restore` |
| CLI: query Bases, install plugins/themes, terminal UI | 🚧 | |
| AI access | ✅ | MCP server with 15 tools, so Claude can read, write and organise the vault |
| Headless client | 🟡 | `ultron serve` / Docker runs the vault headless with a REST API |

## Sync and publishing (free)

| Feature | Status | Notes |
| --- | --- | --- |
| Sync across devices | 🟡 | Run one server, e.g. on your PC with Docker + Tailscale ([guide](SELF_HOSTING.md)), and open it from every device. Or sync the folder with git/Syncthing |
| End-to-end encrypted sync, shared vaults, selective sync | 🚧 | Will be free and self-hostable, with no paid service. Encryption design in progress |
| Version history | ✅ | Local, last 50 versions per note |
| Publish notes as a website | 🚧 | Will be free: export a static site you host anywhere |

## Customisation

| Feature | Status | Notes |
| --- | --- | --- |
| Themes / CSS snippets | 🚧 | |
| Plugins | 🚧 | |
| Import from other apps | 🟡 | Obsidian vaults open as-is; other importers aren't built |

## Popular plugin equivalents

| Plugin | Status | Notes |
| --- | --- | --- |
| Tasks | 🟡 | Vault-wide task list (drawer ☑, `ultron tasks`, Claude's `list_tasks`). No due dates or queries |
| Templater | 🟡 | Basic templates; no scripting |
| Periodic Notes | 🟡 | Daily notes only |
| Dataview, Calendar, Excalidraw, Outliner | 🚧 | |
