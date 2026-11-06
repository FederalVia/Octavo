First test build of **Octavo**: notes you see as a brain, shared with Claude. Free, with no account needed.

## Download

| Your computer | File |
| --- | --- |
| **Windows** 10/11 | `Octavo-Setup-0.1.0.exe` |
| **Mac** with Apple Silicon (M1–M4) | `Octavo-0.1.0-mac-arm64.dmg` |
| **Mac** with Intel | `Octavo-0.1.0-mac-x64.dmg` |
| **Linux** | `Octavo-0.1.0-linux-x86_64.AppImage` |

## First launch: expect a warning

This test build isn't signed with a paid developer certificate yet, so your computer warns you the first time:

- **Windows:** "Windows protected your PC" → click **More info** → **Run anyway**.
- **Mac:** open the `.dmg` and drag Octavo to Applications. The first time you open it, macOS says it can't verify the app. Go to **System Settings → Privacy & Security**, scroll down, click **Open Anyway**, and confirm.
- **Linux:** make the file executable (`chmod +x Octavo-*.AppImage`), then run it.

## Things to try

1. **The brain:** drag to rotate, scroll to zoom, click a point to open a note.
2. **Your phone, anywhere:**
   - First choose **File → Check Network for Access from Anywhere…** to see whether your router and internet provider allow direct connections.
   - If they do, choose **File → Access from Anywhere** and scan the QR code. It works on Wi-Fi or mobile data.
   - **Windows will ask whether to allow Octavo through the firewall. Click Allow.**
3. **Your phone, at home only:** **File → Use on Your Phone (Wi-Fi)**.
4. **Claude:** **File → Connect Claude…** copies the setup for Claude Code or Claude Desktop.
5. **Settings (⚙):** optional password-locked notes, Vim mode, and the default brain view.

Your notes are saved as plain Markdown files in the `Octavo` folder in your home folder. Use **File → Open Vault Folder…** to pick another folder, such as an existing Obsidian vault.

Found a problem? Open an issue with what you did and what you saw.
