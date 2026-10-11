import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.join(ROOT, 'node_modules', '@smartthings', 'cli', 'dist', 'src', 'run.js');
const DEVICE_FILE = path.join(ROOT, 'device.json');
const CONFIRM_ATTEMPTS = 4;
const CONFIRM_INTERVAL_MS = 1500;

const ACTIONS = {
  liga: { key: 'ligado', expected: true, command: 'switch:on' },
  desliga: { key: 'ligado', expected: false, command: 'switch:off' },
  'zera-filtro': { key: 'filtroUso', expected: 0, command: 'custom.dustFilter:resetDustFilter' },
};

const SETTINGS = {
  temp: {
    capability: 'thermostatCoolingSetpoint',
    attribute: 'coolingSetpoint',
    command: 'setCoolingSetpoint',
    values: Array.from({ length: 15 }, (_, i) => 16 + i),
  },
  modo: {
    capability: 'airConditionerMode',
    attribute: 'airConditionerMode',
    command: 'setAirConditionerMode',
    values: ['cool', 'dry', 'wind', 'auto'],
  },
  vento: {
    capability: 'airConditionerFanMode',
    attribute: 'fanMode',
    command: 'setFanMode',
    values: ['auto', 'low', 'medium', 'high', 'turbo'],
  },
  extra: {
    capability: 'custom.airConditionerOptionalMode',
    attribute: 'acOptionalMode',
    command: 'setAcOptionalMode',
    values: ['off', 'windFree', 'windFreeSleep', 'sleep', 'quiet', 'speed'],
  },
  oscilar: {
    capability: 'fanOscillationMode',
    attribute: 'fanOscillationMode',
    command: 'setFanOscillationMode',
    values: ['fixed', 'vertical', 'horizontal', 'all'],
  },
  tropical: {
    capability: 'custom.airConditionerTropicalNightMode',
    attribute: 'acTropicalNightModeLevel',
    command: 'setAcTropicalNightModeLevel',
    values: Array.from({ length: 36 }, (_, i) => i),
  },
  display: {
    // The unit ignores this capability's commands (it lists it as disabled) but still reports the real state here.
    // Samsung's OCF option that works is inverted: Light_On turns the display off.
    capability: 'samsungce.airConditionerLighting',
    attribute: 'lighting',
    commands: {
      on: 'execute:execute("mode/vs/0",{"x.com.samsung.da.options":["Light_Off"]})',
      off: 'execute:execute("mode/vs/0",{"x.com.samsung.da.options":["Light_On"]})',
    },
  },
  bipe: {
    capability: 'audioVolume',
    attribute: 'volume',
    commands: { on: 'audioVolume:setVolume(100)', off: 'audioVolume:setVolume(0)' },
    fromValue: (volume) => (volume > 0 ? 'on' : 'off'),
  },
  autoclean: {
    capability: 'custom.autoCleaningMode',
    attribute: 'autoCleaningMode',
    command: 'setAutoCleaningMode',
    values: ['on', 'off'],
  },
  limpeza: {
    capability: 'custom.autoCleaningMode',
    attribute: 'operatingState',
    commands: { on: 'custom.autoCleaningMode:start("autoClean")', off: 'custom.autoCleaningMode:stop' },
    fromValue: (state) => (state === 'ready' ? 'off' : 'on'),
  },
  filtroAlerta: {
    capability: 'samsungce.dustFilterAlarm',
    attribute: 'alarmThreshold',
    command: 'setAlarmThreshold',
    values: [180, 300, 500, 700],
  },
  diagnostico: {
    capability: 'samsungce.selfCheck',
    attribute: 'status',
    commands: { on: 'samsungce.selfCheck:startSelfCheck', off: 'samsungce.selfCheck:cancelSelfCheck' },
    fromValue: (status) => (status === 'running' ? 'on' : 'off'),
  },
};

function runCli(...args) {
  return execFileSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function isAirConditioner({ components = [] }) {
  return components.some(({ capabilities = [] }) => capabilities.some(({ id }) => id === 'airConditionerMode'));
}

// The first run picks the first AC on the SmartThings account; edit device.json to point at another one.
function findAirConditioner() {
  const found = JSON.parse(runCli('devices', '-j')).find(isAirConditioner);
  if (!found) throw new Error('Nenhum ar-condicionado encontrado na sua conta SmartThings.');
  const device = { id: found.deviceId, nome: found.label ?? found.name };
  writeFileSync(DEVICE_FILE, `${JSON.stringify(device, null, 2)}\n`);
  return device;
}

function loadDevice() {
  try {
    return JSON.parse(readFileSync(DEVICE_FILE, 'utf8'));
  } catch {
    return findAirConditioner();
  }
}

function parseActions(tokens) {
  const actions = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === 'status') continue;
    if (ACTIONS[token]) {
      actions.push(ACTIONS[token]);
      continue;
    }
    const setting = SETTINGS[token];
    if (!setting) {
      const known = ['status', ...Object.keys(ACTIONS), ...Object.keys(SETTINGS)];
      throw new Error(`Ação desconhecida: ${token}. Use: ${known.join(', ')}`);
    }
    i += 1;
    const values = setting.values ?? Object.keys(setting.commands);
    const value = typeof values[0] === 'number' ? Number(tokens[i]) : tokens[i];
    if (!values.includes(value)) {
      throw new Error(`${token} aceita: ${values.join(', ')}`);
    }
    actions.push({
      key: token,
      expected: value,
      command: setting.commands?.[value] ?? `${setting.capability}:${setting.command}(${JSON.stringify(value)})`,
    });
  }
  return actions;
}

function readStatus(deviceId) {
  const main = JSON.parse(runCli('devices:status', deviceId, '-j')).components.main;
  const settings = Object.fromEntries(
    Object.entries(SETTINGS).map(([key, { capability, attribute, fromValue = (value) => value }]) => [
      key,
      fromValue(main[capability]?.[attribute]?.value),
    ]),
  );
  const { power, energy } = main.powerConsumptionReport?.powerConsumption?.value ?? {};
  return {
    ligado: main.switch.switch.value === 'on',
    ...settings,
    tropicalRestante: main['custom.airConditionerTropicalNightMode']?.remainingTime?.value,
    limpezaPct: main['custom.autoCleaningMode']?.progress?.value,
    filtroUso: main['custom.dustFilter']?.dustFilterUsage?.value,
    filtroStatus: main['custom.dustFilter']?.dustFilterStatus?.value,
    diagnosticoResultado: main['samsungce.selfCheck']?.result?.value,
    diagnosticoErros: (main['samsungce.selfCheck']?.errors?.value ?? []).map(({ code }) => code),
    potencia: power,
    energia: Number((energy / 1000).toFixed(1)),
    ambiente: main.temperatureMeasurement?.temperature?.value,
    umidade: main.relativeHumidityMeasurement?.humidity?.value,
  };
}

function pendingKeys(actions, status) {
  return actions.filter(({ key, expected }) => status[key] !== expected).map(({ key }) => key);
}

try {
  const actions = parseActions(process.argv.slice(2));
  const device = loadDevice();
  for (const { command } of actions) runCli('devices:commands', device.id, command);

  let status = readStatus(device.id);
  for (let attempt = 1; attempt < CONFIRM_ATTEMPTS && pendingKeys(actions, status).length > 0; attempt++) {
    await sleep(CONFIRM_INTERVAL_MS);
    status = readStatus(device.id);
  }

  const output = { nome: device.nome, ...status };
  const pendente = pendingKeys(actions, status);
  console.log(JSON.stringify(pendente.length > 0 ? { ...output, pendente } : output));
} catch (error) {
  console.error(error.stderr?.trim() || error.message);
  process.exit(1);
}
