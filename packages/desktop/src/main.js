import { app, BrowserWindow, Menu, Notification, clipboard, dialog, ipcMain, session, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import updaterPkg from 'electron-updater';
import { startServer, seedIfEmpty, lanAddresses, loadOrCreateToken, phoneUrl, qrDataUrl, RemoteAccess, diagnose, importNotion, importEnex } from '@octavo/server';

const require = createRequire(import.meta.url);
const DEFAULT_PORT = 4321;

/** @type {import('@octavo/server').RunningServer | null} */
let server = null;
/** @type {BrowserWindow | null} */
let win = null;

// ------------------------------------------------------------------ config

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

// ------------------------------------------------------------------ server

/** Notes from other apps: folders on this PC mirrored into each brain (kept per PC, never in the vault or over the web API). */
function syncFoldersFor(vaultPath) {
  const all = loadConfig().syncFolders ?? {};
  const list = all[path.resolve(vaultPath)];
  return Array.isArray(list) ? list.filter((f) => f && typeof f.source === 'string') : [];
}
function saveSyncFolders(vaultPath, list) {
  const cfg = loadConfig();
  cfg.syncFolders = { ...(cfg.syncFolders ?? {}), [path.resolve(vaultPath)]: list };
  saveConfig(cfg);
  server?.folderSync.setFolders(list);
}

const phoneEnabled = () => !!loadConfig().phoneAccess;
const remoteEnabled = () => !!loadConfig().remoteAccess;
/** Any outside access (Wi-Fi or internet) means the server needs the access key. */
const needsKey = () => phoneEnabled() || remoteEnabled();
/** @type {import('@octavo/server').RemoteAccess | null} */
let remote = null;
/** @type {BrowserWindow | null} */
let accessWin = null;
const phoneToken = () => loadOrCreateToken(path.join(app.getPath('userData'), 'phone-token'));

/** URL the desktop window loads (carries the access key when phone access is on). */
function windowUrl() {
  if (!server) return '';
  return needsKey() ? `${server.url}/?token=${encodeURIComponent(phoneToken())}` : server.url;
}

async function openVault(vaultPath, { autoRemote = true } = {}) {
  if (remote) {
    await remote.stop();
    remote = null;
  }
  if (server) {
    await server.close();
    server = null;
  }
  const phone = phoneEnabled();
  server = await startServer({
    vaultPath,
    port: DEFAULT_PORT,
    // Phone access: listen on the Wi-Fi network, protected by an access key.
    host: phone ? '0.0.0.0' : '127.0.0.1',
    token: needsKey() ? phoneToken() : undefined,
    webDir: webDir(),
    fallbackToRandomPort: true,
    watchFolders: syncFoldersFor(vaultPath),
    // Settings → Connect an AI: the name this brain has in AI tools, and how a tool can start the server itself.
    connect: { name: brainsState().brains.find((b) => samePath(b.path, vaultPath))?.mcpName ?? mcpNames()[0] ?? 'octavo', stdio: mcpEntry(vaultPath) },
  });
  await seedIfEmpty(server.vault);
  rememberBrain(vaultPath);
  if (win) {
    win.setTitle(`${path.basename(vaultPath)} · Octavo`);
    await win.loadURL(windowUrl());
  }
  buildMenu();
  if (autoRemote && remoteEnabled()) startRemote(false);
}

// ------------------------------------------------------------------ updates

const { autoUpdater } = updaterPkg;
const RELEASES_URL = 'https://github.com/FederalVia/Octavo/releases';
const IS_MAC = process.platform === 'darwin';
/** What the Settings panel and the update banner show. */
let updateState = { status: 'idle', current: app.getVersion() };

function setUpdate(patch) {
  updateState = { ...updateState, ...patch };
  if (win && !win.isDestroyed()) win.webContents.send('octavo:update', updateState);
  buildMenu();
}

function friendlyUpdateError(err) {
  const msg = String(err?.message ?? err);
  if (/404|401|403|private|authentication/i.test(msg)) {
    return 'Couldn’t read the releases on GitHub. If the repository is private, the app can’t check for updates. Download new versions from the Releases page instead.';
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|net::/i.test(msg)) return 'No internet connection. Octavo will try again later.';
  return msg.split('\n')[0].slice(0, 200);
}

function initUpdater() {
  if (!app.isPackaged) {
    updateState = { ...updateState, status: 'unsupported', error: 'Updates are only available in the installed app.' };
    return;
  }
  // Test builds (versions like 1.1.0-beta.1) are pre-releases: only copies that are test builds themselves get
  // offered them. 0.x builds had this on, which is how they find 1.0.
  autoUpdater.allowPrerelease = app.getVersion().includes('-');
  // macOS can only auto-install apps signed with a paid Apple certificate: there we notify and link to the download.
  autoUpdater.autoDownload = !IS_MAC;
  autoUpdater.autoInstallOnAppQuit = !IS_MAC;
  // For testing against a local server: OCTAVO_UPDATE_URL=http://127.0.0.1:8000/
  if (process.env.OCTAVO_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.OCTAVO_UPDATE_URL });
  if (!autoUpdater.isUpdaterActive()) {
    // e.g. Linux when not run from the AppImage
    updateState = { ...updateState, status: 'unsupported', error: 'This copy can’t update itself. Download new versions from the Releases page.' };
    return;
  }
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking', error: undefined }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'up-to-date', checkedAt: Date.now() }));
  autoUpdater.on('update-available', (info) =>
    setUpdate({ status: IS_MAC ? 'available' : 'downloading', version: info.version, progress: 0, checkedAt: Date.now() }),
  );
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', progress: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    setUpdate({ status: 'ready', version: info.version, progress: 100 });
    new Notification({ title: `Octavo ${info.version} is ready`, body: 'Restart Octavo to finish updating.' }).show();
  });
  autoUpdater.on('error', (err) => setUpdate({ status: 'error', error: friendlyUpdateError(err) }));
  setTimeout(() => checkForUpdates(), 10_000);
  setInterval(() => checkForUpdates(), 6 * 3600 * 1000).unref?.();
}

async function checkForUpdates() {
  if (updateState.status === 'unsupported') return updateState;
  if (['checking', 'downloading', 'ready'].includes(updateState.status)) return updateState;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setUpdate({ status: 'error', error: friendlyUpdateError(err) });
  }
  return updateState;
}

/**
 * Process IDs of the Octavo copies Claude Desktop runs in the background as its
 * memory (MCP) server. They keep Octavo.exe in use, so Windows can't replace it.
 */
function claudeCopies() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const exe = process.execPath.replace(/'/g, "''");
  const ps =
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe}' -and ` +
    `$_.CommandLine -like '*cli.mjs*' -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { $_.ProcessId }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20_000, windowsHide: true }, (err, stdout) =>
      resolve(err ? [] : String(stdout).split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger)),
    );
  });
}

function killProcesses(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
}

async function installUpdate() {
  if (updateState.status === 'ready') {
    const copies = await claudeCopies();
    if (copies.length) {
      const { response } = await dialog.showMessageBox(win ?? undefined, {
        type: 'info',
        title: 'Update Octavo',
        message: 'Claude is using Octavo right now',
        detail:
          'Claude Desktop runs Octavo in the background as its memory. To update, Octavo will close that connection.\n\n' +
          'When the update is done, quit Claude (right-click its icon next to the clock → Quit) and open it again so it reconnects.',
        buttons: ['Update now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return updateState;
      killProcesses(copies);
      await new Promise((r) => setTimeout(r, 1500));
    }
    // Closes Octavo, installs the new version and starts it again.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  } else if (updateState.status === 'available' && updateState.version) {
    shell.openExternal(`${RELEASES_URL}/tag/v${updateState.version}`);
  }
  return updateState;
}

// ------------------------------------------------------------------ access from anywhere

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function pageHtml(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{margin:0;background:#141317;color:#e9e5dc;font:14px -apple-system,system-ui,sans-serif;text-align:center;padding:24px}
img{border-radius:12px;width:280px;height:280px}code{display:block;word-break:break-all;background:#1f1e24;padding:8px;border-radius:6px;margin:12px 0;font-size:12px}
p{color:#a8a397;line-height:1.5;margin:8px 0;white-space:pre-line}b{color:#e9e5dc}.err{color:#f8a3a3}.big{font-size:40px;margin:30px 0 10px}</style>${body}`;
}

/** One window for Wi-Fi/internet access: progress, QR code, or what went wrong. */
async function showAccessWindow(html, { wide = false } = {}) {
  if (accessWin && !accessWin.isDestroyed()) accessWin.setSize(wide ? 760 : 440, 680);
  if (!accessWin || accessWin.isDestroyed()) {
    accessWin = new BrowserWindow({
      width: wide ? 760 : 440,
      height: 680,
      parent: win ?? undefined,
      title: 'Open on your phone',
      backgroundColor: '#141317',
      autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
    });
    accessWin.on('closed', () => (accessWin = null));
  }
  await accessWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  accessWin.show();
}

async function qrPage(url, where) {
  const link = `${url}/?token=${encodeURIComponent(phoneToken())}`;
  const qr = await qrDataUrl(link);
  return pageHtml(
    'Open on your phone',
    `<h2>Scan with your phone</h2><img src="${qr}" alt="QR code"><code>${esc(link)}</code>
<p>${where}</p>
<p>Then use <b>Share → Add to Home Screen</b> (iPhone) or <b>⋮ → Install app</b> (Android) to keep it as an app.</p>
<p>Treat this code like a password: anyone who scans it can read and edit your notes.</p>`,
  );
}

/** Access-from-anywhere log, kept so problems can be looked at later (Settings → Use on your phone → Show log). */
const remoteLogPath = () => path.join(app.getPath('userData'), 'remote', 'log.txt');
function remoteLog(message) {
  console.log(`[octavo] ${message}`);
  try {
    const file = remoteLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 200_000) fs.writeFileSync(file, '');
    fs.appendFileSync(file, `${new Date().toISOString()}  ${message}\n`);
  } catch {
    /* logging must never break anything */
  }
}

let remoteRetries = 0;
let remoteRetryTimer = null;
const RETRY_MINUTES = [1, 2, 5, 10];
function scheduleRemoteRetry() {
  if (remoteRetryTimer || !remoteEnabled()) return;
  const minutes = RETRY_MINUTES[Math.min(remoteRetries, RETRY_MINUTES.length - 1)];
  remoteRetries++;
  remoteLog(`Will try again in ${minutes} min`);
  remoteRetryTimer = setTimeout(() => {
    remoteRetryTimer = null;
    if (remoteEnabled() && server && remote?.current?.state === 'error') startRemote(false).catch((err) => remoteLog(`Retry failed: ${err}`));
  }, minutes * 60 * 1000);
  remoteRetryTimer.unref?.();
}

async function startRemote(showWindow) {
  if (!server) return;
  if (showWindow) remoteRetries = 0;
  if (remoteRetryTimer) {
    clearTimeout(remoteRetryTimer);
    remoteRetryTimer = null;
  }
  // Never expose the server to the internet without the access key.
  if (!needsKey()) throw new Error('Remote access requires the access key to be enabled');
  if (remote) await remote.stop();
  remote = new RemoteAccess({
    app: server.app,
    stateDir: path.join(app.getPath('userData'), 'remote'),
      // Hard guard: the local server must reject requests without the access key.
      requireToken: async () => (await fetch(`${server.url}/api/vault`).then((r) => r.status).catch(() => 0)) === 401,
    // Advanced: ports forwarded by hand / testing against another ACME server.
    ...(process.env.OCTAVO_PUBLIC_IP ? { publicIp: process.env.OCTAVO_PUBLIC_IP } : {}),
    ...(process.env.OCTAVO_ACME_DIRECTORY ? { directoryUrl: process.env.OCTAVO_ACME_DIRECTORY } : {}),
    ...(process.env.OCTAVO_HTTPS_PORT
      ? { httpsPort: Number(process.env.OCTAVO_HTTPS_PORT), externalHttpsPorts: [Number(process.env.OCTAVO_HTTPS_PORT)] }
      : {}),
    ...(process.env.OCTAVO_CHALLENGE_PORT ? { challengePort: Number(process.env.OCTAVO_CHALLENGE_PORT) } : {}),
    log: (m) => remoteLog(m),
  });
  remote.on('status', async (s) => {
    buildMenu();
    if (s.state === 'error') remoteLog(`Problem: ${s.step}${s.advice ? ` — ${s.advice}` : ''}`);
    else if (s.state === 'ready') remoteLog(`Ready: ${s.url}`);
    // Router restarting (power cut), not ready yet at boot, network down: keep trying in the background.
    if (s.state === 'error') scheduleRemoteRetry();
    else if (s.state === 'ready') remoteRetries = 0;
    // Started automatically with the app: nobody is watching, so say so when it fails (once per outage).
    if (!showWindow && s.state === 'error' && remoteRetries <= 1) {
      const n = new Notification({ title: 'Octavo: access from anywhere isn’t working', body: `${s.step} Open Settings → Use on your phone for details.` });
      n.on('click', () => {
        win?.show();
        win?.webContents.send('octavo:open-settings', 'phone');
      });
      n.show();
    }
    if (!showWindow && !(accessWin && !accessWin.isDestroyed())) return;
    if (s.state === 'starting') {
      await showAccessWindow(pageHtml('Setting up', `<div class="big">⏳</div><h2>Setting up access from anywhere</h2><p>${esc(s.step)}</p><p>This usually takes under a minute.</p>`));
    } else if (s.state === 'ready') {
      await showAccessWindow(await qrPage(s.url, 'Works away from home: mobile data and other Wi-Fi. Many routers can’t open it from your own home Wi-Fi; for home, also turn on <b>Home Wi-Fi only</b>.'));
    } else if (s.state === 'error') {
      await showAccessWindow(pageHtml('Couldn’t set up', `<div class="big">⚠️</div><h2>${esc(s.step)}</h2><p class="err">${esc(s.advice ?? '')}</p>`));
    }
  });
  remote.on('address-changed', async (s) => {
    new Notification({ title: 'Octavo: scan the new code', body: 'Your home internet address changed, so your phone needs the new QR code.' }).show();
    await showAccessWindow(await qrPage(s.url, 'Your home internet address changed. Scan this new code on your phone.'));
  });
  return remote.start();
}

/** One-click version of `octavo check-remote`: can this network accept direct connections? */
async function checkNetwork() {
  await showAccessWindow(pageHtml('Checking', `<div class="big">🔎</div><h2>Checking your network…</h2><p>Looking for your router. This takes up to 10 seconds.</p>`));
  let result;
  try {
    result = await diagnose();
  } catch (err) {
    result = { ok: false, lines: [`✗ ${err instanceof Error ? err.message : err}`] };
  }
  const advice = {
    'no-router': 'Turn on “UPnP” in your router’s settings, restart the router, then check again. Or forward ports by hand: see “Forwarding ports by hand” in the Octavo guide.',
    cgnat: 'Your internet provider shares one public address between many homes (CGNAT), so direct connections from the internet are impossible on this connection. Ask your provider for a “public IPv4 address”.',
    'double-nat': 'Your router is behind another router. Put your provider’s box in “bridge mode”, or enable UPnP on the outer router too.',
    'port-https': 'Your router refused to open a port automatically. Check its UPnP settings.',
  }[result.problem] ?? '';
  await showAccessWindow(
    pageHtml(
      'Network check',
      `<div class="big">${result.ok ? '✅' : '⚠️'}</div><h2>${result.ok ? 'Direct access should work' : 'Direct access won’t work yet'}</h2>
<p style="text-align:left;display:inline-block">${result.lines.map(esc).join('<br>')}</p>
${result.ok ? '<p>Turn it on with <b>File → Access from Anywhere</b>.</p>' : `<p class="err">${esc(advice)}</p>`}`,
    ),
  );
}

async function toggleRemoteAccess() {
  const enable = !remoteEnabled();
  if (enable) {
    const { response } = await dialog.showMessageBox(win ?? undefined, {
      type: 'question',
      message: 'Open Octavo to the internet?',
      detail:
        'Octavo will ask your router to open two ports, get a free HTTPS certificate for your home’s internet address, and show a QR code. Your phone can then open your notes from anywhere, protected by HTTPS and a secret access key.\n\nThis computer must stay on and awake.',
      buttons: ['Turn On', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  saveConfig({ ...loadConfig(), remoteAccess: enable });
  if (!enable) {
    if (remote) await remote.stop();
    remote = null;
    if (accessWin && !accessWin.isDestroyed()) accessWin.close();
  }
  // Restart the server so the access key requirement matches the setting.
  if (server) {
    const root = server.vault.root;
    if (enable) {
      // Restart with the access key required, then start remote access with progress shown.
      await openVault(root, { autoRemote: false });
      await startRemote(true);
    } else {
      await openVault(root);
    }
  }
  buildMenu();
}

// ------------------------------------------------------------------ brains (separate vaults)

const defaultVault = () => path.join(os.homedir(), 'Octavo');
const brainsDir = () => path.join(os.homedir(), 'Octavo Brains');
const samePath = (a, b) => {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'linux' ? norm(a) === norm(b) : norm(a).toLowerCase() === norm(b).toLowerCase();
};

/** @returns {{ name: string, path: string }[]} */
function brainList() {
  const list = loadConfig().brains;
  return Array.isArray(list) ? list.filter((b) => b && typeof b.path === 'string' && typeof b.name === 'string') : [];
}

function rememberBrain(vaultPath) {
  const cfg = loadConfig();
  const list = brainList();
  if (!list.some((b) => samePath(b.path, vaultPath))) list.push({ name: path.basename(vaultPath) || 'Octavo', path: vaultPath });
  saveConfig({ ...cfg, vaultPath, brains: list });
}

/** The name Claude sees for a brain's tools: "octavo" for the original brain, "octavo-<name>" for the others. */
function mcpNames() {
  const used = new Set();
  return brainList().map((b) => {
    let base = samePath(b.path, defaultVault())
      ? 'octavo'
      : `octavo-${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'brain'}`;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
    used.add(name);
    return name;
  });
}

function brainsState() {
  const names = mcpNames();
  return {
    brains: brainList().map((b, i) => ({
      name: b.name,
      path: b.path,
      mcpName: names[i],
      current: !!server && samePath(server.vault.root, b.path),
    })),
    folder: brainsDir(),
  };
}

const findBrain = (p) => brainList().find((b) => typeof p === 'string' && samePath(b.path, p));

async function switchBrain(p) {
  const b = findBrain(p);
  if (!b || (server && samePath(server.vault.root, b.path))) return;
  await openVault(b.path);
}

async function createBrain(rawName) {
  const name = String(rawName ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60);
  if (!name) throw new Error('Give the brain a name.');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) throw new Error('That name isn’t allowed on Windows.');
  if (brainList().some((b) => b.name.toLowerCase() === name.toLowerCase())) throw new Error(`You already have a brain called “${name}”.`);
  const dir = path.join(brainsDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  await openVault(dir);
}

function removeBrain(p) {
  const b = findBrain(p);
  if (!b || (server && samePath(server.vault.root, b.path))) return;
  // Only forgets it: the notes stay in their folder.
  saveConfig({ ...loadConfig(), brains: brainList().filter((x) => !samePath(x.path, b.path)) });
  buildMenu();
}

/** claude_desktop_config.json entry for one brain. */
function mcpEntry(vaultPath) {
  return {
    command: process.execPath,
    args: [serverCliPath(), 'mcp', '--vault', vaultPath],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/** Claude Desktop JSON for one brain (by path) or, with no path, all of them. */
function brainsClaudeJson(p) {
  const { brains } = brainsState();
  const chosen = p ? brains.filter((b) => samePath(b.path, p)) : brains;
  return JSON.stringify({ mcpServers: Object.fromEntries(chosen.map((b) => [b.mcpName, mcpEntry(b.path)])) }, null, 2);
}

/** File → Import: Notion export folder or Evernote .enex file, into the open brain. */
async function runImport(kind) {
  if (!server) return;
  const notion = kind === 'notion';
  const res = await dialog.showOpenDialog(win ?? undefined, notion
    ? { title: 'Choose your unzipped Notion export folder', buttonLabel: 'Import', properties: ['openDirectory'] }
    : { title: 'Choose an Evernote export', buttonLabel: 'Import', properties: ['openFile'], filters: [{ name: 'Evernote export', extensions: ['enex'] }] });
  if (res.canceled || !res.filePaths[0]) return;
  try {
    const r = notion ? await importNotion(server.vault, res.filePaths[0]) : await importEnex(server.vault, res.filePaths[0]);
    await dialog.showMessageBox(win ?? undefined, {
      type: 'info',
      message: `Imported ${r.notes} note${r.notes === 1 ? '' : 's'}`,
      detail: `They’re in the “${r.folder}” folder${r.attachments ? `, with ${r.attachments} attachment${r.attachments === 1 ? '' : 's'}` : ''}.${r.skipped.length ? `\n\nSkipped:\n${r.skipped.slice(0, 10).join('\n')}` : ''}`,
    });
  } catch (err) {
    await dialog.showMessageBox(win ?? undefined, { type: 'error', message: 'Import failed', detail: err instanceof Error ? err.message : String(err) });
  }
}

async function chooseVault() {
  const res = await dialog.showOpenDialog(win ?? undefined, {
    title: 'Open or create a vault folder',
    buttonLabel: 'Open Vault',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!res.canceled && res.filePaths[0]) await openVault(res.filePaths[0]);
}

// ------------------------------------------------------------------ Claude connection info

// In a packaged release the server CLI and web UI are bundled next to main.mjs.
const PACKAGED = app.isPackaged;

function serverCliPath() {
  if (PACKAGED) return path.join(app.getAppPath(), 'cli.mjs');
  return path.join(path.dirname(require.resolve('@octavo/server/package.json')), 'dist', 'cli.js');
}

function webDir() {
  return PACKAGED ? path.join(app.getAppPath(), 'web') : undefined;
}

// ------------------------------------------------------------------ phone access

async function showPhoneQr() {
  if (!server) return;
  if (remote && remote.current.state === 'ready') {
    const away = `${remote.current.url}/?token=${encodeURIComponent(phoneToken())}`;
    const home = phoneEnabled() && lanAddresses()[0] ? phoneUrl(lanAddresses()[0], server.port, phoneToken()) : null;
    if (!home) {
      await showAccessWindow(await qrPage(remote.current.url, 'Works away from home: mobile data and other Wi-Fi. Many routers can’t open it from your own home Wi-Fi; for that, also turn on <b>Home Wi-Fi only</b>.'));
      return;
    }
    // Both on: one code for home, one for away (most routers can't reach their own internet address from inside).
    const [qrHome, qrAway] = await Promise.all([qrDataUrl(home), qrDataUrl(away)]);
    await showAccessWindow(
      pageHtml(
        'Open on your phone',
        `<h2>Scan with your phone</h2>
<div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap">
<div style="flex:1;min-width:220px"><h3>At home</h3><img src="${qrHome}" alt="QR code for home Wi-Fi" style="width:220px;height:220px"><code>${esc(home)}</code><p>On your home Wi-Fi.</p></div>
<div style="flex:1;min-width:220px"><h3>Away</h3><img src="${qrAway}" alt="QR code for away" style="width:220px;height:220px"><code>${esc(away)}</code><p>Mobile data and other Wi-Fi.</p></div>
</div>
<p>Add each to your home screen (<b>Share → Add to Home Screen</b> on iPhone) and name them, e.g. “Octavo” and “Octavo (away)”. Same notes, same key.</p>
<p>Treat these codes like a password: anyone who scans one can read and edit your notes.</p>`,
      ),
      { wide: true },
    );
    return;
  }
  if (!phoneEnabled()) {
    if (remote) await showAccessWindow(pageHtml('Not ready', `<div class="big">⚠️</div><h2>${esc(remote.current.step)}</h2><p class="err">${esc(remote.current.advice ?? '')}</p>`));
    return;
  }
  const addrs = lanAddresses();
  if (!addrs.length) {
    await dialog.showMessageBox(win ?? undefined, {
      type: 'warning',
      message: 'No Wi-Fi network found',
      detail: 'Connect this computer to the same Wi-Fi as your phone, then try again.',
    });
    return;
  }
  const url = phoneUrl(addrs[0], server.port, phoneToken());
  const qr = await qrDataUrl(url);
  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<!doctype html><meta charset="utf-8"><title>Open on your phone</title>
<style>body{margin:0;background:#141317;color:#e9e5dc;font:14px -apple-system,system-ui,sans-serif;text-align:center;padding:24px}
img{border-radius:12px;width:280px;height:280px}code{display:block;word-break:break-all;background:#1f1e24;padding:8px;border-radius:6px;margin:12px 0;font-size:12px}
p{color:#a8a397;line-height:1.5;margin:8px 0}b{color:#e9e5dc}</style>
<h2>Scan with your phone</h2><img src="${qr}" alt="QR code"><code>${esc(url)}</code>
<p>Your phone must be on the <b>same Wi-Fi</b>. Then use <b>Share → Add to Home Screen</b> (iPhone) or <b>⋮ → Install app</b> (Android) to keep it as an app.</p>
<p>Treat this code like a password: anyone who scans it can read and edit your notes.</p>`;
  const qrWin = new BrowserWindow({
    width: 420,
    height: 640,
    parent: win ?? undefined,
    title: 'Open on your phone',
    backgroundColor: '#141317',
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  await qrWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function togglePhoneAccess() {
  const enable = !phoneEnabled();
  if (enable) {
    const { response } = await dialog.showMessageBox(win ?? undefined, {
      type: 'question',
      message: 'Open Octavo to your phone?',
      detail:
        'Octavo will be reachable from devices on this Wi-Fi network, protected by a secret access key in the QR code. Only turn this on for networks you trust, such as your home Wi-Fi.',
      buttons: ['Turn On', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  saveConfig({ ...loadConfig(), phoneAccess: enable });
  if (server) await openVault(server.vault.root);
  buildMenu();
  if (enable) await showPhoneQr();
}

// ------------------------------------------------------------------ window & menu

function sendShortcut(key, shift = false) {
  win?.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: key,
    modifiers: [process.platform === 'darwin' ? 'meta' : 'control', ...(shift ? ['shift'] : [])],
  });
}

function openBrainSettings() {
  win?.show();
  win?.webContents.send('octavo:open-settings', 'brains');
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', registerAccelerator: false, click: () => sendShortcut('N') },
        { label: 'Quick Switcher…', accelerator: 'CmdOrCtrl+O', registerAccelerator: false, click: () => sendShortcut('O') },
        { label: "Today's Journal", accelerator: 'CmdOrCtrl+D', registerAccelerator: false, click: () => sendShortcut('D') },
        { type: 'separator' },
        {
          label: 'Brains',
          submenu: [
            ...brainsState().brains.map((b) => ({
              label: b.name,
              type: 'radio',
              checked: b.current,
              click: () => switchBrain(b.path),
            })),
            { type: 'separator' },
            { label: 'New Brain…', click: openBrainSettings },
            { label: 'Add Existing Folder as Brain…', accelerator: 'CmdOrCtrl+Shift+O', click: chooseVault },
            { label: 'Open Markdown File…', click: chooseMarkdownFile },
            { label: 'Manage Brains…', click: openBrainSettings },
          ],
        },
        {
          label: 'Import',
          enabled: !!server,
          submenu: [
            { label: 'From Notion (unzipped export folder)…', click: () => runImport('notion') },
            { label: 'From Evernote (.enex file)…', click: () => runImport('enex') },
          ],
        },
        {
          label: 'Reveal Brain Folder',
          enabled: !!server,
          click: () => server && shell.openPath(server.vault.root),
        },
        { type: 'separator' },
        { label: 'Connect an AI (Claude, Codex, Cursor…)…', click: () => win?.webContents.send('octavo:open-settings', 'connect') },
        {
          label:
            updateState.status === 'ready'
              ? `Restart to Update to ${updateState.version}`
              : updateState.status === 'available'
                ? `Download Octavo ${updateState.version}…`
                : 'Check for Updates…',
          click: () => (['ready', 'available'].includes(updateState.status) ? installUpdate() : checkForUpdates()),
        },
        { type: 'separator' },
        { label: 'Use on Your Phone (Wi-Fi)', type: 'checkbox', checked: phoneEnabled(), click: togglePhoneAccess },
        { label: 'Access from Anywhere', type: 'checkbox', checked: remoteEnabled(), click: toggleRemoteAccess },
        { label: 'Check Network for Access from Anywhere…', click: checkNetwork },
        { label: 'Show Phone QR Code…', enabled: needsKey() && !!server, click: showPhoneQr },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Search', accelerator: 'CmdOrCtrl+Shift+F', registerAccelerator: false, click: () => sendShortcut('F', true) },
        { label: 'Back to Brain', accelerator: 'CmdOrCtrl+G', registerAccelerator: false, click: () => sendShortcut('G') },
        { label: 'Toggle Edit / Preview', accelerator: 'CmdOrCtrl+E', registerAccelerator: false, click: () => sendShortcut('E') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 420,
    minHeight: 400,
    title: 'Octavo',
    backgroundColor: '#1b1a21',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Lets Settings show the phone/remote-access controls (see preload.cjs).
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
    },
  });

  // Open external links in the system browser; keep the app on its own origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (server && !url.startsWith(server.url)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

// ------------------------------------------------------------------ lifecycle

// ------------------------------------------------------------------ octavo:// links

const PROTOCOL = 'octavo';
const findLink = (argv) => argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${PROTOCOL}://`)) ?? null;
/** A link Octavo was started with, handled once the vault is open. */
let pendingLink = findLink(process.argv);
let ready = false;

function registerProtocol() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else app.setAsDefaultProtocolClient(PROTOCOL);
  } catch {
    /* not fatal */
  }
}

/** octavo://open?vault=<brain name>&file=<note name or path>[&heading=<heading>] */
async function handleLink(link) {
  console.log(`[octavo] opening link ${link}`);
  let u;
  try {
    u = new URL(link);
  } catch {
    return;
  }
  if (u.protocol !== `${PROTOCOL}:`) return;
  const action = (u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase();
  if (action !== 'open') return;
  const vault = u.searchParams.get('vault');
  const file = u.searchParams.get('file') ?? '';
  const heading = u.searchParams.get('heading') ?? '';
  if (vault) {
    const b = brainList().find((x) => x.name.toLowerCase() === vault.toLowerCase());
    if (!b) {
      await dialog.showMessageBox(win ?? undefined, { type: 'warning', message: `There’s no brain called “${vault}”`, detail: 'Check Settings → Brains for its name.' });
      return;
    }
    if (!server || !samePath(server.vault.root, b.path)) await switchBrain(b.path);
  }
  if (!win || !server) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (!file) return;
  const resolved = server.vault.resolve(file);
  if (!resolved) {
    await dialog.showMessageBox(win, { type: 'warning', message: `“${file}” isn’t in ${path.basename(server.vault.root)}` });
    return;
  }
  const hash = `#/note/${resolved.split('/').map(encodeURIComponent).join('/')}`;
  // Same-page navigation: the app follows hash changes without reloading.
  await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}; void 0;`).catch(() => {});
  if (heading) {
    await win.webContents
      .executeJavaScript(`window.dispatchEvent(new CustomEvent('octavo:heading', { detail: ${JSON.stringify(heading)} })); void 0;`)
      .catch(() => {});
  }
}

/** Show a note in the main window (same-page navigation, no reload). */
async function showNote(rel) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const go = async () => {
    const hash = `#/note/${rel.split('/').map(encodeURIComponent).join('/')}`;
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}; void 0;`).catch(() => {});
  };
  if (win.webContents.isLoading()) setTimeout(() => showNote(rel), 200);
  else await go();
}

/** Open a Markdown file from anywhere: in its brain if it's in one, otherwise its folder becomes a brain. */
async function openMarkdownFile(file) {
  if (!/\.(md|markdown)$/i.test(file) || !fs.existsSync(file)) return;
  const abs = path.resolve(file);
  const inside = (root) => {
    const rel = path.relative(root, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
  };
  let brain = brainList().find((b) => inside(b.path));
  if (!brain) {
    const dir = path.dirname(abs);
    const { response } = await dialog.showMessageBox(win ?? undefined, {
      type: 'question',
      message: `Open “${path.basename(abs)}” in Octavo?`,
      detail: `Its folder (${dir}) will be added as a brain, so links between the notes in it work. Nothing is moved or changed.`,
      buttons: ['Open', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    await openVault(dir);
    brain = brainList().find((b) => samePath(b.path, dir));
  } else if (!server || !samePath(server.vault.root, brain.path)) {
    await switchBrain(brain.path);
  }
  const rel = brain && inside(brain.path);
  if (rel) await showNote(rel.replace(/\.markdown$/i, '.md'));
}

async function chooseMarkdownFile() {
  const res = await dialog.showOpenDialog(win ?? undefined, {
    title: 'Open a Markdown file',
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  });
  if (!res.canceled && res.filePaths[0]) await openMarkdownFile(res.filePaths[0]);
}

const findMdFile = (argv) => argv.slice(1).find((a) => typeof a === 'string' && /\.(md|markdown)$/i.test(a) && !a.startsWith('-')) ?? null;
let pendingFile = findMdFile(process.argv);

app.on('open-file', (e, file) => {
  // macOS: double-clicked .md files (also at launch).
  e.preventDefault();
  if (ready) openMarkdownFile(file);
  else pendingFile = file;
});

app.on('open-url', (e, link) => {
  // macOS delivers links here, also at launch (before the app is ready).
  e.preventDefault();
  if (ready) handleLink(link);
  else pendingLink = link;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    // Windows and Linux pass the link as a command-line argument to a second copy.
    const link = findLink(argv);
    if (link && ready) handleLink(link);
    const file = findMdFile(argv);
    if (file && ready) openMarkdownFile(file);
  });

  // Desktop actions for the in-app Settings. Only Octavo's own main window may call them.
  const fromMainWindow = (e) => win && e.sender === win.webContents;
  const desktopState = () => ({
    phone: phoneEnabled(),
    remote: remoteEnabled(),
    remoteStatus: remote ? remote.current : null,
  });
  ipcMain.handle('octavo:state', (e) => (fromMainWindow(e) ? desktopState() : null));
  ipcMain.handle('octavo:check-network', async (e) => {
    if (fromMainWindow(e)) await checkNetwork();
    return desktopState();
  });
  ipcMain.handle('octavo:toggle-remote', async (e) => {
    if (fromMainWindow(e)) await toggleRemoteAccess();
    return desktopState();
  });
  ipcMain.handle('octavo:retry-remote', async (e) => {
    if (fromMainWindow(e) && remoteEnabled()) await startRemote(true).catch((err) => remoteLog(`Retry failed: ${err}`));
    return desktopState();
  });
  ipcMain.handle('octavo:remote-log', async (e) => {
    if (!fromMainWindow(e)) return;
    remoteLog('Log opened');
    await shell.openPath(remoteLogPath());
  });
  ipcMain.handle('octavo:toggle-phone', async (e) => {
    if (fromMainWindow(e)) await togglePhoneAccess();
    return desktopState();
  });
  ipcMain.handle('octavo:update-state', (e) => (fromMainWindow(e) ? updateState : null));
  ipcMain.handle('octavo:check-updates', async (e) => (fromMainWindow(e) ? checkForUpdates() : null));
  ipcMain.handle('octavo:install-update', (e) => (fromMainWindow(e) ? installUpdate() : null));
  // Brains: the renderer can only switch to or forget brains already in the list,
  // and new brains are always created inside the Octavo Brains folder.
  ipcMain.handle('octavo:brains', (e) => (fromMainWindow(e) ? brainsState() : null));
  ipcMain.handle('octavo:switch-brain', async (e, p) => {
    if (fromMainWindow(e)) await switchBrain(p);
    return brainsState();
  });
  ipcMain.handle('octavo:create-brain', async (e, name) => {
    if (!fromMainWindow(e)) return null;
    try {
      await createBrain(name);
      return { ok: true, ...brainsState() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ...brainsState() };
    }
  });
  ipcMain.handle('octavo:remove-brain', (e, p) => {
    if (fromMainWindow(e)) removeBrain(p);
    return brainsState();
  });
  ipcMain.handle('octavo:copy-brain-config', (e, p) => {
    if (!fromMainWindow(e)) return false;
    clipboard.writeText(brainsClaudeJson(typeof p === 'string' ? p : undefined));
    return true;
  });
  ipcMain.handle('octavo:reveal-brain', async (e, p) => {
    const b = fromMainWindow(e) && findBrain(p);
    if (b) await shell.openPath(b.path);
  });
  // Notes from other apps (Settings → Notes from other apps).
  ipcMain.handle('octavo:sync-folders', (e) => (fromMainWindow(e) && server ? server.folderSync.status() : null));
  ipcMain.handle('octavo:add-sync-folder', async (e) => {
    if (!fromMainWindow(e) || !server) return null;
    const res = await dialog.showOpenDialog(win ?? undefined, {
      title: 'Choose the folder another app saves notes to',
      message: 'For Notability: the folder its Auto-backup uses in Google Drive, OneDrive or Dropbox (usually “Notability”).',
      buttonLabel: 'Keep in step',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return server.folderSync.status();
    const vaultPath = server.vault.root;
    const source = path.resolve(res.filePaths[0]);
    const before = syncFoldersFor(vaultPath);
    saveSyncFolders(vaultPath, [...before.filter((f) => path.resolve(f.source) !== source), { source }]);
    // setFolders refuses the vault itself or folders inside/around it: say so instead of failing silently.
    if (!server.folderSync.list().some((f) => f.source === source)) {
      saveSyncFolders(vaultPath, before);
      await dialog.showMessageBox(win ?? undefined, { type: 'warning', message: 'That folder can’t be used', detail: 'Pick a folder outside this brain’s folder (and not one that contains it).' });
    }
    return server.folderSync.status();
  });
  ipcMain.handle('octavo:remove-sync-folder', (e, source) => {
    if (!fromMainWindow(e) || !server || typeof source !== 'string') return null;
    const vaultPath = server.vault.root;
    saveSyncFolders(vaultPath, syncFoldersFor(vaultPath).filter((f) => path.resolve(f.source) !== path.resolve(source)));
    return server.folderSync.status();
  });
  // Pop-out windows: the same app on another note. Only notes in the open brain.
  ipcMain.handle('octavo:pop-out', async (e, p) => {
    if (!fromMainWindow(e) || !server || typeof p !== 'string') return;
    const rel = server.vault.resolve(p);
    if (!rel) return;
    const child = new BrowserWindow({
      width: 900,
      height: 900,
      title: `${path.basename(rel, '.md')} · Octavo`,
      backgroundColor: '#141317',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    child.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    await child.loadURL(`${windowUrl()}#/note/${rel.split('/').map(encodeURIComponent).join('/')}`);
  });
  // Export to PDF: render the note's HTML off-screen and save it where the user chooses.
  ipcMain.handle('octavo:export-pdf', async (e, html, title) => {
    if (!fromMainWindow(e) || typeof html !== 'string' || html.length > 20_000_000) return false;
    const safe = String(title || 'Note').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 120) || 'Note';
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export to PDF',
      defaultPath: path.join(app.getPath('documents'), `${safe}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return false;
    const tmp = path.join(app.getPath('temp'), `octavo-export-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    try {
      await pdfWin.loadFile(tmp);
      await new Promise((r) => setTimeout(r, 400)); // images and fonts
      const pdf = await pdfWin.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
      fs.writeFileSync(filePath, pdf);
      shell.showItemInFolder(filePath);
      return true;
    } finally {
      pdfWin.destroy();
      fs.rmSync(tmp, { force: true });
    }
  });
  ipcMain.handle('octavo:show-qr', async (e) => {
    if (fromMainWindow(e)) await showPhoneQr();
    return desktopState();
  });

/**
 * The web viewer's Live mode shows pages in a frame. Many sites forbid that with X-Frame-Options or a
 * CSP frame-ancestors rule; inside the desktop app (where the page is only ever shown to its owner)
 * those rules are dropped for embedded frames only, never for top-level pages.
 */
function allowWebViewerFrames() {
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (details.resourceType !== 'subFrame' || !details.responseHeaders) return callback({});
    const headers = {};
    for (const [k, v] of Object.entries(details.responseHeaders)) {
      const key = k.toLowerCase();
      if (key === 'x-frame-options') continue;
      if (key === 'content-security-policy') {
        const kept = v.map((p) => p.split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';')).filter((p) => p.trim());
        if (kept.length) headers[k] = kept;
        continue;
      }
      headers[k] = v;
    }
    callback({ responseHeaders: headers });
  });
}

  app.whenReady().then(async () => {
    registerProtocol();
    allowWebViewerFrames();
    createWindow();
    initUpdater();
    buildMenu();
    const cfg = loadConfig();
    const vaultPath = process.env.OCTAVO_VAULT || cfg.vaultPath || path.join(os.homedir(), 'Octavo');
    try {
      await openVault(vaultPath);
    } catch (err) {
      await dialog.showMessageBox({
        type: 'error',
        message: 'Could not open the vault',
        detail: `${vaultPath}\n\n${err instanceof Error ? err.message : err}`,
      });
      await chooseVault();
    }
    ready = true;
    if (pendingFile) {
      const file = pendingFile;
      pendingFile = null;
      const go = () => (win?.webContents.isLoading() ? setTimeout(go, 200) : openMarkdownFile(file));
      go();
    }
    if (pendingLink) {
      const link = pendingLink;
      pendingLink = null;
      // Navigate once the page has loaded.
      const go = () => (win?.webContents.isLoading() ? setTimeout(go, 200) : handleLink(link));
      go();
    }
  });

  app.on('activate', async () => {
    if (!win) {
      createWindow();
      if (server) await win.loadURL(windowUrl());
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let checkedClaudeOnQuit = false;
  app.on('before-quit', async (e) => {
    // A downloaded update normally installs when Octavo quits. If Claude is using Octavo,
    // that would fail (or cut Claude off without warning), so keep it for the restart prompt.
    if (!checkedClaudeOnQuit && process.platform === 'win32' && updateState.status === 'ready' && autoUpdater.autoInstallOnAppQuit) {
      e.preventDefault();
      checkedClaudeOnQuit = true;
      if ((await claudeCopies()).length) autoUpdater.autoInstallOnAppQuit = false;
      app.quit();
      return;
    }
    if (remote) {
      // Close the router ports before quitting.
      e.preventDefault();
      const r = remote;
      remote = null;
      await r.stop();
      app.quit();
      return;
    }
    if (server) {
      e.preventDefault();
      const s = server;
      server = null;
      await s.close();
      app.quit();
    }
  });
}
