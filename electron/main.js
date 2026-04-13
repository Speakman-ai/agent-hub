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
import { fork } from 'child_process';
import { mkdirSync, createWriteStream, readFileSync, writeFileSync, existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isDev = process.env.NODE_ENV === 'development';

// Use platform-appropriate user data directory.
// In dev, use the repo's server/ dir so we share config with `npm run dev:server`.
const USER_DATA = isDev
  ? path.join(ROOT, 'server')
  : path.join(app.getPath('userData'), 'data');

let mainWindow = null;
let serverProcess = null;

// ─── Connection config (file-backed for Electron) ───────────────

const CONNECTION_CONFIG_PATH = path.join(USER_DATA, 'connection.json');
const REMOTE_ORGS_PATH = path.join(USER_DATA, 'remote-orgs.json');

let cachedConnConfig = null;

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

// Inject the configured X-API-Key on every request to the remote host so the
// initial page load (and all subsequent assets/fetches) is authenticated. The
// React client also reads the key from localStorage/IPC, but it can't run
// until the HTML loads — and the HTML load itself needs the header.
function installRemoteApiKeyInjector() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const config = readConnectionConfig();
    if (config.mode === 'remote' && config.remoteUrl && config.apiKey) {
      try {
        const reqHost = new URL(details.url).host;
        const remoteHost = new URL(config.remoteUrl).host;
        if (reqHost === remoteHost) {
          details.requestHeaders['X-API-Key'] = config.apiKey;
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
    const serverEntry = path.join(ROOT, 'server', 'index.js').replace('app.asar', 'app.asar.unpacked');

    // Ensure the user data directory exists
    mkdirSync(USER_DATA, { recursive: true });

    // Tee server output to a log file so users can `tail -f` it
    const logPath = path.join(USER_DATA, 'server.log');
    const logStream = createWriteStream(logPath, { flags: 'a' });
    logStream.write(`\n----- ${new Date().toISOString()} server starting -----\n`);
    console.log('[server] Logging to', logPath);

    // When launched from Finder, Electron's PATH is minimal and lacks
    // Homebrew / user-local bin dirs. The `claude` CLI uses
    // `#!/usr/bin/env node`, so without these on PATH it fails with
    // "env: node: No such file or directory". Prepend the common dirs.
    const extraPaths = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      path.join(process.env.HOME || '', '.local/bin'),
      path.join(process.env.HOME || '', '.nvm/versions/node/current/bin'),
    ].filter(Boolean);
    const mergedPath = [...extraPaths, process.env.PATH || '']
      .filter(Boolean)
      .join(':');

    // Set env so the server knows to serve the built client
    const env = {
      ...process.env,
      PATH: mergedPath,
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON: '1',
      AGENT_HUB_DATA_DIR: USER_DATA,
      AGENT_HUB_SERVE_CLIENT: isDev ? '' : path.join(ROOT, 'client', 'dist'),
    };

    serverProcess = fork(serverEntry, [], {
      cwd: path.dirname(serverEntry),
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    let started = false;

    serverProcess.stdout?.on('data', (data) => {
      const text = data.toString();
      console.log('[server]', text.trimEnd());
      logStream.write(text);
      // Detect the "listening on port" message
      if (!started && text.includes('listening')) {
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

  if (connConfig.mode === 'remote' && connConfig.remoteUrl) {
    // Remote mode — load the remote server's UI directly
    mainWindow.loadURL(connConfig.remoteUrl.replace(/\/+$/, ''));
    console.log('[electron] Loading remote URL:', connConfig.remoteUrl);
  } else if (isDev) {
    // In dev, the Vite dev server runs on 3050 and proxies /api to 3051
    mainWindow.loadURL('http://localhost:3050');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // In production, the Express server serves the built client
    mainWindow.loadURL(`http://localhost:${port}`);
  }

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
  if (config.mode === 'remote' && config.remoteUrl) {
    mainWindow.loadURL(config.remoteUrl.replace(/\/+$/, ''));
  } else if (isDev) {
    mainWindow.loadURL('http://localhost:3050');
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
