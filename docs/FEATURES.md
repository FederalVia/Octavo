# Features

Status of every feature on the Octavo feature list.

**Everything in Octavo is free.** There are no paid tiers, subscriptions or accounts, and features that other apps sell, like sync and publishing, will be free here too.

✅ done · 🟡 partly done · 🚧 planned · ❌ not planned (needs a separate product or service)

How-tos for the finished features are in the [user guide](USER_GUIDE.md).

## Core

| Feature | Status | Notes |
| --- | --- | --- |
| Local-first notes as plain Markdown files | ✅ | Your vault is an ordinary folder of `.md` files |
| Works fully offline | ✅ | The desktop app needs no internet. On your phone, notes you open are saved on the device, and **Settings → Offline → Save all notes** keeps every note readable when your PC is off or you have no signal (read-only until you reconnect; edits made offline save when you're back) |
| No account needed | ✅ | |
| Free, no paid tiers | ✅ | Every feature, including future sync and publishing |
| Lock individual notes with a password | ✅ | Optional, off by default (⚙ Settings). End-to-end encrypted on your device (AES-256-GCM, PBKDF2 600k), including on phones over plain Wi-Fi. The server and Claude can't read locked notes. See the [user guide](USER_GUIDE.md#locked-encrypted-notes) |
| Open formats, no lock-in | ✅ | Markdown + YAML frontmatter, compatible with Obsidian |
| Mac, Windows, Linux | ✅ | Desktop app with installers on the [Releases page](https://github.com/FederalVia/octavo/releases), or any browser |
| iOS and Android | 🟡 | Scan a QR code and add Octavo to your home screen. **Access from Anywhere** connects your phone directly to your PC over Wi-Fi or mobile data (automatic router setup and HTTPS). No native apps |
| Multiple vaults | ✅ | **Brains**: create, switch and remove separate vaults in **Settings → Brains** or **File → Brains**. Each brain is its own Claude connection, so each chat can get only the brains it should. Server: run one per vault (`--vault`, `--port`) |
| Open a single Markdown file outside a vault | ✅ | Desktop: **File → Brains → Open Markdown File…**, or *Open with → Octavo*. A file outside every brain opens with its folder added as a brain |

## Writing

| Feature | Status | Notes |
| --- | --- | --- |
| Source mode and Reading view | ✅ | Ctrl/Cmd+E toggles |
| Live Preview (rendered while editing) | ✅ | On by default: formatting marks are hidden except on the line you're editing; checkboxes, links, images, highlights, quotes and rules render inline. **Settings → Editor → Live preview** switches to source mode |
| Headings, bold, italics, strikethrough, quotes, nested lists | ✅ | |
| Task checkboxes with custom marks (`[x]`, `[-]`, `[?]`, `[!]`…) | ✅ | Click to tick in reading view |
| Tables | ✅ | Rendered, and inserted with `/table`. In reading view, right-click a cell (or tap it, then ⋯) to sort, insert, move, align or delete rows and columns |
| Coloured highlights | ✅ | `==text==`, or `=={red}text==` (red, orange, yellow, green, blue, purple) |
| Callouts (`note`, `tip`, `warning`, `question`, `bug`, `todo`…) | ✅ | All types, foldable (`[!tip]-` / `[!tip]+`), and nested callouts |
| Code blocks with syntax highlighting | ✅ | In the editor and in reading view, for 100+ languages |
| Inline comments hidden in reading view | ✅ | `%%like this%%` |
| Footnotes | ✅ | `[^1]` … `[^1]: text`, or `/footnote` |
| Math (LaTeX) | ✅ | `$inline$` and `$$block$$` via KaTeX |
| Mermaid diagrams | ✅ | Rendered (flowcharts, sequence, timelines…). A box whose label is a note's name opens that note |
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
| Orphan and dead-end notes | ✅ | Drawer → Insights (◇), and `octavo orphans` |

## Organisation

| Feature | Status | Notes |
| --- | --- | --- |
| File explorer with folders | ✅ | Drag to move; right-click to rename/delete |
| Quick switcher | ✅ | Ctrl/Cmd+O |
| Search by text, path, tag | ✅ | `"phrase"`, `tag:x`, `#x`, `path:folder` |
| Bookmarks | ✅ | Notes, headings (hover a heading in reading view and click ☆), searches and web links |
| Daily notes | ✅ | Ctrl/Cmd+D |
| Templates with `{{date}}`, `{{time}}`, `{{title}}` | ✅ | Notes in `Templates/`; also `{{date:YYYY-MM-DD}}` formats. `/template` or the command palette |
| Unique note creator (timestamp titles) | ✅ | Command palette → *New unique note* |
| Properties / metadata | ✅ | Shown as a properties table and used for tags, aliases and region. **Edit** (or *Edit properties* in the command palette) gives typed fields: text, list, number, checkbox, date |
| Bases (database views) | 🚧 | |
| Canvas | 🚧 | |
| Workspaces (saved layouts) | ✅ | Command palette → *Save workspace* / *Open workspace*: open tabs, split view, sidebar and brain view, saved with the vault |
| Note composer (split / merge) | ✅ | *Extract selection to new note*, and *Merge this note into another…* (links are updated; Claude can use `merge_notes`) |
| File recovery snapshots | ✅ | ⟲ on each note: diff against the current version, restore. Kept in `.octavo/history/` |
| Rename/move updates every link | ✅ | |

## Editor and layout

| Feature | Status | Notes |
| --- | --- | --- |
| Command palette | ✅ | Ctrl/Cmd+P |
| Slash commands | ✅ | Type `/` in the editor |
| Custom hotkeys | ✅ | **Settings → Editor → Hotkeys** (or *Customize hotkeys…*): any command can get a shortcut, saved with the vault |
| Tabs, split panes, pop-out windows | ✅ | Tabs (Ctrl/Cmd+click or middle-click opens a new one; Ctrl+T/W/Tab in the desktop app), split view (a second note alongside in reading view), and *Open this note in a new window* |
| Stacked tabs | 🚧 | |
| Vim keybindings | ✅ | Command palette → *Turn on Vim keybindings* |
| Web viewer | 🚧 | |
| Word and character count | ✅ | Status bar |

## Capture and media

| Feature | Status | Notes |
| --- | --- | --- |
| Random note | ✅ | Command palette |
| Audio recorder | 🚧 | |
| Slides (note → presentation) | ✅ | *Start presentation*: full screen, one slide per `---` section; arrows, space or click to move |
| Web Clipper browser extension | ❌ | A separate product |
| iOS Quick Capture, Share Sheet, Siri/Shortcuts, voice capture, widgets | ❌ | Needs a native mobile app |
| Mobile PDF export | ✅ | *Export to PDF*: the desktop app saves a PDF; browsers and phones open the print dialog, where you can save as PDF |
| macOS Quick Look | ❌ | Needs a native macOS extension |

## Automation

| Feature | Status | Notes |
| --- | --- | --- |
| Links that open a note | ✅ | Every note has a URL (`…/#/note/Folder/Note.md`), and the desktop app opens `octavo://open?vault=Brain&file=Note` links from anywhere (command palette → *Copy octavo:// link*) |
| CLI: create, read, append, search, move notes | ✅ | `octavo new / read / append / search / move` |
| CLI: daily note, add a task | ✅ | `octavo daily [text]`, `octavo task <text>` |
| CLI: list tags and tasks, toggle checkboxes | ✅ | `octavo tags`, `octavo tasks`, `octavo done <note> <line>` |
| CLI: version history and restore | ✅ | `octavo history`, `octavo restore` |
| CLI: query Bases, install plugins/themes, terminal UI | 🚧 | |
| AI access | ✅ | MCP server with 22 tools, so Claude can read, write and organise the vault, see and set each note's brain region, and resurface old notes at random. The atlas draws a fading **trail** of what Claude read and changed |
| Headless client | 🟡 | `octavo serve` / Docker runs the vault headless with a REST API |

## Sync and publishing (free)

| Feature | Status | Notes |
| --- | --- | --- |
| Sync across devices | 🟡 | Your PC is the one server, and every device opens it directly with [Access from Anywhere](SELF_HOSTING.md). Or sync the folder with git/Syncthing |
| End-to-end encrypted sync, shared vaults, selective sync | 🚧 | Will be free and self-hostable, with no paid service. Encryption design in progress |
| Version history | ✅ | Local, last 50 versions per note |
| Publish notes as a website | 🚧 | Will be free: export a static site you host anywhere |

## Customisation

| Feature | Status | Notes |
| --- | --- | --- |
| Themes / CSS snippets | ✅ | **Settings → Appearance**: dark, light or match system, six accent colours, and CSS snippets from the vault's `.octavo/snippets` folder |
| Plugins | 🚧 | |
| Import from other apps | ✅ | Obsidian vaults open as-is. **File → Import** (or `octavo import`) brings in Notion exports and Evernote `.enex` files |

## Popular plugin equivalents

| Plugin | Status | Notes |
| --- | --- | --- |
| Tasks | ✅ | Vault-wide task list (drawer ☑, by note or by date), due dates (`📅 2026-11-10`, or `/due` in the editor), live ` ```tasks ` query blocks, `octavo tasks`, and Claude's `list_tasks` (can filter overdue / today / next 7 days) |
| Templater | 🟡 | Templates with variables: `{{title}}`, `{{folder}}`, `{{date:dddd D MMMM}}`, offsets like `{{date+7d}}`, `{{weekday}}`, `{{week}}`… No scripting, by design: notes can be written by Claude and other tools, so templates never run code |
| Periodic Notes | ✅ | Daily, weekly (`Journal/Weekly/2026-W45`) and monthly (`Journal/Monthly/2026-11`) notes, from the command palette, `octavo weekly`/`monthly`, or Claude's `open_periodic_note` |
| Calendar | ✅ | Calendar tab in the sidebar: journal days, weekly/monthly notes and due tasks; click a day to open or create its note |
| Dataview, Excalidraw, Outliner | 🚧 | |
