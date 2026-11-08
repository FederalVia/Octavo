**Octavo 1.0**: a knowledge base you see as a brain, and that Claude uses as its long-term memory. Free, with no account needed. Your notes are plain Markdown files in a folder you choose.

## What's in 1.0

- **The brain:** a 3D atlas of your notes in six coloured regions, plus a flat network view. Islands keep a separate subject apart in its own corner. Place notes by hand in the network view and they stay put. A time-lapse replays your brain growing.
- **Writing:** live preview, callouts, tasks with due dates, tables, maths, Mermaid diagrams, footnotes, live queries (Bases / Dataview style), canvas boards, Excalidraw drawings and a quick `/sketch` pad in any note. PDFs show page by page.
- **Claude:** an MCP server with 28 tools, so Claude can search, read, write, organise and even move notes in the brain. Everything it reads and changes lights up live.
- **Your phone:** open Octavo on your phone over home Wi-Fi, or from anywhere with Access from Anywhere (your PC, your router, a free certificate; no cloud service). Installable as an app, with offline reading.
- **Other apps:** keep notes from Notability, GoodNotes and others in step through their backup folder. Import from Notion and Evernote. Publish chosen notes as a static website.
- **Safety net:** version history, a recoverable trash, conflict warnings, optional password-locked notes, one-click zip backups and optional daily automatic backups.
- **Terminal:** `octavo tui` to browse in a terminal, and commands for notes, tasks, queries, islands, themes, backups and more.

Full feature list: [docs/FEATURES.md](https://github.com/FederalVia/Octavo/blob/main/docs/FEATURES.md). Guides: [Installation](https://github.com/FederalVia/Octavo/blob/main/docs/INSTALL.md), [User guide](https://github.com/FederalVia/Octavo/blob/main/docs/USER_GUIDE.md), [Connecting Claude](https://github.com/FederalVia/Octavo/blob/main/docs/CONNECT_CLAUDE.md).

**Updating from a 0.x test build:** the app offers 1.0 by itself (Settings → Updates). On a Mac, download the new `.dmg` from this page.

## Download

| Your computer | File |
| --- | --- |
| **Windows** 10/11 | `Octavo-Setup-<version>.exe` |
| **Mac** with Apple Silicon (M1–M4) | `Octavo-<version>-mac-arm64.dmg` |
| **Mac** with Intel | `Octavo-<version>-mac-x64.dmg` |
| **Linux** | `Octavo-<version>-linux-x86_64.AppImage` |

## First launch: expect a warning

Octavo isn't signed with a paid developer certificate (it's free software with no company behind it), so your computer warns you the first time:

- **Windows:** "Windows protected your PC" → click **More info** → **Run anyway**.
- **Mac:** open the `.dmg` and drag Octavo to Applications. The first time you open it, macOS says it can't verify the app. Go to **System Settings → Privacy & Security**, scroll down, click **Open Anyway**, and confirm.
- **Linux:** make the file executable (`chmod +x Octavo-*.AppImage`), then run it.

## Things to try

1. **The brain:** drag to rotate, scroll to zoom, click a point to open a note.
2. **Your phone, anywhere:**
   - Open **⚙ Settings → Use on your phone** and click **Check** to see whether your router and internet provider allow direct connections.
   - If they do, click **Turn on** under *Access from Anywhere* and scan the QR code. It works on Wi-Fi or mobile data.
   - The same options are in the **File** menu.
   - **Windows will ask whether to allow Octavo through the firewall. Click Allow.**
3. **Your phone, at home only:** **⚙ Settings → Home Wi-Fi only → Turn on**.
4. **Claude:** **File → Connect Claude…** copies the setup for Claude Code or Claude Desktop.
5. **Settings (⚙):** islands, backups, notes from other apps, optional password-locked notes, Vim mode, and the default brain view.

Your notes are saved as plain Markdown files in the `Octavo` folder in your home folder. Use **File → Open Vault Folder…** to pick another folder, such as an existing Obsidian vault.

Found a problem? Open an issue with what you did and what you saw.
