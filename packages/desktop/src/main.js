import { app, BrowserWindow, Menu, Notification, clipboard, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer, seedIfEmpty, lanAddresses, loadOrCreateToken, phoneUrl, qrDataUrl, RemoteAccess, diagnose } from '@octavo/server';

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
  });
  await seedIfEmpty(server.vault);
  saveConfig({ ...loadConfig(), vaultPath });
  if (win) {
    win.setTitle(`${path.basename(vaultPath)} · Octavo`);
    await win.loadURL(windowUrl());
  }
  buildMenu();
  if (autoRemote && remoteEnabled()) startRemote(false);
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
async function showAccessWindow(html) {
  if (!accessWin || accessWin.isDestroyed()) {
    accessWin = new BrowserWindow({
      width: 440,
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

async function startRemote(showWindow) {
  if (!server) return;
  // Never expose the server to the internet without the access key.
  if (!needsKey()) throw new Error('Remote access requires the access key to be enabled');
  if (remote) await remote.stop();
  remote = new RemoteAccess({
    app: server.app,
    stateDir: path.join(app.getPath('userData'), 'remote'),
      // Hard guard: the local server must reject requests without the access key.
      requireToken: async () => (await fetch(`${server.url}/api/vault`).then((r) => r.status).catch(() => 0)) === 401,
    // Advanced: ports forwarded by hand / testing against another ACME server.
    publicIp: process.env.OCTAVO_PUBLIC_IP || undefined,
    directoryUrl: process.env.OCTAVO_ACME_DIRECTORY || undefined,
    ...(process.env.OCTAVO_HTTPS_PORT
      ? { httpsPort: Number(process.env.OCTAVO_HTTPS_PORT), externalHttpsPorts: [Number(process.env.OCTAVO_HTTPS_PORT)] }
      : {}),
    ...(process.env.OCTAVO_CHALLENGE_PORT ? { challengePort: Number(process.env.OCTAVO_CHALLENGE_PORT) } : {}),
    log: (m) => console.log(`[octavo] ${m}`),
  });
  remote.on('status', async (s) => {
    buildMenu();
    if (!showWindow && !(accessWin && !accessWin.isDestroyed())) return;
    if (s.state === 'starting') {
      await showAccessWindow(pageHtml('Setting up', `<div class="big">⏳</div><h2>Setting up access from anywhere</h2><p>${esc(s.step)}</p><p>This usually takes under a minute.</p>`));
    } else if (s.state === 'ready') {
      await showAccessWindow(await qrPage(s.url, 'Works from <b>anywhere</b>: home Wi-Fi, other Wi-Fi or mobile data.'));
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
    'no-router': 'Turn on “UPnP” in your router’s settings (it’s usually on by default), then check again. Or forward ports by hand: see “Forwarding ports by hand” in the Octavo guide.',
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

function claudeConfig() {
  const vaultPath = server?.vault.root ?? '';
  const httpUrl = server ? `${server.url}/mcp` : '';
  const desktopJson = JSON.stringify(
    {
      mcpServers: {
        'octavo': {
          command: process.execPath,
          args: [serverCliPath(), 'mcp', '--vault', vaultPath],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    },
    null,
    2,
  );
  const claudeCode = `claude mcp add --transport http octavo ${httpUrl}`;
  return { httpUrl, desktopJson, claudeCode };
}

async function showConnectClaude() {
  const { httpUrl, desktopJson, claudeCode } = claudeConfig();
  const { response } = await dialog.showMessageBox(win ?? undefined, {
    type: 'info',
    title: 'Connect Claude',
    message: 'Give Claude access to this vault as its memory',
    detail:
      `While this app is open, its MCP endpoint is:\n${httpUrl}\n\n` +
      `Claude Code:\n${claudeCode}\n\n` +
      `Claude Desktop: add the "octavo" entry to claude_desktop_config.json. It runs without this app being open.\n\n` +
      `Copy one of the configs below.`,
    buttons: ['Copy Claude Code command', 'Copy Claude Desktop JSON', 'Close'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) clipboard.writeText(claudeCode);
  if (response === 1) clipboard.writeText(desktopJson);
}

// ------------------------------------------------------------------ phone access

async function showPhoneQr() {
  if (!server) return;
  if (remote && remote.current.state === 'ready') {
    await showAccessWindow(await qrPage(remote.current.url, 'Works from <b>anywhere</b>: home Wi-Fi, other Wi-Fi or mobile data.'));
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
        { label: 'Open Vault Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: chooseVault },
        {
          label: 'Reveal Vault in File Manager',
          enabled: !!server,
          click: () => server && shell.openPath(server.vault.root),
        },
        { type: 'separator' },
        { label: 'Connect Claude…', click: showConnectClaude },
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
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
  ipcMain.handle('octavo:toggle-phone', async (e) => {
    if (fromMainWindow(e)) await togglePhoneAccess();
    return desktopState();
  });
  ipcMain.handle('octavo:show-qr', async (e) => {
    if (fromMainWindow(e)) await showPhoneQr();
    return desktopState();
  });

  app.whenReady().then(async () => {
    createWindow();
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

  app.on('before-quit', async (e) => {
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
