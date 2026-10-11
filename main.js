const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme, powerMonitor, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { AcBridge } = require('./bridge');

const PANEL_SIZE = { width: 412, height: 536 };
const POLL_VISIBLE_MS = 15_000;
const POLL_HIDDEN_MS = 60_000;
const STALE_AFTER_MS = 5_000;
const REOPEN_GUARD_MS = 300;
const LOGIN_ITEM_NAME = 'WindFree';

const bridge = new AcBridge();
let tray;
let panel;
let pollTimer;
let lastBlurAt = 0;
let menuPowerState;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function isAutostartEnabled() {
  return readSettings().autostart ?? true;
}

// Unpackaged, electron.exe needs the app folder as an argument or it boots the default app.
function setAutostart(enabled) {
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), autostart: enabled }));
  const launch = app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };
  app.setLoginItemSettings({ openAtLogin: enabled, name: LOGIN_ITEM_NAME, ...launch });
  updateMenu(true);
}

function taskbarIsDark() {
  return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ?? nativeTheme.shouldUseDarkColors;
}

function createPanel() {
  const panelWindow = new BrowserWindow({
    ...PANEL_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    type: 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  panelWindow.loadFile(path.join(__dirname, 'panel', 'index.html'));
  panelWindow.on('blur', () => {
    lastBlurAt = Date.now();
    hidePanel();
  });
  return panelWindow;
}

function positionPanel() {
  const trayBounds = tray.getBounds();
  const anchor = { x: trayBounds.x + trayBounds.width / 2, y: trayBounds.y };
  const { workArea } = screen.getDisplayNearestPoint(anchor);
  const [width, height] = panel.getSize();
  const rightmost = workArea.x + workArea.width - width;
  const centered = trayBounds.width > 0 ? Math.round(anchor.x - width / 2) : rightmost;
  panel.setPosition(Math.max(workArea.x, Math.min(centered, rightmost)), workArea.y + workArea.height - height);
}

function showPanel() {
  positionPanel();
  panel.webContents.send('panel:show');
  panel.show();
  panel.focus();
  if (Date.now() - (bridge.updatedAt ?? 0) > STALE_AFTER_MS) bridge.refresh();
  schedulePoll();
}

function hidePanel() {
  if (!panel.isVisible()) return;
  panel.hide();
  panel.webContents.send('panel:hide');
  schedulePoll();
}

// Clicking the tray icon blurs an open panel first, so a click right after a blur means "close", not "reopen".
function togglePanel() {
  if (panel.isVisible()) {
    hidePanel();
    return;
  }
  if (Date.now() - lastBlurAt < REOPEN_GUARD_MS) return;
  showPanel();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const delay = panel.isVisible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
  pollTimer = setTimeout(() => {
    bridge.refresh();
    schedulePoll();
  }, delay);
}

function tooltipFor({ device }) {
  if (!device) return 'WindFree';
  const power = device.ligado ? `ligado em ${device.temp} °C` : 'desligado';
  return `${device.nome ?? 'Ar-condicionado'} ${power}\nAmbiente com ${device.ambiente} °C e ${device.umidade}% de umidade`;
}

function updateMenu(force = false) {
  const { device } = bridge.view();
  const powerState = device?.ligado;
  if (!force && powerState === menuPowerState) return;
  menuPowerState = powerState;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir painel', click: showPanel },
      {
        label: powerState ? 'Desligar' : 'Ligar',
        enabled: Boolean(device),
        click: () => bridge.set('ligado', !powerState),
      },
      { label: 'Atualizar agora', click: () => bridge.refresh() },
      { type: 'separator' },
      {
        label: 'Abrir com o Windows',
        type: 'checkbox',
        checked: isAutostartEnabled(),
        click: (item) => setAutostart(item.checked),
      },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ]),
  );
}

function trayImage(images) {
  const image = nativeImage.createEmpty();
  for (const { scaleFactor, dataURL } of images) image.addRepresentation({ scaleFactor, dataURL });
  return image;
}

function start() {
  panel = createPanel();
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('WindFree');
  tray.on('click', togglePanel);
  updateMenu(true);
  setAutostart(isAutostartEnabled());

  bridge.on('change', (view) => {
    panel.webContents.send('state', view);
    tray.setToolTip(tooltipFor(view));
    updateMenu();
  });

  ipcMain.handle('state:get', () => ({ view: bridge.view(), darkTaskbar: taskbarIsDark() }));
  ipcMain.handle('autostart:get', isAutostartEnabled);
  ipcMain.on('autostart:set', (_event, enabled) => setAutostart(enabled));
  ipcMain.on('ac:set', (_event, key, value) => bridge.set(key, value));
  ipcMain.on('ac:refresh', () => bridge.refresh());
  ipcMain.on('panel:hide', hidePanel);
  ipcMain.on('tray:icon', (_event, images) => tray.setImage(trayImage(images)));

  nativeTheme.on('updated', () => panel.webContents.send('theme', taskbarIsDark()));
  powerMonitor.on('resume', () => bridge.refresh());
  app.on('second-instance', showPanel);

  bridge.refresh();
  schedulePoll();
}

if (app.requestSingleInstanceLock()) {
  app.whenReady().then(start);
} else {
  app.quit();
}
