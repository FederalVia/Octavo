// Exposes a small, fixed set of desktop-only actions to Octavo's web UI
// (Settings → Use on your phone). Nothing else from Electron or Node is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('octavoDesktop', {
  getState: () => ipcRenderer.invoke('octavo:state'),
  checkNetwork: () => ipcRenderer.invoke('octavo:check-network'),
  toggleRemote: () => ipcRenderer.invoke('octavo:toggle-remote'),
  togglePhone: () => ipcRenderer.invoke('octavo:toggle-phone'),
  showQr: () => ipcRenderer.invoke('octavo:show-qr'),
  retryRemote: () => ipcRenderer.invoke('octavo:retry-remote'),
  openRemoteLog: () => ipcRenderer.invoke('octavo:remote-log'),
  // Updates
  getUpdate: () => ipcRenderer.invoke('octavo:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('octavo:check-updates'),
  installUpdate: () => ipcRenderer.invoke('octavo:install-update'),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('octavo:update', listener);
    return () => ipcRenderer.removeListener('octavo:update', listener);
  },
  // Brains (separate vaults)
  getBrains: () => ipcRenderer.invoke('octavo:brains'),
  switchBrain: (path) => ipcRenderer.invoke('octavo:switch-brain', path),
  createBrain: (name) => ipcRenderer.invoke('octavo:create-brain', name),
  removeBrain: (path) => ipcRenderer.invoke('octavo:remove-brain', path),
  copyBrainConfig: (path) => ipcRenderer.invoke('octavo:copy-brain-config', path),
  revealBrain: (path) => ipcRenderer.invoke('octavo:reveal-brain', path),
  popOut: (path) => ipcRenderer.invoke('octavo:pop-out', path),
  exportPdf: (html, title) => ipcRenderer.invoke('octavo:export-pdf', html, title),
  onOpenSettings: (callback) => {
    const listener = (_event, section) => callback(section);
    ipcRenderer.on('octavo:open-settings', listener);
    return () => ipcRenderer.removeListener('octavo:open-settings', listener);
  },
});
