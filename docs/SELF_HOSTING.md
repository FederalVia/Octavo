# Use Octavo from anywhere

Your PC is the server: your notes stay in a normal folder on it, and your phone connects to it **directly**, from home Wi-Fi, other Wi-Fi or mobile data. You don't need an account or any app other than your phone's browser.

- [Access from Anywhere (recommended)](#access-from-anywhere)
- [Check your network first](#check-your-network-first)
- [If it doesn't work](#if-it-doesnt-work)
- [Forwarding ports by hand](#forwarding-ports-by-hand)
- [Keep the PC available](#keep-the-pc-available)
- [Running in Docker](#running-in-docker)
- [When direct access is impossible (CGNAT)](#when-direct-access-is-impossible-cgnat)

---

## Access from Anywhere

### With the desktop app

1. Open Octavo (`npm run desktop`, see [INSTALL.md](INSTALL.md#3-desktop-app)).
2. Choose **File → Access from Anywhere** and click **Turn On**.
3. Wait about half a minute while Octavo sets things up. It shows each step.
4. Scan the QR code with your phone's camera.
5. Optional: keep Octavo as an app with **Share → Add to Home Screen** (iPhone) or **⋮ → Install app** (Android).

Octavo stays reachable from anywhere while the desktop app is running. **File → Show Phone QR Code…** shows the code again.

### From a terminal

```bash
npm start -- --remote --vault ~/Octavo
```

This prints the same QR code. Leave the terminal running (or run it as a service, see [INSTALL.md](INSTALL.md#4-keep-it-running-in-the-background)).

### What happens behind the scenes

1. **Your router opens a door.** Octavo asks your router, using the standard UPnP feature most home routers support, to forward two ports to your PC:
   - internet port **443** (HTTPS) → this PC's port 4443
   - internet port **80** → port 4380, used only by Let's Encrypt to confirm the address is yours

   If 443 is taken, Octavo uses 8443 or 47321 instead.
2. **A free HTTPS certificate.** Octavo gets a certificate for your home's internet address from [Let's Encrypt](https://letsencrypt.org). Since 2026, Let's Encrypt issues certificates for plain IP addresses, so no domain name is needed. The connection is encrypted, and your phone shows no warnings. These certificates last about 6 days, and Octavo renews them automatically every 3 days.
3. **A secret access key.** Every request needs the long random key in your QR code. After 10 wrong keys from the same address, that address is locked out for 15 minutes.
4. **Watching for address changes.** Every 5 minutes Octavo checks whether your provider gave your home a new internet address. If it did, Octavo gets a new certificate, and the desktop app shows a notification with a **new QR code**. Scan it once on your phone. Many providers keep your address for months, but some change it more often.

When you turn it off or quit Octavo, the doors in your router are closed again.

---

## Check your network first

```bash
npm run build
node packages/server/dist/cli.js check-remote
```

You'll see something like:

```
✓ Found your router (UPnP router at 192.168.1.1).
✓ Your home has a public internet address: 81.2.69.142
✓ Your router lets Octavo open ports automatically.

Good news: direct access should work.
```

If a line has a ✗, read the explanation underneath it, or see the next section.

---

## If it doesn't work

| What Octavo says | What it means | What to do |
| --- | --- | --- |
| *Couldn't find your router* | UPnP is off, or the router doesn't support it | Turn on **UPnP** in your router's settings (usually under "Advanced" or "NAT"), or [forward ports by hand](#forwarding-ports-by-hand) |
| *Your provider shares one public address between many homes (CGNAT)* | Nothing on the internet can connect into your home | Ask your provider for a **public IPv4 address**. It's often free, sometimes a small fee. Otherwise see [the CGNAT section](#when-direct-access-is-impossible-cgnat) |
| *Your router is behind another router* | E.g. your provider's modem/router plus your own Wi-Fi router | Put the provider's box in **bridge mode**, or enable UPnP/port forwarding on the outer router too |
| *Refused to forward port 80* | The router won't open port 80 | Check the router's UPnP settings, or forward 80 → 4380 by hand |
| *Let's Encrypt couldn't reach this computer* | Port 80 is blocked by your provider or a firewall | Allow Octavo through your PC's firewall (Windows asks the first time: allow on **private and public** networks), then try again |

**At home, the link doesn't open but it works on mobile data:** some routers can't connect to their own public address from inside the home network (this is called missing "NAT loopback"). Use mobile data, or open the Wi-Fi link (**File → Use on Your Phone (Wi-Fi)**) while you're at home.

---

## Forwarding ports by hand

If your router has no UPnP, forward these two ports in its settings (look for "Port forwarding" or "Virtual server"):

| Internet port | To this PC's address | PC port | Protocol |
| --- | --- | --- | --- |
| 443 | your PC's local IP, e.g. `192.168.1.20` | 4443 | TCP |
| 80 | your PC's local IP | 4380 | TCP |

Find your PC's local IP with `ipconfig` on Windows ("IPv4 Address"), or `ipconfig getifaddr en0` / `hostname -I` on Mac/Linux. It's best to give your PC a fixed local IP in the router.

Then tell Octavo your public IP address (shown in your router's status page, or search "what is my IP"):

```bash
npm start -- --remote --public-ip 81.2.69.142
```

For the desktop app, set the environment variable `OCTAVO_PUBLIC_IP=81.2.69.142` before starting it.

---

## Keep the PC available

- **Don't let it sleep.**
  - Windows: Settings → System → Power → *When plugged in, put my device to sleep after* → **Never**.
  - Mac: System Settings → Energy → turn on **Prevent automatic sleeping when the display is off**.
  - The screen can still turn off.
- **Start Octavo automatically.** Add the desktop app to your startup apps, or run `npm start -- --remote` as a service ([INSTALL.md](INSTALL.md#4-keep-it-running-in-the-background)).

---

## Running in Docker

Automatic router setup needs to talk to the router directly, which Docker Desktop on Windows and Mac can't do from inside a container. For Access from Anywhere, use the desktop app or `npm start -- --remote`, which do the same job without Docker.

Docker is still handy for running Octavo at home or behind your own domain:

1. Copy `.env.example` to `.env` and set `OCTAVO_TOKEN` to a long random secret:

   ```bash
   docker run --rm node:22-slim node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```

2. Start one of these:

| Setup | Command |
| --- | --- |
| This PC and your home Wi-Fi | `docker compose up -d`, then open `http://localhost:4321` |
| Your own domain with automatic HTTPS | Set `OCTAVO_DOMAIN` in `.env`, forward ports 80 and 443 to the PC, then `docker compose -f docker-compose.caddy.yml up -d` |

Show a phone QR code for any address with:

```bash
docker compose exec octavo node packages/server/dist/cli.js qr <address>
```

Notes are kept in the folder set by `OCTAVO_VAULT_DIR` (default `./vault`). To update: `git pull`, then `docker compose up -d --build`.

---

## When direct access is impossible (CGNAT)

If your provider uses CGNAT and won't give you a public address, no app can connect directly into your home. The way around it is a relay service in the middle. [Tailscale](https://tailscale.com) is free for personal use. `docker-compose.tailscale.yml` contains a ready-made setup, with instructions at the top of that file.

---

## Connect Claude to it

On the PC:

```bash
claude mcp add --transport http octavo http://localhost:4321/mcp --header "Authorization: Bearer YOUR_ACCESS_KEY"
```

The access key is in the QR link after `?token=`. It's stored in `~/.octavo/phone-token` for the terminal version, or in the desktop app's settings folder.
