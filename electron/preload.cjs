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
});
