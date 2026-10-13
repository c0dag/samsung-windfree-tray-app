// Bridges the panel's window.ac API to the Rust backend via Tauri.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

window.ac = {
  getState: () => invoke('get_state'),
  set: (key, value) => invoke('ac_set', { key, value }),
  refresh: () => invoke('ac_refresh'),
  hide: () => invoke('hide_panel'),
  setTrayIcon: () => {},
  getAutostart: () => invoke('get_autostart'),
  setAutostart: (enabled) => invoke('set_autostart', { enabled }),
  onState: (cb) => listen('state', (event) => cb(event.payload)),
  onTheme: () => {},
  onShow: (cb) => listen('panel:show', () => cb()),
  onHide: (cb) => listen('panel:hide', () => cb()),
};
