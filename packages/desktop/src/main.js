import { app, BrowserWindow, Menu, clipboard, dialog, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, seedIfEmpty, lanAddresses, loadOrCreateToken, phoneUrl, qrDataUrl } from '@ultron/server';

const require = createRequire(import.meta.url);
const DEFAULT_PORT = 4321;

/** @type {import('@ultron/server').RunningServer | null} */
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
const phoneToken = () => loadOrCreateToken(path.join(app.getPath('userData'), 'phone-token'));

/** URL the desktop window loads (carries the access key when phone access is on). */
function windowUrl() {
  if (!server) return '';
  return phoneEnabled() ? `${server.url}/?token=${encodeURIComponent(phoneToken())}` : server.url;
}

async function openVault(vaultPath) {
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
    token: phone ? phoneToken() : undefined,
    fallbackToRandomPort: true,
  });
  await seedIfEmpty(server.vault);
  saveConfig({ ...loadConfig(), vaultPath });
  if (win) {
    win.setTitle(`${path.basename(vaultPath)} · Ultron Mind`);
    await win.loadURL(windowUrl());
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

function serverCliPath() {
  return path.join(path.dirname(require.resolve('@ultron/server/package.json')), 'dist', 'cli.js');
}

function claudeConfig() {
  const vaultPath = server?.vault.root ?? '';
  const httpUrl = server ? `${server.url}/mcp` : '';
  const desktopJson = JSON.stringify(
    {
      mcpServers: {
        'ultron-mind': {
          command: process.execPath,
          args: [serverCliPath(), 'mcp', '--vault', vaultPath],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    },
    null,
    2,
  );
  const claudeCode = `claude mcp add --transport http ultron-mind ${httpUrl}`;
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
      `Claude Desktop: add the "ultron-mind" entry to claude_desktop_config.json. It runs without this app being open.\n\n` +
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
      message: 'Open Ultron to your phone?',
      detail:
        'Ultron will be reachable from devices on this Wi-Fi network, protected by a secret access key in the QR code. Only turn this on for networks you trust, such as your home Wi-Fi.',
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
        { label: 'Use on Your Phone', type: 'checkbox', checked: phoneEnabled(), click: togglePhoneAccess },
        { label: 'Show Phone QR Code…', enabled: phoneEnabled() && !!server, click: showPhoneQr },
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
    title: 'Ultron Mind',
    backgroundColor: '#1b1a21',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
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

  app.whenReady().then(async () => {
    createWindow();
    buildMenu();
    const cfg = loadConfig();
    const vaultPath = process.env.ULTRON_VAULT || cfg.vaultPath || path.join(os.homedir(), 'UltronMind');
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
    if (server) {
      e.preventDefault();
      const s = server;
      server = null;
      await s.close();
      app.quit();
    }
  });
}
