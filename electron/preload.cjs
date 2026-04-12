/**
 * Preload script — runs in the renderer's isolated context.
 * Exposes a small API to the React app via window.electronAPI.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /** Opens a native directory picker dialog. Returns the path or null if cancelled. */
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  /** True when running inside Electron (vs. a regular browser). */
  isElectron: true,

  /** Platform string (darwin, win32, linux). */
  platform: process.platform,

  /** Read the connection config from the main process (file-backed). */
  getConnectionConfig: () => ipcRenderer.sendSync('get-connection-config'),

  /** Save connection config to the main process (file-backed). */
  saveConnectionConfig: (config) => ipcRenderer.sendSync('save-connection-config', config),

  /** Navigate the Electron window to the correct URL after an org switch. */
  navigateToOrg: () => ipcRenderer.send('navigate-to-org'),
});
