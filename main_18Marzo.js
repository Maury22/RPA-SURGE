const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const iniciarServidor = require('./server_18Marzo.js');

let mainWindow;
let alertWindow = null;
let alertTimer = null;
// Diseño del robot de error: 'a' tacho oxidado, 'b' juguete a cuerda, 'c' kawaii, 'd' metálico 3D,
// 'e' inflable de vinilo, 'f' blanco y verde, 'g' dramático. (archivos en public/robots/)
const ROBOT_ERROR = 'g';
const ESCALA_ROBOT = 0.7; // tamaño del popup (1 = original, menor = más chico)

// Entrada: la ventana viaja desde fuera del borde derecho hasta su lugar (ease-out)
function deslizarDesdeDerecha(win, xInicio, xFinal, y, duracion = 450) {
    const t0 = Date.now();
    const timer = setInterval(() => {
        if (win.isDestroyed()) return clearInterval(timer);
        const p = Math.min(1, (Date.now() - t0) / duracion);
        const e = 1 - Math.pow(1 - p, 3);
        const [w, h] = win.getSize();
        win.setBounds({ x: Math.round(xInicio + (xFinal - xInicio) * e), y, width: w, height: h });
        if (p >= 1) clearInterval(timer);
    }, 15);
}

const SEGUNDOS_ALERTA = 6; // cuánto se queda el popup en pantalla
function programarCierreAlerta() {
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => {
        if (alertWindow && !alertWindow.isDestroyed()) alertWindow.close();
    }, SEGUNDOS_ALERTA * 1000);
}

// --- Aviso flotante de error (robotito + sonido sobre el escritorio) ---
function mostrarAlertaError(texto) {
    const corto = String(texto).replace(/^\s*❌\s*/, '').trim().slice(0, 140);

    if (alertWindow && !alertWindow.isDestroyed()) {
        alertWindow.webContents.send('alert-error', corto);
        alertWindow.showInactive();
        programarCierreAlerta();
        return;
    }

    const { workArea } = require('electron').screen.getPrimaryDisplay();
    const ancho = Math.round(380 * ESCALA_ROBOT), alto = Math.round(520 * ESCALA_ROBOT);
    const xFinal = workArea.x + workArea.width - ancho - 20;
    const yFinal = workArea.y + workArea.height - alto - 10;
    const xInicio = workArea.x + workArea.width; // justo fuera de la pantalla, a la derecha
    alertWindow = new BrowserWindow({
        width: ancho,
        height: alto,
        x: xInicio,
        y: yFinal,
        frame: false,
        transparent: true,
        resizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload-alert.js'),
            autoplayPolicy: 'no-user-gesture-required'
        }
    });
    alertWindow.setAlwaysOnTop(true, 'screen-saver');
    alertWindow.loadFile(path.join(__dirname, 'public', 'robots', `robot-${ROBOT_ERROR}.html`));
    alertWindow.webContents.once('did-finish-load', () => {
        if (!alertWindow || alertWindow.isDestroyed()) return;
        alertWindow.webContents.setZoomFactor(ESCALA_ROBOT);
        alertWindow.webContents.send('alert-error', corto);
        alertWindow.showInactive();
        deslizarDesdeDerecha(alertWindow, xInicio, xFinal, yFinal);
        programarCierreAlerta();
    });
    alertWindow.on('closed', () => { alertWindow = null; clearTimeout(alertTimer); });
}

ipcMain.on('alert-close', () => {
    if (alertWindow && !alertWindow.isDestroyed()) alertWindow.close();
});

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
    iniciarServidor(rutaSeguraDatos, rutaCodigo, rutaEscritorio, mostrarAlertaError);

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
