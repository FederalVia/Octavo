import { app, BrowserWindow, Menu, clipboard, dialog, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, seedIfEmpty } from '@ultron/server';

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

async function openVault(vaultPath) {
  if (server) {
    await server.close();
    server = null;
  }
  server = await startServer({
    vaultPath,
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    fallbackToRandomPort: true,
  });
  await seedIfEmpty(server.vault);
  saveConfig({ ...loadConfig(), vaultPath });
  if (win) {
    win.setTitle(`${path.basename(vaultPath)} · Ultron Mind`);
    await win.loadURL(server.url);
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
      if (server) await win.loadURL(server.url);
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
