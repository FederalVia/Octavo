# User guide

- [The screen](#the-screen)
- [Atlas view](#atlas-view)
- [Network view](#network-view)
- [Brain regions](#brain-regions)
- [Reading and editing notes](#reading-and-editing-notes)
- [Writing syntax](#writing-syntax)
- [Images and attachments](#images-and-attachments)
- [Links, tags and properties](#links-tags-and-properties)
- [Finding things](#finding-things)
- [Organising notes](#organising-notes)
- [Command palette and slash commands](#command-palette-and-slash-commands)
- [Templates](#templates)
- [Bookmarks](#bookmarks)
- [Tasks](#tasks)
- [Insights: orphans, dead ends, unlinked mentions](#insights-orphans-dead-ends-unlinked-mentions)
- [Version history](#version-history)
- [Locked (encrypted) notes](#locked-encrypted-notes)
- [Daily journal](#daily-journal)
- [When Claude (or anything else) edits a note](#when-claude-or-anything-else-edits-a-note)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Using it alongside Obsidian, git and other editors](#using-it-alongside-obsidian-git-and-other-editors)

---

## The screen

![Atlas view](images/atlas.png)

- **The brain** fills the window. Every note is a point, and every link between notes is a line.
- **The toolbar** (top left) has these buttons, from left to right:
  - ⚙ opens settings: note locking, Vim, line numbers, and the default brain view.
  - ☰ opens the drawer. Its tabs are Files ▤, Search ⌕, Tags #, Tasks ☑, Bookmarks ☆ and Insights ◇.
  - The green dot shows live sync is connected.
  - The title shows the vault name, the current view and the note count.
  - ⋰ / ◎ switches between the atlas and network views.
  - ⌕ opens the quick switcher.
  - ＋ creates a new note.
  - ◷ opens today's journal.
- **The note panel** slides in from the right when you open a note. Close it with **Esc**, the ✕ button, or by clicking empty space in the brain.

## Atlas view

A 3D brain. Notes are grouped into anatomical [regions](#brain-regions).

| Action | How |
| --- | --- |
| Rotate | Drag |
| Pan | Shift + drag, or right-drag |
| Zoom | Scroll, or pinch on a touch screen |
| Open a note | Click its point |
| Highlight a note's connections | Hover over it |

- **The legend** (top left) lists each region with its note count. Click a region to hide or show it.
- **The controls** (top right):
  - **Labels** turns note names on or off.
  - **All** / **None** show or hide every region.
  - **FRO PAR TEM OCC CER STM** toggle each region.
  - **search notes…** highlights matching notes. Press Enter to open the best match.
- **Larger, glinting points** are your most connected notes (hubs).
- **Faint points** are links to notes that don't exist yet. Click one to create the note.
- The brain **rotates slowly** when you leave it alone, and stops as soon as you interact or open a note.
- **The orientation marker** (bottom right) shows which way is superior (S), anterior (A) and left (L).

## Network view

![Network view](images/network.png)

A flat, force-directed graph. Zoom with scroll or pinch, drag the background to pan, and drag points to rearrange them. Colours follow the regions: grey for general concepts, yellow for projects, green for people, blue for sources, red for journal entries and white for index notes. Use **Search the mind…** (top left) to highlight notes, and press Enter to open the best match.

## Brain regions

Each note belongs to one region. The rules are checked in this order:

1. A `region:` value in the note's frontmatter, e.g. `region: temporal`. You can use the full name (`frontal`, `brain stem`) or the short code (`FRO`, `STM`).
2. Top-level notes named `Home`, `Index`, `README` or `Start here` go to the **brain stem**.
3. The **folder names** in the note's path.
4. The note's **tags**.
5. Notes named with a date (`2026-11-06…`) go to the **cerebellum**.
6. Anything else goes to the **parietal** lobe.

| Region | Holds | Folder or tag names that match |
| --- | --- | --- |
| Frontal | Projects, decisions | projects, current projects, decisions, goals, plans, planning, tasks, todos, okrs, roadmaps, areas |
| Parietal | Concepts, tools | concepts, tools, ideas, knowledge, topics, notes, zettels, zettelkasten, permanent, wiki, tech, skills, evergreen |
| Temporal | People, organisations | people, persons, contacts, orgs, organisations, companies, teams, family, friends, clients, customers, crm |
| Occipital | Sources, reading | sources, repos, repositories, reading, books, articles, papers, references, resources, links, bookmarks, media, videos, podcasts, courses, literature, clippings |
| Cerebellum | Daily notes, logs | journal(s), daily, dailies, daily notes, logs, incidents, meetings, standups, diary, calendar, archive(s), periodic |
| Brain stem | Index, routing | home, index, readme, start here, mocs, maps of content, hubs, dashboards, inbox, unsorted, routing |

Matching ignores case and leading numbers, so `00 - Current Projects` counts as "current projects".

## Reading and editing notes

Click a point, or pick a note from the drawer or the quick switcher, to open it in the note panel.

![Editing a note](images/editor.png)

- **Read / Edit** (or **Ctrl/Cmd+E**) switches between the rendered note and the Markdown editor.
- **Changes save automatically** shortly after you stop typing. The status bar shows *Editing… → Saving… → Saved*. **Ctrl/Cmd+S** saves immediately.
- **⇤ / ⇥** makes the panel wider or narrower.
- **☆ / ★** bookmarks the note.
- **≡** shows the outline (headings). Click one to jump to it.
- **⟲** opens the [version history](#version-history).
- **✎** renames or moves the note. You can also double-click the title.
- **🗑** deletes the note. It goes to the vault's `.trash` folder, so you can recover it.
- **Under the note**:
  - *Linked from* shows notes that link here (backlinks).
  - *Links to* shows notes this one links to.
  - *Mentioned in* shows notes that use this note's name without linking to it.

  Click any of them to jump there. The brain flies to the new note.
- **Hover over a link** in reading view to preview the linked note.
- **Click a task checkbox** in reading view to tick it. The note is updated and saved.
- The status bar shows word and character counts.

**Editor features:**
- Type `[[` to get note-name suggestions, `#` for tag suggestions, and `/` for [slash commands](#command-palette-and-slash-commands).
- Paste or drag images and other files in to [upload them](#images-and-attachments).
- Vim keybindings: command palette → *Turn on Vim keybindings*.
- **Ctrl/Cmd+click** a `[[link]]` to follow it.
- Code blocks are highlighted for most languages.
- Standard editing keys work, including undo/redo and Ctrl/Cmd+F to find in the note.

## Writing syntax

Ultron reads standard Markdown plus these extras. The demo vault's **Formatting Showcase** note shows all of them.

| Write | Get |
| --- | --- |
| `**bold**`, `*italic*`, `~~strike~~`, `` `code` `` | Basic formatting |
| `==highlight==`, `=={green}highlight==` | Highlights in yellow (default), red, orange, green, blue or purple |
| `- [ ] task`, `- [x] done` | Task checkboxes. Any single character works as a status: `[-]` cancelled, `[?]` question, `[!]` important… |
| `> [!note] Title` | A callout. Types: note, info, tip, success, question, warning, failure, danger, bug, example, quote, abstract, todo |
| `> [!tip]- Title` / `> [!tip]+ Title` | A foldable callout, closed / open by default |
| `Text.[^1]` … `[^1]: The footnote` | Footnotes |
| `$E = mc^2$`, `$$ … $$` | Inline and block maths (LaTeX) |
| ```` ```mermaid ```` code block | Diagrams: flowcharts, sequence diagrams, timelines, … |
| `%%hidden%%` | A comment, visible only in the editor |
| `Some paragraph ^my-id` | A block id, so `[[Note#^my-id]]` can link to or embed exactly that paragraph |
| ```` ```js ```` code block | Code (highlighted in the editor) |
| `\| a \| b \|` tables | Tables (`/table` inserts one) |

## Images and attachments

- **Paste** an image (e.g. a screenshot) or **drag files** into the editor. They're saved to the vault's `attachments/` folder, and an embed such as `![[screenshot.png]]` is inserted.
- **Embed** files with `![[file.png]]`. Images, audio (`mp3`, `wav`, `m4a`, `ogg`…), video (`mp4`, `mov`, `webm`…) and PDFs all display inline. The name alone is enough: the file can be in any folder.
- **Resize** an image with `![[photo.png|300]]` (width) or `![[photo.png|300x200]]`.
- Standard Markdown images work too: `![alt](attachments/photo.png)`.

## Links, tags and properties

| Syntax | Meaning |
| --- | --- |
| `[[Note name]]` | Link to a note by name |
| `[[Folder/Note name]]` | Link by path (when two notes share a name) |
| `[[Note name\|shown text]]` | Link with different display text |
| `[[Note name#Heading]]` | Link to a section |
| `[[Note name#^block-id]]` | Link to a specific block |
| `![[Note name]]` | Embed the whole note inline |
| `![[Note name#Heading]]` / `![[Note name#^block-id]]` | Embed just a section or a block |
| `[text](Other%20Note.md)` | Ordinary Markdown link to another note |
| `#tag`, `#nested/tag` | Tags. They also count as the parent tag (`#nested`). |

- **Links to notes that don't exist yet** are shown faded. Click one to create the note.
- **Renaming or moving a note updates every link** that points to it, in all notes.
- **Frontmatter** (YAML between `---` lines at the top of a note) is shown as a properties table. Special keys:
  - `tags: [a, b]` adds tags.
  - `aliases: [Other Name]` lets `[[Other Name]]` link to this note.
  - `region: frontal` places the note in a brain region.

## Finding things

- **Quick switcher** (**Ctrl/Cmd+O**): type part of a note's name and press Enter to open it. **Shift+Enter** (or the *Create* entry) makes a new note with that name.
- **Search** (**Ctrl/Cmd+Shift+F**, or ☰ → Search) searches the full text:
  - `deploy staging`: notes containing both words
  - `"exact phrase"`
  - `tag:project` or `#project`: notes with that tag
  - `path:Projects`: notes in a folder
  - Combinations work too, e.g. `tag:person path:Work alice`.

  Clicking a result opens the note. Clicking a matching line jumps to that line in the editor.
- **Tags** (☰ → Tags): every tag and how many notes use it. Click one to search for it.
- In either brain view, the **search box** highlights matching points.

## Organising notes

- **New note**: ＋ in the toolbar or **Ctrl/Cmd+N**. Type `Folder/Name` to put it in a folder, which is created automatically. In the file tree, right-click a folder and choose **New note here**.
- **Move**: drag a note onto a folder in the file tree, or rename it to a new path, e.g. `Archive/Old idea`.
- **Rename / delete**: right-click a note in the file tree, or use the buttons in the note panel.
- **Folders** exist as long as they contain notes.

## Command palette and slash commands

**Ctrl/Cmd+P** opens the command palette. Type to find any action, then press Enter:

- **Create:** new note, new unique note (timestamp name), new note from template
- **Navigate:** today's journal, quick switcher, random note, search, tasks, bookmarks, insights
- **Current note:** insert template, bookmark, version history, extract selection to a new note, copy link, rename, delete
- **Settings:** switch view, Vim keybindings, line numbers

**Slash commands**: type `/` at the start of a word in the editor for a menu of things to insert:

- headings, task, bullet and numbered lists, quote
- callouts (note, tip, warning, foldable)
- table, code block, maths, Mermaid diagram, divider
- highlight, comment, footnote, link, embed
- today's date or the current time
- a template

## Templates

Put notes in a **`Templates/`** folder. When a template is used, these placeholders are filled in:

| Placeholder | Becomes |
| --- | --- |
| `{{title}}` | The note's name |
| `{{date}}` | Today, as `2026-11-06` |
| `{{time}}` | Now, as `14:05` |
| `{{date:DD/MM/YYYY}}` | A custom format using `YYYY`, `MM`, `DD`, `HH`, `mm`, `ss` |

- **Insert a template** into the current note: `/template` in the editor, or command palette → *Insert template…*. A template's frontmatter is left out when inserting.
- **Create a note from a template**: command palette → *New note from template…*

The demo vault includes `Templates/Meeting` and `Templates/Book`.

## Bookmarks

The **☆** button on a note bookmarks it, and **☆ Bookmark this search** in the Search tab saves a search. In the Bookmarks tab (☆) you can also add web links. Bookmarks are stored in the vault at `.ultron/bookmarks.json`, so they move with the vault.

## Tasks

The **Tasks** tab (☑) lists every open task in the vault, grouped by note. Tick tasks right there, or click a task to jump to it. *Show completed* includes finished ones. From a terminal: `ultron tasks` and `ultron task "something"`. Claude can list and update tasks too.

## Insights: orphans, dead ends, unlinked mentions

The **Insights** tab (◇) helps keep the vault connected:

- **Orphans**: notes that no other note links to.
- **Dead ends**: notes that don't link anywhere.
- **Not written yet**: link targets that don't exist. Click one to create it.

Under each note, **Mentioned in** lists notes that use its name in plain text without linking. These are good candidates for new links.

## Version history

Before a note changes, Ultron keeps a copy of the previous version (at most every 5 minutes, newest 50 per note) in the vault's `.ultron/history/` folder. Click **⟲** on a note to see its versions. Each one shows what changed compared with the current note, and **Restore this version** brings it back. The current content is saved first, so a restore can be undone too. This covers edits by Claude as well.

## Locked (encrypted) notes

You can lock any note with a password: diary entries, health records, anything private. This is **optional and off by default**. Turn it on in **⚙ Settings → Lock notes with a password**, and a 🔐 button appears on each note. The setting is stored in the vault, so it applies on every device. Notes that are already locked still open, with a password prompt, even if the setting is off.

- **Lock**: open the note and click **🔐** (or command palette → *Lock note with a password*). Enter a password of at least 8 characters, twice.
- **Read and edit**: a locked note shows a 🔒 screen. Enter the password to unlock it, then read and edit as usual. Every save is encrypted before it leaves your browser.
- **Lock again**: click **🔓**, or command palette → *Lock all unlocked notes*. Notes also lock when you reload or close the tab, and after 15 minutes without activity.
- **Change the password** or **remove encryption**: unlock the note, then use the command palette.

**How it works.** The note is encrypted in your browser with AES-256-GCM, using a key derived from your password (PBKDF2-SHA256, 600,000 iterations, a random salt per note). The server, Claude, search and anyone who copies your files only ever see scrambled data. Your password is never sent anywhere.

**Good to know:**

- **There is no password recovery.** If you forget a note's password, its contents are gone for good. Consider keeping it in a password manager.
- **The note's title (file name), folder and links *to* it stay visible.** Choose a neutral title if the title itself is sensitive.
- **Locked notes are left out** of search, tasks, tags, mentions and the brain's link lines from that note. They appear in the brain with a 🔒.
- **Claude can see that a locked note exists, but can't read, change or delete it.**
- **Locking deletes the note's earlier plain-text versions from Ultron's version history.** Copies elsewhere, such as git history, backups or sync services, may still hold the old plain text.
- **The file is still a `.md` file** with a short "this note is locked" message, so Obsidian and git show a placeholder. Don't edit that file by hand, or it can no longer be unlocked.
- On your phone over home Wi-Fi (`http://`), the same encryption runs in JavaScript. Unlocking takes a moment longer but is just as secure, and the password never leaves the phone.

## Daily journal

**Ctrl/Cmd+D** (or ◷) opens today's note, `Journal/YYYY-MM-DD.md`, and creates it if needed. Claude adds timestamped entries here when it uses `log_to_journal`. To use a different folder, start the server with `--daily <folder>`.

## When Claude (or anything else) edits a note

- The note's point **lights up**, and signals travel along its links.
- **New notes grow into the brain** where they belong.
- If the note is open and you **haven't changed it**, it reloads automatically.
- If you **were editing it**, a yellow banner appears instead of anything being overwritten. Choose **Load theirs** to take the other version, or **Keep mine** to save yours over it.

## Keyboard shortcuts

On macOS, use **Cmd** instead of **Ctrl**.

| Shortcut | Action |
| --- | --- |
| Ctrl+P | Command palette |
| Ctrl+O | Quick switcher |
| Ctrl+N | New note |
| Ctrl+D | Today's journal note |
| Ctrl+E | Toggle read / edit |
| Ctrl+S | Save now |
| Ctrl+Shift+F | Search |
| Ctrl+\ | Toggle the drawer |
| Ctrl+G or Esc | Close the note and return to the brain |
| Ctrl+click on `[[link]]` | Follow the link (in the editor) |
| Shift+Enter | Create the typed note (in the quick switcher) |
| `/` | Slash commands (in the editor) |

## Using it alongside Obsidian, git and other editors

- The vault is just a folder of `.md` files. Ultron Mind ignores hidden folders such as `.obsidian`, `.git` and `.trash`.
- You can open the same folder in **Obsidian** and in Ultron Mind at the same time. Changes appear in both.
- **git** works well for history and sync. Commit the vault folder as usual.
- Obsidian attachments (`![[image.png]]`) display as they do in Obsidian, and Obsidian-style callouts, highlights, footnotes, maths, block links and comments all render.
- Ultron keeps its own data (bookmarks, version history) in a hidden `.ultron/` folder. Add it to `.gitignore` if you don't want it committed.
