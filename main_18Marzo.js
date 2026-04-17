const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const iniciarServidor = require('./server_18Marzo.js');

let mainWindow;

// --- Configuración del Auto-Updater ---
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(undefined);

autoUpdater.on('update-available', () => {
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Actualización disponible',
        message: 'Hay una nueva versión del Robot SSSalud.\nSe está descargando en segundo plano. Al cerrar la app se instalará automáticamente.',
        buttons: ['Entendido']
    });
});

autoUpdater.on('update-downloaded', () => {
    const respuesta = dialog.showMessageBoxSync(mainWindow, {
        type: 'info',
        title: 'Actualización lista',
        message: '¡La nueva versión ya está lista!\n¿Querés reiniciar ahora para instalarla?',
        buttons: ['Reiniciar ahora', 'Más tarde']
    });
    if (respuesta === 0) {
        autoUpdater.quitAndInstall();
    }
});


autoUpdater.on('error', (err) => {
    dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Error en auto-updater',
        message: err.message,
        buttons: ['OK']
    });
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
            nodeIntegration: true
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

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});
