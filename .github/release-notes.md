Test build of **Octavo**: notes you see as a brain, shared with Claude. Free, with no account needed.

## New in 0.6.3

- **Quick sketch:** type `/sketch` in a note for a small drawing pad (finger, mouse or pen). Insert saves it as a drawing and embeds it.
- **Backups:** ⚙ Settings → Backup downloads the whole vault as one zip, and can make one automatically every day in a folder next to the vault.
- **Brain dock:** double-tap a region to show only that one, now reliable on phones; empty regions no longer get a pill.
- **Zoom where you point:** pinch zooms between your fingers and the mouse wheel zooms towards the cursor.
- **Terminal:** `octavo tui` to browse notes in a terminal, `octavo backup`, `octavo theme add` for CSS themes, `octavo recent 3d`, and `octavo islands`.
- **Claude:** the vault overview lists islands, and `list_notes` can show only what changed recently (`since: "3d"`).

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
