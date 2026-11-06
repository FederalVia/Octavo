# User guide

- [The screen](#the-screen)
- [Atlas view](#atlas-view)
- [Network view](#network-view)
- [Brain regions](#brain-regions)
- [Reading and editing notes](#reading-and-editing-notes)
- [Links, tags and properties](#links-tags-and-properties)
- [Finding things](#finding-things)
- [Organising notes](#organising-notes)
- [Daily journal](#daily-journal)
- [When Claude (or anything else) edits a note](#when-claude-or-anything-else-edits-a-note)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Using it alongside Obsidian, git and other editors](#using-it-alongside-obsidian-git-and-other-editors)

---

## The screen

![Atlas view](images/atlas.png)

- **The brain** fills the window. Every note is a point, and every link between notes is a line.
- **The toolbar** (top left) has these buttons, from left to right:
  - ☰ opens the drawer with files, search and tags.
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
- **✎** renames or moves the note. You can also double-click the title.
- **🗑** deletes the note. It goes to the vault's `.trash` folder, so you can recover it.
- **Under the note**, *Linked from* shows notes that link here (backlinks), and *Links to* shows notes this one links to. Click any of them to jump there. The brain flies to the new note.

**Editor features:**
- Type `[[` to get note-name suggestions, and `#` for tag suggestions.
- **Ctrl/Cmd+click** a `[[link]]` to follow it.
- Code blocks are highlighted for most languages.
- Standard editing keys work, including undo/redo and Ctrl/Cmd+F to find in the note.

## Links, tags and properties

| Syntax | Meaning |
| --- | --- |
| `[[Note name]]` | Link to a note by name |
| `[[Folder/Note name]]` | Link by path (when two notes share a name) |
| `[[Note name\|shown text]]` | Link with different display text |
| `[[Note name#Heading]]` | Link to a section |
| `![[Note name]]` | Embed-style link (shown as a link) |
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
| Ctrl+O (or Ctrl+P) | Quick switcher |
| Ctrl+N | New note |
| Ctrl+D | Today's journal note |
| Ctrl+E | Toggle read / edit |
| Ctrl+S | Save now |
| Ctrl+Shift+F | Search |
| Ctrl+\ | Toggle the drawer |
| Ctrl+G or Esc | Close the note and return to the brain |
| Ctrl+click on `[[link]]` | Follow the link (in the editor) |
| Shift+Enter | Create the typed note (in the quick switcher) |

## Using it alongside Obsidian, git and other editors

- The vault is just a folder of `.md` files. Ultron Mind ignores hidden folders such as `.obsidian`, `.git` and `.trash`.
- You can open the same folder in **Obsidian** and in Ultron Mind at the same time. Changes appear in both.
- **git** works well for history and sync. Commit the vault folder as usual.
- Attachments and images aren't displayed yet, but they're left untouched.
