const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, callback) {
  ipcRenderer.on(channel, (_event, payload) => callback(payload));
}

contextBridge.exposeInMainWorld('ac', {
  getState: () => ipcRenderer.invoke('state:get'),
  set: (key, value) => ipcRenderer.send('ac:set', key, value),
  refresh: () => ipcRenderer.send('ac:refresh'),
  hide: () => ipcRenderer.send('panel:hide'),
  setTrayIcon: (images) => ipcRenderer.send('tray:icon', images),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (enabled) => ipcRenderer.send('autostart:set', enabled),
  onState: (callback) => listen('state', callback),
  onTheme: (callback) => listen('theme', callback),
  onShow: (callback) => listen('panel:show', callback),
  onHide: (callback) => listen('panel:hide', callback),
});
