const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const iniciarServidor = require('./server_18Marzo.js');

let mainWindow;

// --- Configuración del Auto-Updater ---
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(undefined);

autoUpdater.on('update-available', (info) => {
    mainWindow.webContents.send('update-status', { type: 'available', version: info.version });
});

autoUpdater.on('download-progress', (progress) => {
    mainWindow.webContents.send('update-status', { type: 'progress', percent: Math.round(progress.percent) });
});

autoUpdater.on('update-downloaded', (info) => {
    mainWindow.webContents.send('update-status', { type: 'downloaded', version: info.version });
});


autoUpdater.on('error', (err) => {
    if (mainWindow) mainWindow.webContents.send('update-status', { type: 'error', message: err.message });
});
// ------------------------------------

app.whenReady().then(() => {
    // 1. Ruta segura para el motor interno
    app.setPath('userData', path.join(app.getPath('appData'), 'Robot-SSSalud'));
    const rutaSeguraDatos = app.getPath('userData');

    // 2. Ruta de tu código
    const rutaCodigo = __dirname;

    // 3. NUEVO: Obtenemos la ruta del Escritorio del usuario que esté usando la app
    const rutaEscritorio = app.getPath('desktop');

    // Le pasamos esta nueva ruta al cerebro
    iniciarServidor(rutaSeguraDatos, rutaCodigo, rutaEscritorio);

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "Robot SSSalud - Interfaz Autónoma",
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'public', 'favicon.ico'),
        webPreferences: {
            nodeIntegration: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadURL('http://localhost:3000');

    mainWindow.on('closed', function () {
        mainWindow = null;
    });

    // Chequear actualizaciones 5 segundos después de que cargó la ventana
    // (le damos tiempo al servidor interno para arrancar)
    setTimeout(() => {
        if (app.isPackaged) {
            autoUpdater.checkForUpdates();
        }
    }, 5000);
});

ipcMain.on('install-update', () => autoUpdater.quitAndInstall());

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});
