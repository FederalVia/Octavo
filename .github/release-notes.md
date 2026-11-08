Test build of **Octavo**: notes you see as a brain, shared with Claude. Free, with no account needed.

## New in 0.7.0

- **Notes from Notability, GoodNotes and other apps:** point Octavo at the folder an app backs up to (for Notability: Settings → Auto-backup → Google Drive, OneDrive or Dropbox, as PDF, with that drive on your PC), in **⚙ Settings → Notes from other apps**. Each PDF becomes a note showing every page, with its typed text searchable by you and Claude, and it follows your changes. Your own notes outside the synced part stay.
- **PDFs show page by page** in notes, on phones too (iPhones used to show only the first page), with an **Open PDF** link.
- Command line: `octavo serve --watch-folder <folder>` and `octavo sync-folder <folder>`.

## New in 0.6.6

- **Drawing editor on phones:** the Done button was pushed off the screen by the drawing tools. On phones it now sits in the middle of the bottom bar.

## New in 0.6.5

- **Drawings show as pictures while editing too:** `![[sketch.excalidraw]]` used to appear as a link in edit mode; now it is drawn like in reading view. Tap it to open the drawing.

## New in 0.6.4

- **Place notes by hand in the network view:** turn on the pin button (under the zoom buttons), or hold Shift as you drop, and a dragged note stays where you put it. Right-click a note to let the layout place it again.
- **Claude can move notes too:** ask it to gather related notes together or put a note next to another. It uses the new `place_note` tool, and you see the notes glide there.
- Placements are saved in the vault, so your phone and other devices see them.
- Fixed: after dragging a note, the mouse pointer stayed a hand over empty space.

## Download

| Your computer | File |
| --- | --- |
| **Windows** 10/11 | `Octavo-Setup-<version>.exe` |
| **Mac** with Apple Silicon (M1–M4) | `Octavo-<version>-mac-arm64.dmg` |
| **Mac** with Intel | `Octavo-<version>-mac-x64.dmg` |
| **Linux** | `Octavo-<version>-linux-x86_64.AppImage` |

## First launch: expect a warning

This test build isn't signed with a paid developer certificate yet, so your computer warns you the first time:

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
5. **Settings (⚙):** optional password-locked notes, Vim mode, and the default brain view.

Your notes are saved as plain Markdown files in the `Octavo` folder in your home folder. Use **File → Open Vault Folder…** to pick another folder, such as an existing Obsidian vault.

Found a problem? Open an issue with what you did and what you saw.
