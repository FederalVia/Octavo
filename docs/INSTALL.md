# Installing Octavo

There are three ways to run Octavo. All of them use the same notes, which are plain Markdown files in a folder you choose (your **vault**).

| Option | Best for |
| --- | --- |
| [Web app on your computer](#2-install-and-run-the-web-app) | Trying it out and everyday use. You open it in a browser tab. |
| [Desktop app](#3-desktop-app) | Its own window, menus and a vault picker. |
| [Docker / server](#5-self-hosting-with-docker) | Reaching your vault from your phone, other computers, or Claude in the cloud. |

- [1. Requirements](#1-requirements)
- [2. Install and run the web app](#2-install-and-run-the-web-app)
- [3. Desktop app](#3-desktop-app)
- [4. Keep it running in the background](#4-keep-it-running-in-the-background)
- [5. Self-hosting with Docker](#5-self-hosting-with-docker)
- [6. Use it on your phone and other devices](#6-use-it-on-your-phone-and-other-devices)
- [7. Command-line options](#7-command-line-options)
- [8. Updating](#8-updating)
- [9. Uninstalling](#9-uninstalling)
- [10. Troubleshooting](#10-troubleshooting)

---

## 1. Requirements

- **Node.js 20 or newer** (22 LTS recommended). Includes `npm`.
- **git**
- About 600 MB of disk space for dependencies (most of it is the desktop app's Electron runtime).
- A modern browser: Chrome, Edge, Firefox or Safari.

Check what you have:

```bash
node --version   # should print v20.x or higher
git --version
```

### Installing Node.js and git

**macOS** (using [Homebrew](https://brew.sh)):

```bash
brew install node git
```

**Windows** (PowerShell):

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Close and reopen your terminal afterwards so the new commands are found.

**Linux** (Debian/Ubuntu):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

Alternatively, use [nvm](https://github.com/nvm-sh/nvm) on any platform: `nvm install 22`. The repository includes an `.nvmrc` file.

---

## 2. Install and run the web app

```bash
git clone https://github.com/FederalVia/Octavo.git
cd octavo
npm install
npm run build
```

### Try the demo vault

```bash
npm run demo
```

Open **http://127.0.0.1:4321**. You'll see the example vault from `examples/demo-vault` as a brain. Click a point to open its note.

> The demo opens the files in `examples/demo-vault` directly, so any edits change them. Use `git checkout examples/demo-vault` to reset them.

### Use your own vault

```bash
npm start -- --vault ~/Octavo
```

- The folder is created if it doesn't exist. An empty vault gets a few starter notes (use `--no-seed` to skip them).
- Without `--vault`, the default is `~/Octavo`.
- You can point it at an existing **Obsidian vault**. The files stay compatible, and Obsidian's `.obsidian` folder is ignored.
- On Windows, use a path like `--vault "C:\Users\you\Documents\Octavo"`.

Stop the server with **Ctrl+C**.

> **Server only, without the desktop app?** Set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` before `npm install`. This skips downloading Electron, which is about 100 MB.

---

## 3. Desktop app

**Easiest:** download the installer for your system from the [Releases page](https://github.com/FederalVia/Octavo/releases): `.exe` for Windows, `.dmg` for Mac, `.AppImage` for Linux. No Node.js needed.

**From source:**

```bash
npm run desktop
```

This builds the project and opens Octavo in its own window.

- On first launch it uses `~/Octavo`. Use **File → Brains** to create another brain or add an existing folder (such as an Obsidian vault), and it remembers your choice.
- **File → Connect Claude…** copies a ready-made Claude Code command or Claude Desktop config.
- While it's open, the desktop app also serves the web UI and MCP endpoint at `http://127.0.0.1:4321`. If that port is busy it picks another one.

After the first build, `npm start -w @octavo/desktop` opens the app faster because it skips the rebuild.

**Build the installers yourself:** `npm run dist:desktop` builds one for the system you're on, and puts it in `release/dist/`. Pushing a version tag (e.g. `v1.0.0`) makes GitHub build all three and publish a release (`.github/workflows/release.yml`).

---

## 4. Keep it running in the background

To keep the web app (and the HTTP MCP endpoint) available without a terminal open:

### Linux: systemd

Create `~/.config/systemd/user/octavo.service`:

```ini
[Unit]
Description=Octavo

[Service]
WorkingDirectory=%h/octavo
ExecStart=/usr/bin/node packages/server/dist/cli.js serve --vault %h/Octavo
Restart=on-failure

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now octavo
journalctl --user -u octavo -f     # view logs
```

Check the path to `node` with `which node`, and update `ExecStart` if it's different (for example, if you use nvm).

### macOS / Windows / Linux: pm2

```bash
npm install -g pm2
pm2 start packages/server/dist/cli.js --name octavo -- serve --vault ~/Octavo
pm2 save
pm2 startup      # follow the printed instructions to start on boot
```

---

## 5. Self-hosting with Docker

To run Octavo as an always-on server, for example on your PC, follow **[SELF_HOSTING.md](SELF_HOSTING.md)**. It covers installing Docker, the settings file, and three ways to reach it:

- **Tailscale:** from your phone anywhere, no router setup
- **Your own domain with automatic HTTPS**
- **Home Wi-Fi only**

The short version, for this computer only:

```bash
cp .env.example .env        # then set OCTAVO_TOKEN in .env
docker compose up -d        # open http://localhost:4321
```

Notes are stored as plain Markdown in the folder set by `OCTAVO_VAULT_DIR` (default `./vault`).

## 6. Use it on your phone and other devices

### On your home Wi-Fi (easiest)

**Desktop app:** choose **File → Use on Your Phone (Wi-Fi)** (or **⚙ Settings → Use on your phone**), confirm, and scan the QR code with your phone's camera.

**From a terminal:**

```bash
npm start -- --phone --vault ~/Octavo
```

This prints a QR code. Scan it with your phone, which must be on the same Wi-Fi network.

- The link contains a long random **access key**. The app remembers it on the phone and removes it from the address bar. Anyone without the key gets "Unauthorized".
- The key is saved, so the same link keeps working after restarts: `~/.octavo/phone-token` for the terminal version, and the desktop app's settings folder for the desktop app. Delete that file to generate a new key, which logs out every phone.
- To keep Octavo as an app on your phone: **Share → Add to Home Screen** (iPhone, Safari) or **⋮ → Install app** (Android, Chrome).
- [Locked notes](USER_GUIDE.md#locked-encrypted-notes) open on the phone too. They're decrypted on the phone itself, so the password never crosses the network.

> On Wi-Fi, the connection is plain `http://`. Your notes and the access key travel unencrypted across your local network. That's fine on a home network you trust, but don't use phone mode on public Wi-Fi. For that, use one of the options below.

### Away from home (Access from Anywhere)

Octavo can make itself reachable from anywhere by itself, directly, with no extra accounts or apps:

- **Desktop app:** **File → Access from Anywhere**
- **Terminal:** `npm start -- --remote`

It opens your router (UPnP), gets a free HTTPS certificate for your home's internet address, and shows a QR code. The full guide and troubleshooting are in **[SELF_HOSTING.md](SELF_HOSTING.md)**. Run `node packages/server/dist/cli.js check-remote` first to see whether your network allows it.

## 7. Command-line options

```
octavo serve [options]   Web app + REST API + MCP endpoint (/mcp)
octavo mcp   [options]   MCP server over stdio (for Claude Desktop / Claude Code)
octavo tui   [options]   Browse and search the vault in the terminal
octavo check-remote      Check whether your home network allows Access from Anywhere
octavo qr <address>      Print a QR code that opens Octavo at <address> on your phone
```

From the repository, `npm start -- <options>` runs `serve` and `npm run mcp -- <options>` runs `mcp`. You can also call `node packages/server/dist/cli.js <command> <options>` directly.

### Note commands

These work directly on the vault folder, so no server needs to be running:

```bash
alias octavo="node /path/to/octavo/packages/server/dist/cli.js"   # optional shortcut

octavo new "Projects/Website" --content "# Website"   # or pipe content: echo text | octavo new Inbox/Idea
octavo read "Website"
octavo append "Website" "- [ ] Draft homepage" --heading "Tasks"
octavo search 'tag:project "launch date"'
octavo daily "Shipped the new homepage"              # timestamped journal entry
octavo task "Call the printer"                       # adds - [ ] to today's journal
octavo tasks                                         # open tasks across the vault (--done for all)
octavo done "Journal/2026-11-06" 4                   # toggle the task on line 4
octavo tags
octavo move "Website" "Archive/Website"              # updates every link
octavo history "Website"                             # saved versions
octavo restore "Website" 1793928299164
octavo orphans                                       # unlinked notes and dead ends
octavo recent 3d                                     # notes changed in the last 3 days
octavo query 'TABLE status FROM #project'            # live query, as a table
octavo islands add Theology                          # keep a folder apart in the brain views
octavo tui                                           # browse and search in the terminal
octavo sync-folder "$HOME/Google Drive/Notability"  # bring in notes from another app (PDFs, images, Markdown)
octavo theme add ~/Downloads/nord.css                # install a CSS theme and switch it on
octavo backup ~/octavo-backup.zip                    # the whole vault as one zip (--history adds versions)
```

`octavo tui` is a full-screen browser: type to search, ↑/↓ and Enter to open a note, number keys to follow its links, `e` to edit it in your `$EDITOR` (Notepad on Windows), `d` (or Ctrl+D in the list) for today's journal, Esc to go back, Ctrl+C (or `q` while reading) to quit.

All of them take `--vault <dir>` (or use `OCTAVO_VAULT`). `search`, `tasks`, `tags`, `history`, `orphans`, `recent` and `query` accept `--json`. Run `octavo --help` for the full list, including `weekly`, `monthly`, `set`, `publish` and `import`.

| Option | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `--vault <dir>` | `OCTAVO_VAULT` | `~/Octavo` | Folder containing your notes |
| `--port <n>` | `PORT` | `4321` | HTTP port (`serve`) |
| `--host <addr>` | `OCTAVO_HOST` | `127.0.0.1` | Address to listen on (`serve`) |
| `--token <secret>` | `OCTAVO_TOKEN` | none | Require `Authorization: Bearer <secret>` for `/api` and `/mcp` |
| `--phone` | | off | Listen on the Wi-Fi network with a saved access key, and print a QR code for your phone |
| `--remote` | | off | Access from Anywhere: open the router (UPnP), get an HTTPS certificate for your public IP, print a QR code |
| `--public-ip <ip>` | `OCTAVO_PUBLIC_IP` (desktop) | | With `--remote`: skip UPnP, for ports forwarded by hand |
| `--https-port <n>` / `--challenge-port <n>` | | 4443 / 4380 | With `--remote`: local ports that the router forwards to |
| `--read-only` | | off | Only expose read tools over MCP |
| `--watch-folder <dir>` | | | Keep notes from another app in step: mirror this folder into the vault (`serve`). Repeat for more folders |
| `--trust-proxy <who>` | `OCTAVO_TRUST_PROXY` | off | Behind a reverse proxy only: trust `X-Forwarded-For` from these addresses (e.g. `loopback`), so each device gets its own wrong-key lockout |
| `--daily <folder>` | | `Journal` | Folder for daily notes |
| `--no-seed` | | off | Don't create starter notes in an empty vault |

### Installing on a phone

Open your server's address in Safari (iOS) or Chrome (Android), then choose **Share → Add to Home Screen** (iOS) or **⋮ → Install app** (Android). Octavo then opens full-screen like an app. Your phone needs to be able to reach the server: see [section 6](#6-use-it-on-your-phone-and-other-devices).

---

## 8. Updating

```bash
cd octavo
git pull
npm install
npm run build
```

Then restart the server or app. With Docker: `git pull && docker compose up -d --build` (add `-f docker-compose.tailscale.yml` if you use Tailscale).

Updates never change your notes.

---

## 9. Uninstalling

1. Stop the server or app (and remove any systemd/pm2 service you created).
2. Delete the `octavo` folder.
3. Your notes stay in your vault folder (e.g. `~/Octavo`). Delete it only if you no longer want them.
4. The desktop app keeps a tiny settings file in an `Octavo` folder inside your OS's app-data folder (`~/Library/Application Support` on macOS, `%APPDATA%` on Windows, `~/.config` on Linux).
5. Remove Claude's connection: `claude mcp remove octavo`, or delete the entry from `claude_desktop_config.json`.

---

## 10. Troubleshooting

**`EADDRINUSE: address already in use :::4321`**
Something is already using the port, often a previous Octavo. Stop it, or use another port: `npm start -- --port 4322`.

**The page says "Can't reach the Octavo server"**
The server isn't running, or you're using a different port. Check the terminal where you ran `npm start`.

**The browser asks for an "Access token"**
The server was started with `--token` / `OCTAVO_TOKEN`. Enter the same value. To clear a saved token, clear the site data for that address in your browser.

**`403 Host "…" not allowed`**
Without a token, the server only accepts requests addressed to `localhost`/`127.0.0.1`. This protects it from malicious websites. Use `http://127.0.0.1:4321`, or start the server with a `--token` if you need another hostname.

**`npm install` fails while downloading Electron**
Corporate networks and proxies sometimes block the Electron download. If you don't need the desktop app, install with `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`. Otherwise see [Electron's installation docs](https://www.electronjs.org/docs/latest/tutorial/installation) for mirror and proxy settings.

**Notes I edit in another app don't show up**
The server watches the vault folder. On Linux, very large vaults can hit the inotify watch limit. Raise it with `echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p`. Network drives often don't report changes at all, so keep the vault on a local disk.

**The brain view is slow**
The views are drawn with a 2D canvas and stay smooth into the low thousands of notes. With very large vaults, hide regions you don't need (region buttons in the atlas), or switch views with the toolbar button.

**Docker: `permission denied` writing notes**
If you mounted a host folder, it must be writable by UID 1000: `sudo chown -R 1000:1000 ./vault`.

Still stuck? Open an issue on GitHub with the command you ran and the full error output.
