const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('alertApi', {
    onError: (cb) => ipcRenderer.on('alert-error', (_, texto) => cb(texto)),
    close: () => ipcRenderer.send('alert-close')
});
