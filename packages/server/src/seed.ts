import type { Vault } from '@octavo/core';

// Starter notes for a brand-new, empty vault. Short on purpose: a Home note that explains the
// app, plus a few example notes in every brain region (with links between them) so the brain
// has something to show on first launch. Everything here can be deleted.

const HOME = `# Home

Welcome to **Octavo**. Your notes are plain Markdown files, drawn as a brain, and Claude can use them as its memory.

Every note is a point and every link is a line. Click a point to open it. Notes sit in a region by folder (see [[Brain regions]]):

- **Projects**: [[Set up Octavo]], [[Keep notes in plain Markdown]]
- **Knowledge**: [[How to use Octavo]], [[Brain regions]], [[Your phone]], [[Backups]], [[Notes from other apps]]
- **People**: [[About me]], [[Claude]]
- **Sources**: [[How to Take Smart Notes]], [[Octavo user guide]]
- **Journal**: today's note is one click away (◷, or Ctrl/Cmd + D)
- **Hubs**: this note and [[Inbox]]

Start with [[Set up Octavo]]. These starter notes are yours to change or delete.
`;

const GUIDE = `---
tags: [meta]
---
# How to use Octavo

## The brain

- **Atlas** (3D): drag to turn, scroll or pinch to zoom, Shift + drag to move. The **clock** button (top right, under the eye) plays a time-lapse of your brain growing.
- **Network** (flat map): switch with ⋰ / ◎ in the toolbar. Drag a point to move it; turn on the **pin** button (under the zoom buttons) to keep notes where you drop them.
- **Dock** (bottom): one pill per region. Tap to hide or show it, double-tap to show only that one. **Find** highlights notes by name.
- **Islands** keep an unrelated subject apart: right-click a folder in the file tree → **Keep apart as an island**.

## Writing

- \`[[Note name]]\` links to a note. Links to notes that don't exist yet are faded; click one to create it.
- \`#tags\` and properties (\`status: active\`) work like Obsidian's.
- Type \`/\` while editing for commands. \`/sketch\` opens a small drawing pad and puts the drawing in the note.
- \`![[file.pdf]]\` shows a PDF page by page, on phones too.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd + P | Command palette (every action) |
| Ctrl/Cmd + O | Quick switcher (open or create a note) |
| Ctrl/Cmd + Shift + F | Search all notes |
| Ctrl/Cmd + E | Toggle edit / reading view |
| Esc | Close the note and return to the brain |
| Ctrl/Cmd + D | Today's journal note |

More in the [[Octavo user guide]]. Back to [[Home]].
`;

const REGIONS = `# Brain regions

Each note lives in one region of the brain, decided by its folder (or tags). The app shows each region by an everyday name:

| In the app | Region | Folders |
| --- | --- | --- |
| Projects | Frontal | Projects, Decisions, Goals |
| Knowledge | Parietal | Concepts, Tools, Ideas (and anything else) |
| People | Temporal | People, Orgs, Teams |
| Sources | Occipital | Sources, Reading, Books, Articles |
| Journal | Cerebellum | Journal, Logs, Meetings |
| Hubs | Brain stem | Home, Index, Inbox, Maps |

To put a note somewhere else, add \`region: people\` (or any region) to its properties.

See [[How to use Octavo]] for moving around the brain. Back to [[Home]].
`;

const PROJECT = `---
status: active
---
# Set up Octavo

A few things worth doing in your first ten minutes:

- [ ] Connect Claude: see [[Claude]]
- [ ] Tell Claude who you are: fill in [[About me]]
- [ ] Open your notes on [[Your phone]]
- [ ] Turn on daily [[Backups]]
- [ ] Bring in handwritten notes: [[Notes from other apps]]
- [ ] Type \`/sketch\` in a note and draw something
- [ ] Press the clock button in the brain to watch the time-lapse

Tick a box here or in the Tasks tab (☰ → ☑). Back to [[Home]].
`;

const DECISION = `# Keep notes in plain Markdown

**Decision:** every note is a \`.md\` file in an ordinary folder.

- Nothing is locked in: Obsidian, git, Dropbox or any text editor can open the same folder.
- Claude reads and writes the same files, so what it remembers is always visible here.
- Version history keeps earlier copies of each note, and [[Backups]] zip the whole folder.

Part of [[Set up Octavo]].
`;

const ABOUT_ME = `---
tags: [profile]
---
# About me

Claude reads this note to know who it is working with. Replace the lines below with your own.

- **Name:**
- **What I work on:**
- **How I like answers:** short and direct

See [[Claude]] for how Claude uses this vault.
`;

const CLAUDE = `# Claude

Claude can use this vault as its long-term memory: it searches it at the start of a conversation, saves facts and decisions as notes, and keeps a log in your journal. What it writes appears here straight away, and the notes it touches glow in the brain.

## Connect it

- **Desktop app:** File → **Connect an AI…** (or ⚙ Settings → Connect an AI) shows the setup for Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI, VS Code and others: pick your tool and copy.
- **Without the desktop app:** the [[Octavo user guide]] links to the full setup.

Claude gets 28 tools: search, read, write, tasks, queries, canvases, islands, placing notes on the map and more. Ask it to "put my project notes next to Home" and watch them move.

Start by asking Claude to read [[About me]]. Part of [[Set up Octavo]].
`;

const PHONE = `# Your phone

Open the same notes on your phone, straight from this computer. No account or cloud needed.

1. ⚙ Settings → **Use on your phone** (or the File menu in the desktop app).
2. Turn on **Home Wi-Fi only**, or **Access from Anywhere** for mobile data too.
3. **Show QR code** and scan it with the phone's camera, then add it to your home screen.

The brain, notes, drawings and PDFs all work by touch. Part of [[Set up Octavo]].
`;

const BACKUPS = `# Backups

⚙ Settings → **Backup**:

- **Download .zip** saves every note, attachment, drawing and setting in one file. To restore, unzip it and open the folder as your vault.
- **Back up automatically every day** keeps the newest copies in a folder next to your vault.

See [[Keep notes in plain Markdown]]. Part of [[Set up Octavo]].
`;

const OTHER_APPS = `# Notes from other apps

Handwritten notes from Notability, GoodNotes or a scanner app can join your brain.

1. Set the other app to back up as PDF to a folder on this computer (Google Drive, OneDrive or Dropbox work).
2. In the desktop app: ⚙ Settings → **Notes from other apps** → **Add folder…**

Each PDF becomes a note that shows every page and stays up to date. Typed text in the PDF is searchable, by you and by [[Claude]].

Part of [[Set up Octavo]].
`;

const BOOK = `---
author: Sönke Ahrens
tags: [book]
---
# How to Take Smart Notes

An example of a reading note. Put books, articles and papers in **Reading/** or **Sources/** and they gather in the Sources region.

- Write notes in your own words, one idea per note.
- Link each new note to the ones it relates to; the links matter more than the folders.

Related: [[Keep notes in plain Markdown]], [[Brain regions]].
`;

const DOCS = `# Octavo user guide

The full guide, with every feature: https://github.com/FederalVia/Octavo/blob/main/docs/USER_GUIDE.md

Connecting Claude in detail: https://github.com/FederalVia/Octavo/blob/main/docs/CONNECT_CLAUDE.md

Quick tour: [[How to use Octavo]].
`;

const INBOX = `# Inbox

A place for quick thoughts before they find a home. Write here, then move or link them later.

- Try linking a new idea to [[Home]]
`;

function journal(date: string): string {
  return `# ${date}

- Opened Octavo for the first time and read [[Home]].
- Next: [[Set up Octavo]].

Press ◷ (or Ctrl/Cmd + D) to open the note for today. Claude adds a line here when it logs what it did.
`;
}

/** Give a brand-new, empty vault a few starter notes. */
export async function seedIfEmpty(vault: Vault): Promise<boolean> {
  if (vault.list().length > 0) return false;
  const daily = vault.dailyNotePath();
  const notes: [string, string][] = [
    ['Home.md', HOME],
    ['Inbox.md', INBOX],
    ['How to use Octavo.md', GUIDE],
    ['Concepts/Brain regions.md', REGIONS],
    ['Tools/Your phone.md', PHONE],
    ['Tools/Backups.md', BACKUPS],
    ['Tools/Notes from other apps.md', OTHER_APPS],
    ['Projects/Set up Octavo.md', PROJECT],
    ['Decisions/Keep notes in plain Markdown.md', DECISION],
    ['People/About me.md', ABOUT_ME],
    ['People/Claude.md', CLAUDE],
    ['Reading/How to Take Smart Notes.md', BOOK],
    ['Sources/Octavo user guide.md', DOCS],
    [daily, journal(daily.split('/').pop()!.replace(/\.md$/, ''))],
  ];
  for (const [path, content] of notes) await vault.write(path, content);
  return true;
}
