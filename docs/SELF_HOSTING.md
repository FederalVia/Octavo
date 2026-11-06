# Run Octavo on your PC as a server

This guide turns your PC into a small, always-on Octavo server with Docker. Your notes stay in a normal folder on your PC, and you can open Octavo from your phone **anywhere**, on mobile data or any Wi-Fi.

| Setup | How your phone reaches it | Needs |
| --- | --- | --- |
| **[A. Tailscale](#a-reach-it-from-anywhere-with-tailscale-recommended)** (recommended) | A private, encrypted network between your own devices, at `https://octavo.<your-tailnet>.ts.net` | A free Tailscale account and the Tailscale app on your phone. No router changes, no domain |
| [B. Your own domain](#b-your-own-public-web-address) | A public web address like `https://mind.example.com` | A domain name, and forwarding ports 80 and 443 on your router |
| [C. Home only](#c-just-this-pc-and-your-home-wi-fi) | Your home Wi-Fi | Nothing extra |

All three share steps 1–3.

---

## 1. Install Docker

- **Windows / Mac:** install [Docker Desktop](https://www.docker.com/products/docker-desktop/). On Windows, accept the WSL 2 option if it asks. Then open Docker Desktop → **Settings → General**, and turn on **Start Docker Desktop when you sign in**.
- **Linux:** install Docker Engine with the Compose plugin ([instructions](https://docs.docker.com/engine/install/)).

Check it works by opening a terminal (PowerShell on Windows) and running:

```bash
docker --version
docker compose version
```

## 2. Get Octavo

```bash
git clone https://github.com/FederalVia/octavo.git
cd octavo
```

No git? On GitHub, click **Code → Download ZIP**, unzip it, and open a terminal in that folder.

## 3. Create your settings file

Copy the example settings file to `.env`:

```bash
cp .env.example .env          # Windows PowerShell: copy .env.example .env
```

Generate an **access key**, a long random secret that protects your notes:

```bash
docker run --rm node:22-slim node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Open `.env` in a text editor and paste the key after `OCTAVO_TOKEN=`.

`OCTAVO_VAULT_DIR=./vault` means your notes will be in a `vault` folder inside `octavo`. Change it to keep them elsewhere, e.g. `OCTAVO_VAULT_DIR=C:/Users/you/Documents/Octavo` or `OCTAVO_VAULT_DIR=/home/you/Octavo`. You can point it at an existing Obsidian vault.

> `.env` contains your secrets. It's already excluded from git, so don't share it.

---

## A. Reach it from anywhere with Tailscale (recommended)

### A1. Set up Tailscale (once)

1. Create a free account at [tailscale.com](https://tailscale.com) (sign in with Google, Microsoft, Apple or GitHub).
2. In the [admin console → DNS](https://login.tailscale.com/admin/dns), make sure **MagicDNS** is on, and click **Enable HTTPS** under *HTTPS Certificates*.
3. In [admin console → Settings → Keys](https://login.tailscale.com/admin/settings/keys), click **Generate auth key**. The defaults are fine. Copy the key (it starts with `tskey-auth-`) and paste it after `TS_AUTHKEY=` in `.env`.
4. Install the **Tailscale app on your phone** (App Store / Play Store) and sign in with the same account.

### A2. Start Octavo

```bash
docker compose -f docker-compose.tailscale.yml up -d
```

The first start builds Octavo, which takes a few minutes. After that it starts in seconds, and Docker restarts it automatically when your PC reboots.

### A3. Find your address and open it on your phone

1. In the [Tailscale admin console → Machines](https://login.tailscale.com/admin/machines) you'll see a machine called **octavo**. Click it, and copy its full name, like `octavo.tail1234.ts.net`.
2. While you're there, click **⋯ → Disable key expiry** for **octavo**. Otherwise Tailscale asks you to log it in again every few months.
3. Print a QR code for your phone (use your address):

   ```bash
   docker compose -f docker-compose.tailscale.yml exec octavo node packages/server/dist/cli.js qr https://octavo.tail1234.ts.net
   ```

4. Make sure Tailscale is switched on on your phone, then scan the QR code. Octavo opens and remembers your access key. The first time can take up to a minute while Tailscale creates the HTTPS certificate.
5. To keep it like an app: **Share → Add to Home Screen** (iPhone) or **⋮ → Install app** (Android).

From now on, open it from your home screen anywhere: your phone just needs Tailscale switched on.

**On the PC itself**, open `http://localhost:4321` and enter the access key once.

---

## B. Your own public web address

Use this if you want a normal web address without installing Tailscale on your devices. Your notes stay protected by the access key, but the address is on the public internet.

1. **Get a domain name** that points at your home's public IP address:
   - The free [DuckDNS](https://www.duckdns.org) gives you something like `yourname.duckdns.org`, and keeps it updated if your home IP changes.
   - Or use a domain you own, with an `A` record pointing at your home IP.
2. **Forward ports 80 and 443** on your router to your PC's local IP address. Look for "port forwarding" in your router's settings.
3. Put the domain in `.env`: `OCTAVO_DOMAIN=yourname.duckdns.org`
4. Start it:

   ```bash
   docker compose -f docker-compose.caddy.yml up -d
   ```

   Caddy gets a free HTTPS certificate automatically.
5. Make the QR code for your phone:

   ```bash
   docker compose -f docker-compose.caddy.yml exec octavo node packages/server/dist/cli.js qr https://yourname.duckdns.org
   ```

## C. Just this PC and your home Wi-Fi

```bash
docker compose up -d
```

Open `http://localhost:4321` on the PC. For your phone on the same Wi-Fi, run:

```bash
docker compose exec octavo node packages/server/dist/cli.js qr http://<your PC's local IP>:4321
```

On Windows, find the IP with `ipconfig` ("IPv4 Address"). On Mac/Linux, use `ipconfig getifaddr en0` / `hostname -I`.

---

## Keep the PC available

- **Don't let it sleep.**
  - Windows: Settings → System → Power → *When plugged in, put my device to sleep after* → **Never**.
  - Mac: System Settings → Energy → turn on **Prevent automatic sleeping when the display is off**.
  - The screen can still turn off.
- Docker Desktop has to start when you sign in (step 1). Octavo then starts by itself.
- If your PC restarts for updates, Octavo comes back once you've signed in.

## Connect Claude to it

On the PC (replace the token with your access key):

```bash
claude mcp add --transport http octavo http://localhost:4321/mcp --header "Authorization: Bearer YOUR_ACCESS_KEY"
```

From another computer on your tailnet, use `https://octavo.tail1234.ts.net/mcp` instead. More in [CONNECT_CLAUDE.md](CONNECT_CLAUDE.md).

## Everyday commands

Run these in the `octavo` folder. Add `-f docker-compose.tailscale.yml` (or `-f docker-compose.caddy.yml`) if you used that setup:

| Do this | Command |
| --- | --- |
| See if it's running | `docker compose ps` |
| See the logs | `docker compose logs -f octavo` |
| Stop | `docker compose down` |
| Start | `docker compose up -d` |
| Update to the latest version | `git pull`, then `docker compose up -d --build` |
| Show the phone QR code again | `docker compose exec octavo node packages/server/dist/cli.js qr <address>` |
| Run a note command | `docker compose exec octavo node packages/server/dist/cli.js tasks` |

**Backups:** your notes are ordinary files in your vault folder, so back them up like any other folder (OneDrive, Time Machine, git, an external drive…). Octavo's bookmarks, settings and version history live in its hidden `.octavo` subfolder.

**Changing the access key:** edit `OCTAVO_TOKEN` in `.env`, run `docker compose up -d` again, then scan a new QR code on each device. Old links stop working.

## Troubleshooting

- **The phone can't connect:** check Tailscale is switched on on the phone, and that `docker compose -f docker-compose.tailscale.yml ps` shows both containers running.
- **"Your connection is not private" / no HTTPS:** enable HTTPS certificates in the Tailscale DNS settings (step A1.2), then restart with `docker compose -f docker-compose.tailscale.yml restart tailscale`.
- **The `octavo` machine doesn't appear in Tailscale:** the auth key may be wrong or expired. Make a new one, update `TS_AUTHKEY` in `.env`, then run `docker compose -f docker-compose.tailscale.yml down` followed by `docker volume rm octavo_tailscale-state` and `up -d` again. Removing that volume makes it register from scratch.
- **"Unauthorized" or a token prompt:** the access key doesn't match `OCTAVO_TOKEN` in `.env`. Make a fresh QR code.
- **Port 4321 is already in use:** the Octavo desktop app or `npm start` is probably running on the same PC. Close it and use the browser instead, or change the port mapping in the compose file.
- **Windows: notes don't update live when edited in another app:** live updates for files changed outside Octavo can lag on Docker Desktop for Windows. Notes are still read fresh when you open them.

Want to run it without Docker? See [INSTALL.md](INSTALL.md#4-keep-it-running-in-the-background).
