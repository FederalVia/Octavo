// Exposes a small, fixed set of desktop-only actions to Octavo's web UI
// (Settings → Use on your phone). Nothing else from Electron or Node is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('octavoDesktop', {
  getState: () => ipcRenderer.invoke('octavo:state'),
  checkNetwork: () => ipcRenderer.invoke('octavo:check-network'),
  toggleRemote: () => ipcRenderer.invoke('octavo:toggle-remote'),
  togglePhone: () => ipcRenderer.invoke('octavo:toggle-phone'),
  showQr: () => ipcRenderer.invoke('octavo:show-qr'),
});
