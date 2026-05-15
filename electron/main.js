/**
 * Electron main process for Agent Hub.
 *
 * Boots the Express server (same one used in dev), then opens a
 * BrowserWindow pointing at it.  In production the server also
 * serves the pre-built React client from client/dist.
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { fork, spawn } from 'child_process';
import {
  mkdirSync,
  createWriteStream,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  renameSync,
} from 'fs';
import { createNotificationHandlers } from './notifications.js';
import { saveDesignPdfWithDialog } from './save-design-pdf-dialog.js';
import { mergeElectronServerPath } from './merge-server-path.js';
import { resolveElectronDevUserDataDir } from './resolve-user-data-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isDev = process.env.NODE_ENV === 'development';

// Packaged builds isolate under Electron userData. Dev uses the same default
// data dir as `npm run dev:server` (~/.agent-hub/data) unless AGENT_HUB_DATA_DIR
// is set, so GitHub OAuth and SQLite survive switching between dev modes.
const USER_DATA = isDev
  ? resolveElectronDevUserDataDir()
  : path.join(app.getPath('userData'), 'data');

let mainWindow = null;
let serverProcess = null;

// ─── Connection config (file-backed for Electron) ───────────────

const CONNECTION_CONFIG_PATH = path.join(USER_DATA, 'connection.json');
const REMOTE_ORGS_PATH = path.join(USER_DATA, 'remote-orgs.json');
// JWT bearer tokens are persisted alongside the legacy apiKey so the
// webRequest interceptor can inject Authorization headers on the very
// first request (before the React app boots).
const AUTH_TOKEN_PATH = path.join(USER_DATA, 'auth-token.json');

let cachedConnConfig = null;
let cachedAuthToken = null;

function readConnectionConfig() {
  if (cachedConnConfig) return cachedConnConfig;
  try {
    if (existsSync(CONNECTION_CONFIG_PATH)) {
      cachedConnConfig = JSON.parse(readFileSync(CONNECTION_CONFIG_PATH, 'utf-8'));
      return cachedConnConfig;
    }
  } catch {}
  cachedConnConfig = { mode: 'local', remoteUrl: '', apiKey: '' };
  return cachedConnConfig;
}

function writeConnectionConfig(config) {
  mkdirSync(path.dirname(CONNECTION_CONFIG_PATH), { recursive: true });
  writeFileSync(CONNECTION_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  cachedConnConfig = config;
}

function readAuthToken() {
  if (cachedAuthToken !== null) return cachedAuthToken;
  try {
    if (existsSync(AUTH_TOKEN_PATH)) {
      const parsed = JSON.parse(readFileSync(AUTH_TOKEN_PATH, 'utf-8'));
      if (parsed && typeof parsed.token === 'string') {
        cachedAuthToken = parsed;
        return cachedAuthToken;
      }
    }
  } catch {}
  cachedAuthToken = null;
  return cachedAuthToken;
}

function writeAuthToken(record) {
  mkdirSync(path.dirname(AUTH_TOKEN_PATH), { recursive: true });
  if (record === null || record === undefined) {
    // Prefer unlinking so "missing file = unauthenticated" is unambiguous.
    // Fall back to overwriting with an empty file if unlink fails (e.g.
    // locked on Windows) — readAuthToken recovers either way.
    try {
      if (existsSync(AUTH_TOKEN_PATH)) unlinkSync(AUTH_TOKEN_PATH);
    } catch {
      try {
        writeFileSync(AUTH_TOKEN_PATH, '');
      } catch {}
    }
    cachedAuthToken = null;
    return;
  }
  // Atomic write: tmpfile + rename. An interrupted write can otherwise
  // leave a corrupt JSON that blocks login until the user deletes it.
  const tmpPath = `${AUTH_TOKEN_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpPath, AUTH_TOKEN_PATH);
  cachedAuthToken = record;
}

function isAuthTokenValid(record) {
  if (!record || typeof record.token !== 'string') return false;
  if (record.expiresAt) {
    const exp = new Date(record.expiresAt).getTime();
    if (Number.isFinite(exp) && exp <= Date.now()) return false;
  }
  return true;
}

// ─── Remote orgs (file-backed for Electron, survives origin changes) ──

function readRemoteOrgs() {
  try {
    if (existsSync(REMOTE_ORGS_PATH)) {
      return JSON.parse(readFileSync(REMOTE_ORGS_PATH, 'utf-8'));
    }
  } catch {}
  return [];
}

function writeRemoteOrgs(orgs) {
  mkdirSync(path.dirname(REMOTE_ORGS_PATH), { recursive: true });
  writeFileSync(REMOTE_ORGS_PATH, JSON.stringify(orgs, null, 2) + '\n');
}

// Inject auth headers on every request to the remote host so the initial
// page load (and all subsequent assets/fetches) is authenticated. The React
// client also reads credentials from localStorage/IPC, but it can't run
// until the HTML loads — and the HTML load itself needs the header.
//
// Precedence:
//   1. Authorization: Bearer <jwt>   (JWT auth, Phase 1)
//   2. X-API-Key: <apiKey>           (legacy)
function installRemoteApiKeyInjector() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const config = readConnectionConfig();
    if (config.mode === 'remote' && config.remoteUrl) {
      try {
        const reqHost = new URL(details.url).host;
        const remoteHost = new URL(config.remoteUrl).host;
        if (reqHost === remoteHost) {
          const authRecord = readAuthToken();
          if (isAuthTokenValid(authRecord)) {
            details.requestHeaders['Authorization'] = `Bearer ${authRecord.token}`;
          } else if (config.apiKey) {
            details.requestHeaders['X-API-Key'] = config.apiKey;
          }
        }
      } catch {}
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}

function isRemoteMode() {
  const config = readConnectionConfig();
  return config.mode === 'remote' && !!config.remoteUrl;
}

// ─── Server boot ─────────────────────────────────────────────────

function startServer() {
  return new Promise((resolve, reject) => {
    // Server is TypeScript; run via tsx (same as npm run dev:server). Unpacked from
    // app.asar so native modules in server/ resolve correctly.
    const serverDir = path.join(ROOT, 'server').replace('app.asar', 'app.asar.unpacked');
    const tsxCli = path.join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');

    // Ensure the user data directory exists
    mkdirSync(USER_DATA, { recursive: true });

    // Tee server output to a log file so users can `tail -f` it
    const logPath = path.join(USER_DATA, 'server.log');
    const logStream = createWriteStream(logPath, { flags: 'a' });
    logStream.write(`\n----- ${new Date().toISOString()} server starting -----\n`);
    console.log('[server] Logging to', logPath);

    // When launched from Finder / the Windows shell, Electron's PATH is minimal.
    // Prepend common install locations for node-based CLIs, git, and gh — and use
    // the platform path delimiter (Windows needs `;`, not `:`). See merge-server-path.js.
    const mergedPath = mergeElectronServerPath(process.env.PATH);

    // Set env so the server knows to serve the built client.
    //
    // AGENT_HUB_MODE='local' is the trust signal that lets the server's
    // auth middleware short-circuit JWT/apiKey checks for this single-user
    // desktop install. It MUST only be set by deployment contexts that are
    // genuinely single-tenant (Electron, hypothetical CLI dev mode) — a
    // deployed web server must never set it. Source-of-truth lives in the
    // process env (not the orgs DB) so a Settings UI toggle can never
    // accidentally disable auth on a remote deployment.
    const env = {
      ...process.env,
      PATH: mergedPath,
      ELECTRON: '1',
      AGENT_HUB_MODE: 'local',
      AGENT_HUB_DATA_DIR: USER_DATA,
      AGENT_HUB_SERVE_CLIENT: isDev ? '' : path.join(ROOT, 'client', 'dist'),
    };

    if (isDev) {
      // In dev, use the system Node binary to avoid native module ABI mismatches
      // between Electron's embedded Node and the system Node that compiled them.
      serverProcess = spawn('node', [tsxCli, 'index.ts'], {
        cwd: serverDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      // In production, use Electron's fork (ELECTRON_RUN_AS_NODE) so native
      // modules rebuilt by electron-builder match the runtime.
      env.ELECTRON_RUN_AS_NODE = '1';
      serverProcess = fork(tsxCli, ['index.ts'], {
        cwd: serverDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
    }

    let started = false;

    serverProcess.stdout?.on('data', (data) => {
      const text = data.toString();
      console.log('[server]', text.trimEnd());
      logStream.write(text);
      // Detect the server ready message
      if (!started && (text.includes('listening') || text.includes('running on'))) {
        started = true;
        resolve();
      }
    });

    serverProcess.stderr?.on('data', (data) => {
      const text = data.toString();
      console.error('[server:err]', text.trimEnd());
      logStream.write(text);
    });

    serverProcess.on('error', (err) => {
      console.error('[server] Failed to start:', err);
      reject(err);
    });

    serverProcess.on('exit', (code) => {
      console.log('[server] Exited with code', code);
      if (!started) reject(new Error(`Server exited with code ${code}`));
    });

    // Fallback: if we don't see "listening" within 10s, try anyway
    setTimeout(() => {
      if (!started) {
        started = true;
        resolve();
      }
    }, 10_000);
  });
}

// ─── Window ──────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Agent Hub',
    backgroundColor: '#030712', // gray-950
    titleBarStyle: 'hiddenInset', // macOS: integrated title bar
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const port = process.env.AGENT_HUB_PORT || 3051;
  const connConfig = readConnectionConfig();

  // Clear the renderer's HTTP cache before the first load so a packaged
  // rebuild-and-relaunch actually fetches the new index.html / asset bundle
  // instead of serving a stale cached copy from a previous install. We only
  // clear the HTTP cache — cookies and localStorage are preserved so the
  // user's connection/org settings survive the restart.
  const loadAppUrl = () => {
    if (isDev) {
      // In dev, always load the Vite dev server — it proxies /api to the
      // local server, and the React app handles remote org connections itself.
      mainWindow.loadURL('http://localhost:3050');
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else if (connConfig.mode === 'remote' && connConfig.remoteUrl) {
      // Remote mode — load the remote server's UI directly
      mainWindow.loadURL(connConfig.remoteUrl.replace(/\/+$/, ''));
      console.log('[electron] Loading remote URL:', connConfig.remoteUrl);
    } else {
      // In production, the Express server serves the built client
      mainWindow.loadURL(`http://localhost:${port}`);
    }
  };

  session.defaultSession
    .clearCache()
    .catch((err) => console.warn('[electron] clearCache failed:', err?.message || err))
    .finally(loadAppUrl);

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Intercept navigation — markdown links use <a href> which triggers
  // will-navigate rather than window.open. Allow localhost and any
  // configured remote server origin; open everything else externally.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedOrigins = [
      `http://localhost:${port}`,
      isDev ? 'http://localhost:3050' : null,
    ].filter(Boolean);

    // Allow the currently configured remote server
    const config = readConnectionConfig();
    if (config.mode === 'remote' && config.remoteUrl) {
      allowedOrigins.push(config.remoteUrl.replace(/\/+$/, ''));
    }

    // Also allow any known remote org servers
    for (const org of readRemoteOrgs()) {
      if (org.remote_url) {
        allowedOrigins.push(org.remote_url.replace(/\/+$/, ''));
      }
    }

    const isAllowed = allowedOrigins.some((origin) => url.startsWith(origin));
    if (!isAllowed) {
      event.preventDefault();
      shell.openExternal(url);
      // Safety net: navigate back to the app root if the window is stuck
      // on a non-app page (e.g. the GitHub App register page's form POST
      // to github.com). Only reload when necessary to avoid disrupting
      // the user's current state (scroll position, in-flight work, etc.).
      const appUrl = isDev
        ? 'http://localhost:3050'
        : `http://localhost:${port}`;
      if (!mainWindow.webContents.getURL().startsWith(appUrl)) {
        mainWindow.loadURL(appUrl);
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── IPC handlers ────────────────────────────────────────────────

// Connection config IPC — file-backed persistence for remote mode
ipcMain.on('get-connection-config', (event) => {
  event.returnValue = readConnectionConfig();
});

ipcMain.on('save-connection-config', (event, config) => {
  writeConnectionConfig(config);
  event.returnValue = true;
});

// JWT auth token — mirrored from the React app so the webRequest
// interceptor can inject `Authorization: Bearer` on the very first HTML
// load. Passing `null` clears the token (logout).
ipcMain.on('save-auth-token', (event, record) => {
  writeAuthToken(record || null);
  event.returnValue = true;
});

ipcMain.on('get-auth-token', (event) => {
  event.returnValue = readAuthToken();
});

// Navigate the window to the correct URL based on current connection config.
// Called after an org switch so Electron loads the right server.
// Clears HTTP cache first to avoid serving stale JS bundles from the previous server.
ipcMain.on('navigate-to-org', async (event) => {
  if (!mainWindow) return;

  // Clear HTTP cache so the new server's assets are fetched fresh
  try {
    await session.defaultSession.clearCache();
  } catch {}

  const config = readConnectionConfig();
  const port = process.env.AGENT_HUB_PORT || 3051;
  if (isDev) {
    mainWindow.loadURL('http://localhost:3050');
  } else if (config.mode === 'remote' && config.remoteUrl) {
    mainWindow.loadURL(config.remoteUrl.replace(/\/+$/, ''));
  } else {
    mainWindow.loadURL(`http://localhost:${port}`);
  }
});

// Remote orgs — file-backed storage that survives origin changes.
// localStorage is origin-scoped, so when Electron navigates from Server A to
// Server B, the remote org bookmarks stored in Server A's localStorage vanish.
// File-backed storage solves this.
ipcMain.on('get-remote-orgs', (event) => {
  event.returnValue = readRemoteOrgs();
});

ipcMain.on('save-remote-orgs', (event, orgs) => {
  writeRemoteOrgs(orgs);
  event.returnValue = true;
});

// Persist the active org ID so it survives origin changes too.
const ACTIVE_ORG_PATH = path.join(USER_DATA, 'active-org.json');

ipcMain.on('get-active-org-id', (event) => {
  try {
    if (existsSync(ACTIVE_ORG_PATH)) {
      const data = JSON.parse(readFileSync(ACTIVE_ORG_PATH, 'utf-8'));
      event.returnValue = data.activeOrgId || null;
    } else {
      event.returnValue = null;
    }
  } catch {
    event.returnValue = null;
  }
});

ipcMain.on('save-active-org-id', (event, orgId) => {
  mkdirSync(path.dirname(ACTIVE_ORG_PATH), { recursive: true });
  writeFileSync(ACTIVE_ORG_PATH, JSON.stringify({ activeOrgId: orgId }) + '\n');
  event.returnValue = true;
});

// Native directory picker — called from the OpenProjectWizard
ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Project Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Bug report screenshot — captures the current window via Electron's
// native webContents.capturePage(), which is higher fidelity than
// html2canvas (handles cross-origin iframes, CSS filters, etc.).
// Returns a PNG data URL, or null on failure / no window.
ipcMain.handle('bug-report:capture-page', async () => {
  try {
    const win =
      BrowserWindow.getFocusedWindow() ||
      mainWindow ||
      BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const image = await win.webContents.capturePage();
    return image.toDataURL();
  } catch (err) {
    console.error('[bug-report:capture-page] Failed:', err);
    return null;
  }
});

// Design Studio — save exported PDF via native dialog (renderer uses jsPDF).
ipcMain.handle('design-pdf:save', async (event, { defaultFilename, data }) => {
  const win =
    BrowserWindow.fromWebContents(event.sender) ||
    BrowserWindow.getFocusedWindow() ||
    mainWindow;
  if (!win) return { error: 'No browser window' };
  return saveDesignPdfWithDialog({
    showSaveDialog: (w, opts) => dialog.showSaveDialog(w, opts),
    mainWindow: win,
    defaultFilename: typeof defaultFilename === 'string' ? defaultFilename : 'design.pdf',
    data,
  });
});

// ─── Preview Pane — Detached Window ───────────────────────────────
//
// Renderer can ask the main process to open the session preview URL in
// a dedicated, sandboxed BrowserWindow so the running app can sit on a
// second monitor while the user keeps chatting in the main window.
//
// Lifecycle:
//   - Validate that `url` parses to http/https. Reject anything else
//     (file://, javascript:, etc.) so a compromised renderer can't use
//     this channel to read local files.
//   - One window per sessionId. Re-invocation focuses the existing
//     window and navigates it to the new URL — handy when the preview
//     port rotates after a rebuild.
//   - When the window closes (manually or programmatically), the entry
//     is removed from the registry. The renderer's poll-loop notices
//     and reattaches the inline iframe.
//
// Security:
//   - `sandbox: true` + `contextIsolation: true` + `nodeIntegration:
//     false` is the strictest preset Electron offers; the popped-out
//     view runs with no Node integration whatsoever.
//   - No preload is attached, so `window.electronAPI` is undefined in
//     the popped window — the preview should never need IPC.
//   - `setWindowOpenHandler` on the pop-out window's `webContents` (see
//     below) routes any child window.open / target=_blank to
//     `shell.openExternal`, preventing the preview from spawning further
//     Electron windows. The main window has the same handler (~line 315).

/** sessionId → BrowserWindow */
const previewPopOutWindows = new Map();

ipcMain.handle('preview:pop-out', async (event, payload) => {
  const sessionId =
    payload && typeof payload === 'object' && typeof payload.sessionId === 'string'
      ? payload.sessionId.trim()
      : '';
  const rawUrl =
    payload && typeof payload === 'object' && typeof payload.url === 'string'
      ? payload.url.trim()
      : '';
  if (!sessionId || !rawUrl) {
    return { ok: false, error: 'sessionId and url are required' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'invalid url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'unsupported protocol' };
  }

  // Reuse existing window for this session.
  const existing = previewPopOutWindows.get(sessionId);
  if (existing && !existing.isDestroyed()) {
    try {
      existing.loadURL(parsed.href);
      existing.focus();
      return { ok: true };
    } catch (err) {
      console.warn('[preview:pop-out] failed to reuse window, recreating:', err?.message);
      previewPopOutWindows.delete(sessionId);
    }
  }

  const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow || null;
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    parent: parent || undefined,
    title: `Preview — ${sessionId.slice(0, 8)}`,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // No preload — the popped view is a plain web page, no IPC bridge.
    },
  });
  // Block any window.open / target=_blank inside the previewed app from
  // spawning further child windows (open externally in the OS browser
  // instead, which is the standard Electron pattern).
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        shell.openExternal(u.href).catch(() => {});
      }
    } catch {
      /* ignore */
    }
    return { action: 'deny' };
  });
  win.on('closed', () => {
    previewPopOutWindows.delete(sessionId);
  });

  previewPopOutWindows.set(sessionId, win);
  try {
    await win.loadURL(parsed.href);
    return { ok: true };
  } catch (err) {
    previewPopOutWindows.delete(sessionId);
    try {
      win.close();
    } catch {
      /* ignore */
    }
    return { ok: false, error: err?.message || 'load failed' };
  }
});

/** Packaged app / electron-builder version (normalized DMG semver). */
ipcMain.handle('get-app-version', () => app.getVersion());

/**
 * GET JSON health in the main process so local Electron can compare against a
 * canonical hub (publicUrl) without browser CORS blocking the renderer.
 */
ipcMain.handle('agenthub-fetch-health', async (_event, rawUrl) => {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url.href, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.version !== 'string' || !data.version.trim()) return null;
    return {
      version: data.version.trim(),
      gitHash: typeof data.gitHash === 'string' ? data.gitHash : '',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
});

// ─── Notification IPC handlers ───────────────────────────────────

const notifHandlers = createNotificationHandlers(() => mainWindow);

ipcMain.on('show-notification', notifHandlers.handleShowNotification);
ipcMain.on('get-notification-support', notifHandlers.handleGetSupport);

// ─── App menu ────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: 'Agent Hub',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── Lifecycle ───────────────────────────────────────────────────

app.whenReady().then(async () => {
  buildMenu();
  installRemoteApiKeyInjector();

  // Always start the local server — it's lightweight and ensures switching
  // from a remote org to a local org works without an app restart.
  try {
    await startServer();
  } catch (err) {
    console.error('Failed to start server, opening window anyway:', err.message);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
