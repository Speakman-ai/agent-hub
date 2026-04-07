/**
 * Electron main process for Agent Hub.
 *
 * Boots the Express server (same one used in dev), then opens a
 * BrowserWindow pointing at it.  In production the server also
 * serves the pre-built React client from client/dist.
 */

import { app, BrowserWindow, dialog, ipcMain, shell, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import { mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isDev = process.env.NODE_ENV === 'development';

// Use platform-appropriate user data directory
const USER_DATA = path.join(app.getPath('userData'), 'data');

let mainWindow = null;
let serverProcess = null;

// ─── Server boot ─────────────────────────────────────────────────

function startServer() {
  return new Promise((resolve, reject) => {
    const serverEntry = path.join(ROOT, 'server', 'index.js');

    // Ensure the user data directory exists
    mkdirSync(USER_DATA, { recursive: true });

    // Set env so the server knows to serve the built client
    const env = {
      ...process.env,
      ELECTRON: '1',
      AGENT_HUB_DATA_DIR: USER_DATA,
      AGENT_HUB_SERVE_CLIENT: isDev ? '' : path.join(ROOT, 'client', 'dist'),
    };

    serverProcess = fork(serverEntry, [], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    let started = false;

    serverProcess.stdout?.on('data', (data) => {
      const text = data.toString();
      console.log('[server]', text.trimEnd());
      // Detect the "listening on port" message
      if (!started && text.includes('listening')) {
        started = true;
        resolve();
      }
    });

    serverProcess.stderr?.on('data', (data) => {
      console.error('[server:err]', data.toString().trimEnd());
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

  if (isDev) {
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── IPC handlers ────────────────────────────────────────────────

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
