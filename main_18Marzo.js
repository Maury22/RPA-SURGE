const { app, BrowserWindow } = require('electron');
const path = require('path');
const iniciarServidor = require('./server_18Marzo.js'); 

let mainWindow;

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
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});