const { app, BrowserWindow, shell, Menu, Tray, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ─── Konfigurasi (UBAH DI SINI jika URL berubah) ───────────────────────────
const WEBSITE_URL = 'https://absen-wfh-pussenif.vercel.app/admin'; // ← GANTI URL DI SINI
const APP_NAME    = 'Dashboard Absen WFH — Pussenif';

let mainWindow  = null;
let splashWindow = null;
let tray = null;

// ─── Splash Screen ──────────────────────────────────────────────────────────
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 320,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.show();
}

// ─── Window Utama ───────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 650,
    title: APP_NAME,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
    }
  });

  // Izinkan permintaan kamera & lokasi dari website
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'geolocation', 'notifications', 'camera', 'microphone'];
    callback(allowed.includes(permission));
  });

  // Link eksternal buka di browser default, bukan window baru Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // ── Kalau halaman gagal load → tampilkan offline.html ──────────────────
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    // Abaikan error navigasi yang tidak penting (misal user klik back saat loading)
    if (errorCode === -3) return;
    console.log(`Gagal load (${errorCode}): ${errorDescription}`);
    mainWindow.loadFile(path.join(__dirname, 'offline.html'));
  });

  // ── Setelah berhasil load → update title ───────────────────────────────
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.setTitle(APP_NAME);
  });

  // Keyboard shortcuts
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F5')  mainWindow.reload();
    if (input.key === 'F11') mainWindow.setFullScreen(!mainWindow.isFullScreen());
    if (input.key === 'F12') mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

// ─── System Tray ────────────────────────────────────────────────────────────
function createTray() {
  const iconFile = path.join(__dirname, 'assets', 'tray.png');
  if (!fs.existsSync(iconFile)) return;

  tray = new Tray(iconFile);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '🏛️ Buka Dashboard', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '🔄 Muat Ulang',     click: () => mainWindow?.reload() },
    { type: 'separator' },
    { label: '❌ Keluar',         click: () => app.quit() },
  ]));
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ─── IPC ────────────────────────────────────────────────────────────────────
ipcMain.handle('app:version', () => app.getVersion());

// ─── Lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createSplashWindow();
  createMainWindow();
  createTray();

  // Langsung load URL — jika gagal, did-fail-load akan tangani sendiri
  mainWindow.loadURL(WEBSITE_URL);

  // Tampilkan window utama + tutup splash setelah 2.5 detik
  // (memberi waktu splash terlihat sebentar walau loading cepat)
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
  }, 2500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  tray?.destroy();
});
