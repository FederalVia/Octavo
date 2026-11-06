# Installing Ultron Mind

There are three ways to run Ultron Mind. All of them use the same notes, which are plain Markdown files in a folder you choose (your **vault**).

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
- [6. Accessing it from other devices (HTTPS)](#6-accessing-it-from-other-devices-https)
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
git clone https://github.com/FederalVia/ultron-mind.git
cd ultron-mind
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
npm start -- --vault ~/UltronMind
```

- The folder is created if it doesn't exist. An empty vault gets two starter notes (use `--no-seed` to skip them).
- Without `--vault`, the default is `~/UltronMind`.
- You can point it at an existing **Obsidian vault**. The files stay compatible, and Obsidian's `.obsidian` folder is ignored.
- On Windows, use a path like `--vault "C:\Users\you\Documents\UltronMind"`.

Stop the server with **Ctrl+C**.

> **Server only, without the desktop app?** Set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` before `npm install`. This skips downloading Electron, which is about 100 MB.

---

## 3. Desktop app

```bash
npm run desktop
```

This builds the project and opens Ultron Mind in its own window.

- On first launch it uses `~/UltronMind`. Use **File → Open Vault Folder…** to switch, and it remembers your choice.
- **File → Connect Claude…** copies a ready-made Claude Code command or Claude Desktop config.
- While it's open, the desktop app also serves the web UI and MCP endpoint at `http://127.0.0.1:4321`. If that port is busy it picks another one.

After the first build, `npm start -w @ultron/desktop` opens the app faster because it skips the rebuild.

> Packaged installers (`.dmg`, `.exe`, AppImage) aren't available yet, so the desktop app runs from the source folder.

---

## 4. Keep it running in the background

To keep the web app (and the HTTP MCP endpoint) available without a terminal open:

### Linux: systemd

Create `~/.config/systemd/user/ultron-mind.service`:

```ini
[Unit]
Description=Ultron Mind

[Service]
WorkingDirectory=%h/ultron-mind
ExecStart=/usr/bin/node packages/server/dist/cli.js serve --vault %h/UltronMind
Restart=on-failure

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now ultron-mind
journalctl --user -u ultron-mind -f     # view logs
```

Check the path to `node` with `which node`, and update `ExecStart` if it's different (for example, if you use nvm).

### macOS / Windows / Linux: pm2

```bash
npm install -g pm2
pm2 start packages/server/dist/cli.js --name ultron-mind -- serve --vault ~/UltronMind
pm2 save
pm2 startup      # follow the printed instructions to start on boot
```

---

## 5. Self-hosting with Docker

The Docker image runs the web app, REST API and MCP endpoint together. It requires an access token, because it listens on all network interfaces.

### docker compose (recommended)

```bash
git clone https://github.com/FederalVia/ultron-mind.git
cd ultron-mind
export ULTRON_TOKEN=$(openssl rand -hex 32)
echo "Save this token: $ULTRON_TOKEN"
docker compose up -d
```

Open `http://<server>:4321`. The app asks for the token once and remembers it in that browser.

- Notes are stored in the `ultron-vault` Docker volume. To keep them in a host folder instead, change the volume in `docker-compose.yml` to `./vault:/vault`, and make sure that folder is writable by UID 1000 (`mkdir vault && sudo chown 1000:1000 vault`).
- To back up the vault: `docker run --rm -v ultron-mind_ultron-vault:/vault -v "$PWD":/out alpine tar czf /out/vault-backup.tgz -C /vault .`

### Plain docker

```bash
docker build -t ultron-mind .
docker run -d --name ultron-mind -p 4321:4321 \
  -e ULTRON_TOKEN=your-long-random-token \
  -v ultron-vault:/vault \
  --restart unless-stopped \
  ultron-mind
```

---

## 6. Accessing it from other devices (HTTPS)

By default the server only listens on `127.0.0.1`, which means only your own computer can reach it. To use it from your phone, another computer, or Claude in the cloud:

1. **Always set a token**: `--token <secret>` or `ULTRON_TOKEN`. Without one, anyone who can reach the port can read and change your notes. The server prints a warning if you forget.
2. **Listen on the network**: `--host 0.0.0.0` (the Docker image already does this).
3. **Put HTTPS in front of it.** Over plain HTTP your token travels unencrypted. [Caddy](https://caddyserver.com) is the easiest option. It gets certificates automatically. Here's a `Caddyfile`:

   ```
   mind.example.com {
       reverse_proxy 127.0.0.1:4321
   }
   ```

   Live updates use Server-Sent Events, which Caddy passes through without extra configuration. With nginx, add `proxy_buffering off;` for the `/api/events` location.

If you only need access from your own devices, [Tailscale](https://tailscale.com) works well: install it on the server and your devices, then open `http://<tailscale-name>:4321`. You should still set a token.

---

## 7. Command-line options

```
ultron serve [options]   Web app + REST API + MCP endpoint (/mcp)
ultron mcp   [options]   MCP server over stdio (for Claude Desktop / Claude Code)
```

From the repository, `npm start -- <options>` runs `serve` and `npm run mcp -- <options>` runs `mcp`. You can also call `node packages/server/dist/cli.js <command> <options>` directly.

| Option | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `--vault <dir>` | `ULTRON_VAULT` | `~/UltronMind` | Folder containing your notes |
| `--port <n>` | `PORT` | `4321` | HTTP port (`serve`) |
| `--host <addr>` | `ULTRON_HOST` | `127.0.0.1` | Address to listen on (`serve`) |
| `--token <secret>` | `ULTRON_TOKEN` | none | Require `Authorization: Bearer <secret>` for `/api` and `/mcp` |
| `--read-only` | | off | Only expose read tools over MCP |
| `--daily <folder>` | | `Journal` | Folder for daily notes |
| `--no-seed` | | off | Don't create starter notes in an empty vault |

---

## 8. Updating

```bash
cd ultron-mind
git pull
npm install
npm run build
```

Then restart the server or app. With Docker: `git pull && docker compose up -d --build`.

Updates never change your notes.

---

## 9. Uninstalling

1. Stop the server or app (and remove any systemd/pm2 service you created).
2. Delete the `ultron-mind` folder.
3. Your notes stay in your vault folder (e.g. `~/UltronMind`). Delete it only if you no longer want them.
4. The desktop app keeps a tiny settings file in an `Ultron Mind` folder inside your OS's app-data folder (`~/Library/Application Support` on macOS, `%APPDATA%` on Windows, `~/.config` on Linux).
5. Remove Claude's connection: `claude mcp remove ultron-mind`, or delete the entry from `claude_desktop_config.json`.

---

## 10. Troubleshooting

**`EADDRINUSE: address already in use :::4321`**
Something is already using the port, often a previous Ultron Mind. Stop it, or use another port: `npm start -- --port 4322`.

**The page says "Can't reach the Ultron Mind server"**
The server isn't running, or you're using a different port. Check the terminal where you ran `npm start`.

**The browser asks for an "Access token"**
The server was started with `--token` / `ULTRON_TOKEN`. Enter the same value. To clear a saved token, clear the site data for that address in your browser.

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
