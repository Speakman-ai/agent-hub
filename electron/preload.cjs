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

  /** CPU architecture (arm64, x64, ia32). Used by the renderer to pick the right DMG when prompting the user to download a newer build. */
  arch: process.arch,

  /** DMG / installer semver from electron-builder (`app.getVersion()`). */
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  /**
   * Fetch `/api/health` JSON from an absolute http(s) URL in the main process
   * (avoids renderer CORS when comparing the desktop bundle to a canonical hub).
   */
  fetchRemoteHealth: (url) => ipcRenderer.invoke('agenthub-fetch-health', url),

  /** Read the connection config from the main process (file-backed). */
  getConnectionConfig: () => ipcRenderer.sendSync('get-connection-config'),

  /** Save connection config to the main process (file-backed). */
  saveConnectionConfig: (config) => ipcRenderer.sendSync('save-connection-config', config),

  /**
   * Persist the JWT record `{ token, expiresAt, user }` to the main
   * process so its webRequest interceptor can inject the Authorization
   * header on every request (including the initial HTML load, before
   * the React app boots). Pass `null` to clear.
   */
  saveAuthToken: (record) => ipcRenderer.sendSync('save-auth-token', record || null),

  /** Read the persisted JWT record, or null if none stored. */
  getAuthToken: () => ipcRenderer.sendSync('get-auth-token'),

  /** Navigate the Electron window to the correct URL after an org switch. */
  navigateToOrg: () => ipcRenderer.send('navigate-to-org'),

  /** Read remote orgs from file-backed storage (survives origin changes). */
  getRemoteOrgs: () => ipcRenderer.sendSync('get-remote-orgs'),

  /** Save remote orgs to file-backed storage. */
  saveRemoteOrgs: (orgs) => ipcRenderer.sendSync('save-remote-orgs', orgs),

  /** Read the active org ID from file-backed storage. */
  getActiveOrgId: () => ipcRenderer.sendSync('get-active-org-id'),

  /** Save the active org ID to file-backed storage. */
  saveActiveOrgId: (orgId) => ipcRenderer.sendSync('save-active-org-id', orgId),

  // ─── Desktop Notifications ──────────────────────────────────────

  /** Show a native desktop notification (fire-and-forget). */
  showNotification: (options) => ipcRenderer.send('show-notification', options),

  /** Check if the system supports native notifications. */
  isNotificationSupported: () => ipcRenderer.sendSync('get-notification-support'),

  // ─── Bug Report ─────────────────────────────────────────────────

  /**
   * Capture the current window as a PNG data URL using Electron's native
   * webContents.capturePage(). Returns null if capture fails or no window
   * is available. Used by the Bug Report button in place of html2canvas.
   */
  captureBugScreenshot: () => ipcRenderer.invoke('bug-report:capture-page'),

  /**
   * Save a rendered design PDF via the native OS save dialog (main process).
   * @param {{ defaultFilename: string, data: Uint8Array }} payload
   * @returns {Promise<{ ok?: true, filePath?: string, cancelled?: true, error?: string }>}
   */
  saveDesignPdf: (payload) => ipcRenderer.invoke('design-pdf:save', payload),

  // ─── Preview Pane — Detached Window ─────────────────────────────

  /**
   * Open the session preview URL in a dedicated, sandboxed BrowserWindow
   * owned by the main process. The renderer fires this when the user hits
   * "Pop out" on a session's preview pane so the running app can sit
   * side-by-side on a second monitor.
   *
   * Idempotent per sessionId — invoking twice for the same session
   * focuses the existing window and navigates it to the new URL rather
   * than spawning a duplicate.
   *
   * @param {{ sessionId: string, url: string }} payload
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  popOutPreview: (payload) => ipcRenderer.invoke('preview:pop-out', payload),
});
