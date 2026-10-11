const TEMP_MIN = 16;
const TEMP_MAX = 30;
const SVG_NS = 'http://www.w3.org/2000/svg';
const TRAY_ICON_SIZES = [
  { size: 16, scaleFactor: 1 },
  { size: 20, scaleFactor: 1.25 },
  { size: 24, scaleFactor: 1.5 },
  { size: 32, scaleFactor: 2 },
];

const MENUS = {
  modo: {
    cool: { label: 'Resfriar', short: 'Frio', icon: 'snowflake' },
    dry: { label: 'Desumidificar', short: 'Seco', icon: 'droplets' },
    wind: { label: 'Ventilar', short: 'Ventilar', icon: 'fan' },
    auto: { label: 'Automático', short: 'Auto', icon: 'sparkles' },
  },
  vento: {
    auto: { label: 'Automático', short: 'Auto', icon: 'sparkles' },
    low: { label: 'Baixo', short: 'Baixo', icon: 'signal-low' },
    medium: { label: 'Médio', short: 'Médio', icon: 'signal-medium' },
    high: { label: 'Alto', short: 'Alto', icon: 'signal-high' },
    turbo: { label: 'Turbo', short: 'Turbo', icon: 'signal' },
  },
  oscilar: {
    fixed: { label: 'Fixa', short: 'Fixa', icon: 'minus' },
    vertical: { label: 'Vertical', short: 'Vertical', icon: 'move-vertical' },
    horizontal: { label: 'Lateral', short: 'Lateral', icon: 'move-horizontal' },
    all: { label: 'Vertical e lateral', short: 'Ambas', icon: 'move' },
  },
};

const EXTRA_BY_FLAGS = {
  'false,false': 'off',
  'true,false': 'windFree',
  'false,true': 'sleep',
  'true,true': 'windFreeSleep',
};

const UNCONFIRMED_NAMES = {
  ligado: 'o liga e desliga',
  temp: 'a temperatura',
  modo: 'o modo',
  vento: 'o vento',
  extra: 'o WindFree e o sono',
  oscilar: 'a direção',
  display: 'a luz do display',
  bipe: 'o bipe',
  autoclean: 'a secagem automática',
};

const FILTER_NOTES = {
  wash: 'Hora de lavar',
  replace: 'Hora de trocar',
};

const panel = document.getElementById('panel');
const menu = document.getElementById('menu');
const tempInput = document.getElementById('temp');

let view = null;
let darkTaskbar = true;
let trayIconKey = '';
let menuOwner = null;

function byId(id) {
  return document.getElementById(id);
}

function random(min, max) {
  return min + Math.random() * (max - min);
}

function iconElement(name) {
  const pascalName = name.replace(/(^|-)(\w)/g, (_match, _dash, letter) => letter.toUpperCase());
  return lucide.createElement(lucide.icons[pascalName], { class: 'lucide' });
}

function setIcon(container, name) {
  if (container.dataset.icon === name) return;
  container.dataset.icon = name;
  container.replaceChildren(iconElement(name));
}

function isWindFree(extra) {
  return extra === 'windFree' || extra === 'windFreeSleep';
}

function isSleep(extra) {
  return extra === 'sleep' || extra === 'windFreeSleep';
}

function extraFor(windFree, sleep) {
  return EXTRA_BY_FLAGS[`${windFree},${sleep}`];
}

function joinNames(names) {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`;
}

function send(key, value) {
  window.ac.set(key, value);
}

function withDevice(handler) {
  return (event) => {
    if (view?.device) handler(view.device, event);
  };
}

/* Scene */

function airPath(className, d, width, opacity) {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', className);
  path.setAttribute('d', d);
  path.style.strokeWidth = width.toFixed(2);
  path.style.opacity = opacity.toFixed(2);
  return path;
}

// Each strand is a faint continuous line with a brighter pulse travelling along it.
function buildStreaks() {
  const group = byId('streaks');
  const count = 18;
  for (let index = 0; index < count; index += 1) {
    const position = index / (count - 1);
    const fadeAtEdges = 1 - Math.abs(position - 0.5) * 0.9;
    const x = 78 + position * 164;
    const spread = (x - 160) * 0.45;
    const bend = random(-6, 6);
    const d = `M${x.toFixed(1)} 91 C${(x + bend).toFixed(1)} 112 ${(x + spread * 0.5 - bend).toFixed(1)} 138 ${(x + spread).toFixed(1)} 166`;
    const dash = random(26, 54);
    const gap = random(60, 120);
    const pulse = airPath('pulse', d, random(1.6, 3.6), random(0.3, 0.65) * fadeAtEdges);
    pulse.style.setProperty('--dash', `${dash.toFixed(1)}px`);
    pulse.style.setProperty('--gap', `${gap.toFixed(1)}px`);
    pulse.style.setProperty('--cycle', `${(dash + gap).toFixed(1)}px`);
    pulse.style.setProperty('--delay', `${(-random(0, 3)).toFixed(2)}s`);
    group.append(airPath('strand', d, random(1, 2.6), random(0.1, 0.2) * fadeAtEdges), pulse);
  }
}

function buildDrift() {
  const group = byId('drift');
  for (let index = 0; index < 44; index += 1) {
    const x = random(64, 256);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', 'dot');
    dot.setAttribute('cx', x.toFixed(1));
    dot.setAttribute('cy', random(88, 98).toFixed(1));
    dot.setAttribute('r', random(0.9, 2.1).toFixed(2));
    dot.style.setProperty('--dx', `${((x - 160) * 0.12 + random(-6, 6)).toFixed(1)}px`);
    dot.style.setProperty('--dy', `${random(22, 62).toFixed(1)}px`);
    dot.style.setProperty('--dur', `${random(3.4, 7).toFixed(2)}s`);
    dot.style.setProperty('--delay', `${(-random(0, 7)).toFixed(2)}s`);
    group.append(dot);
  }
}

/* Rendering */

function showSetpoint(value) {
  const element = byId('setpoint');
  const previous = Number(element.textContent);
  if (previous === value) return;
  element.textContent = value;
  if (Number.isNaN(previous)) return;
  element.classList.remove('roll-up', 'roll-down');
  void element.offsetWidth;
  element.classList.add(value > previous ? 'roll-up' : 'roll-down');
}

function setSliderPosition(value) {
  tempInput.value = value;
  tempInput.parentElement.style.setProperty('--pct', (value - TEMP_MIN) / (TEMP_MAX - TEMP_MIN));
}

function renderCells(device) {
  for (const [key, options] of Object.entries(MENUS)) {
    document.querySelector(`[data-value-for='${key}']`).textContent = options[device[key]]?.short ?? device[key];
  }
  setIcon(document.querySelector("[data-icon-for='modo']"), MENUS.modo[device.modo]?.icon ?? 'snowflake');
  setIcon(document.querySelector("[data-icon-for='oscilar']"), MENUS.oscilar[device.oscilar]?.icon ?? 'minus');
  const sleeping = isSleep(device.extra);
  byId('sleep').setAttribute('aria-checked', String(sleeping));
  document.querySelector("[data-value-for='sono']").textContent = sleeping ? 'Ligado' : 'Desligado';
}

function filterNote(device) {
  const remainingHours = Math.max(0, Math.round(((100 - device.filtroUso) / 100) * device.filtroAlerta));
  return FILTER_NOTES[device.filtroStatus] ?? `Lavar daqui a ${remainingHours} h de uso`;
}

function renderSettings(device) {
  byId('device-name').textContent = device.nome ?? '';
  for (const toggle of document.querySelectorAll('[data-setting]')) {
    toggle.setAttribute('aria-checked', String(device[toggle.dataset.setting] === 'on'));
  }
  const meter = byId('filter-meter');
  meter.style.width = `${Math.min(100, device.filtroUso)}%`;
  meter.parentElement.dataset.alert = String(device.filtroStatus !== 'normal');
  byId('filter-note').textContent = filterNote(device);
  byId('power-now').textContent = `${device.potencia} W`;
  byId('energy-note').textContent = `${Math.round(device.energia).toLocaleString('pt-BR')} kWh no total`;
}

function renderDevice(device) {
  Object.assign(panel.dataset, {
    power: device.ligado ? 'on' : 'off',
    mode: device.modo,
    fan: device.vento,
    swing: device.oscilar,
    windfree: String(isWindFree(device.extra)),
    display: device.display,
  });
  byId('room-temp').textContent = `${device.ambiente}°`;
  byId('room-humidity').textContent = `${device.umidade}%`;
  byId('unit-display').textContent = device.temp;
  byId('power').setAttribute('aria-label', device.ligado ? 'Desligar o ar' : 'Ligar o ar');
  byId('windfree').setAttribute('aria-checked', String(isWindFree(device.extra)));
  byId('temp-down').disabled = device.temp <= TEMP_MIN;
  byId('temp-up').disabled = device.temp >= TEMP_MAX;
  if (!tempInput.parentElement.classList.contains('dragging')) {
    showSetpoint(device.temp);
    setSliderPosition(device.temp);
  }
  renderCells(device);
  renderSettings(device);
}

function statusFor(current) {
  if (current?.error?.kind === 'failed') {
    return { tone: 'error', icon: 'cloud-off', text: 'Sem resposta do SmartThings', retry: true };
  }
  if (current?.error?.kind === 'unconfirmed') {
    const names = current.error.keys.map((key) => UNCONFIRMED_NAMES[key] ?? key);
    return { tone: 'error', icon: 'triangle-alert', text: `O ar não confirmou ${joinNames(names)}` };
  }
  if (!current?.device) return { tone: 'busy', icon: 'loader-circle', text: 'Conectando ao SmartThings…' };
  if (current.syncing) return { tone: 'busy', icon: 'loader-circle', text: 'Sincronizando…' };
  if (current.held.length > 0) return { tone: 'quiet', icon: 'clock', text: 'Aplica quando ligar' };
  return { tone: 'ok', icon: 'shield-check', text: 'Conectado' };
}

function renderStatus() {
  const status = statusFor(view);
  const element = byId('status');
  element.dataset.tone = status.tone;
  setIcon(byId('status-icon'), status.icon);
  byId('status-text').textContent = status.text;
  byId('retry').hidden = !status.retry;
  element.title = view?.updatedAt
    ? `Atualizado às ${new Date(view.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
    : '';
}

function drawTrayIcon(size, device, tint) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const ink = darkTaskbar ? '#f3f5f7' : '#14181c';
  context.fillStyle = ink;
  context.globalAlpha = device?.ligado ? 1 : 0.5;
  context.font = `600 condensed ${Math.round(size * 0.8)}px Bahnschrift`;
  context.textAlign = 'center';
  context.fillText(device ? String(device.temp) : '--', size / 2, Math.round(size * 0.76));
  if (device?.ligado) {
    const bar = Math.max(2, Math.round(size / 10));
    context.globalAlpha = 1;
    context.fillStyle = darkTaskbar ? tint : ink;
    context.fillRect(Math.round(size * 0.18), size - bar, Math.round(size * 0.64), bar);
  }
  return canvas.toDataURL('image/png');
}

function renderTrayIcon() {
  const device = view?.device;
  const key = [device?.temp, device?.ligado, device?.modo, darkTaskbar].join('|');
  if (key === trayIconKey) return;
  trayIconKey = key;
  const tint = getComputedStyle(panel).getPropertyValue('--tint').trim();
  window.ac.setTrayIcon(
    TRAY_ICON_SIZES.map(({ size, scaleFactor }) => ({ scaleFactor, dataURL: drawTrayIcon(size, device, tint) })),
  );
}

function render() {
  const device = view?.device;
  panel.dataset.loading = String(!device);
  if (device) renderDevice(device);
  renderStatus();
  renderTrayIcon();
}

/* Option menus */

function menuItem(key, value, option, selected) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'menu-item';
  item.setAttribute('role', 'menuitemradio');
  item.setAttribute('aria-checked', String(selected));
  const label = document.createElement('span');
  label.textContent = option.label;
  const check = document.createElement('span');
  check.className = 'menu-check';
  if (selected) check.append(iconElement('check'));
  item.append(iconElement(option.icon), label, check);
  item.addEventListener('click', () => {
    closeMenu();
    send(key, value);
  });
  return item;
}

function openMenu(cell, device) {
  const key = cell.dataset.menu;
  const items = Object.entries(MENUS[key]).map(([value, option]) => menuItem(key, value, option, value === device[key]));
  menu.replaceChildren(...items);
  menu.hidden = false;
  const panelBox = panel.getBoundingClientRect();
  const cellBox = cell.getBoundingClientRect();
  const left = Math.min(cellBox.left - panelBox.left, panelBox.width - menu.offsetWidth - 12);
  menu.style.left = `${Math.max(12, left)}px`;
  menu.style.bottom = `${panelBox.bottom - cellBox.top + 8}px`;
  cell.setAttribute('aria-expanded', 'true');
  menuOwner = cell;
  (menu.querySelector("[aria-checked='true']") ?? menu.firstElementChild).focus();
}

function closeMenu() {
  if (!menuOwner) return;
  menu.hidden = true;
  menuOwner.setAttribute('aria-expanded', 'false');
  menuOwner = null;
}

/* Settings */

function openSettings() {
  closeMenu();
  panel.classList.add('settings-open');
  byId('settings').inert = false;
  document.querySelector('.view-main').inert = true;
  window.ac.getAutostart().then((enabled) => byId('autostart').setAttribute('aria-checked', String(enabled)));
  byId('close-settings').focus();
}

function closeSettings() {
  panel.classList.remove('settings-open');
  byId('settings').inert = true;
  document.querySelector('.view-main').inert = false;
}

/* Wiring */

byId('power').addEventListener('click', withDevice((device) => send('ligado', !device.ligado)));

byId('windfree').addEventListener(
  'click',
  withDevice((device) => send('extra', extraFor(!isWindFree(device.extra), isSleep(device.extra)))),
);

byId('sleep').addEventListener(
  'click',
  withDevice((device) => send('extra', extraFor(isWindFree(device.extra), !isSleep(device.extra)))),
);

byId('temp-down').addEventListener('click', withDevice((device) => send('temp', Math.max(TEMP_MIN, device.temp - 1))));
byId('temp-up').addEventListener('click', withDevice((device) => send('temp', Math.min(TEMP_MAX, device.temp + 1))));

tempInput.addEventListener('input', () => {
  const value = Number(tempInput.value);
  tempInput.parentElement.classList.add('dragging');
  showSetpoint(value);
  setSliderPosition(value);
});

tempInput.addEventListener('change', () => {
  tempInput.parentElement.classList.remove('dragging');
  send('temp', Number(tempInput.value));
});

for (const cell of document.querySelectorAll('[data-menu]')) {
  cell.addEventListener(
    'click',
    withDevice((device, event) => {
      event.stopPropagation();
      const reopening = menuOwner === cell;
      closeMenu();
      if (!reopening) openMenu(cell, device);
    }),
  );
}

menu.addEventListener('keydown', (event) => {
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const items = [...menu.children];
  const index = items.indexOf(document.activeElement);
  items[(index + step + items.length) % items.length].focus();
});

document.addEventListener('click', (event) => {
  if (!menu.contains(event.target)) closeMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (menuOwner) {
    const owner = menuOwner;
    closeMenu();
    owner.focus();
    return;
  }
  if (panel.classList.contains('settings-open')) {
    closeSettings();
    byId('open-settings').focus();
    return;
  }
  window.ac.hide();
});

byId('open-settings').addEventListener('click', openSettings);
byId('close-settings').addEventListener('click', closeSettings);
byId('retry').addEventListener('click', () => window.ac.refresh());

for (const toggle of document.querySelectorAll('[data-setting]')) {
  toggle.addEventListener(
    'click',
    withDevice((device) => {
      const key = toggle.dataset.setting;
      send(key, device[key] === 'on' ? 'off' : 'on');
    }),
  );
}

byId('autostart').addEventListener('click', () => {
  const enabled = byId('autostart').getAttribute('aria-checked') !== 'true';
  byId('autostart').setAttribute('aria-checked', String(enabled));
  window.ac.setAutostart(enabled);
});

panel.addEventListener('animationend', (event) => {
  if (event.target === panel) panel.classList.remove('entering');
});

window.ac.onShow(() => {
  panel.classList.remove('asleep', 'entering');
  void panel.offsetWidth;
  panel.classList.add('entering');
});

window.ac.onHide(() => {
  closeMenu();
  closeSettings();
  panel.classList.add('asleep');
});

window.ac.onTheme((dark) => {
  darkTaskbar = dark;
  trayIconKey = '';
  renderTrayIcon();
});

window.ac.onState((next) => {
  view = next;
  render();
});

lucide.createIcons();
buildStreaks();
buildDrift();

window.ac.getState().then((initial) => {
  darkTaskbar = initial.darkTaskbar;
  view ??= initial.view;
  render();
});
