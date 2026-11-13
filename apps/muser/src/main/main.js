'use strict';
// Electron shell. All app logic lives in src/core (server) and src/renderer (UI); this file
// only hosts them in a native window with a locked-down webview.

const { app, BrowserWindow, Menu, shell, session } = require('electron');
const path = require('node:path');
const { createApp } = require('../core/server');

const isMac = process.platform === 'darwin';
let server = null;
let serverUrl = '';
let win = null;
let quitting = false;

function isHttp(url) {
  return /^https?:\/\//i.test(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 520,
    minHeight: 480,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Muser',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.once('ready-to-show', () => win.show());
  // Links open in the user's browser; the window itself never leaves the local app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverUrl)) {
      event.preventDefault();
      if (isHttp(url)) shell.openExternal(url);
    }
  });
  win.on('closed', () => { win = null; });
  win.loadURL(serverUrl);
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    // The app needs no device permissions (camera, mic, location, notifications...).
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    server = createApp({ dataDir: path.join(app.getPath('userData'), 'data') });
    ({ url: serverUrl } = await server.listen(0));
    buildMenu();
    createWindow();
    app.on('activate', () => { if (!win) createWindow(); });
  });

  // Let in-flight replies save as "stopped" before the process exits.
  app.on('before-quit', (event) => {
    if (quitting || !server) return;
    event.preventDefault();
    quitting = true;
    server.close().finally(() => app.quit());
  });

  app.on('window-all-closed', () => { if (!isMac) app.quit(); });
}
