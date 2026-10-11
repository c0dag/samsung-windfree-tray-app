const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');

const AC_SCRIPT = path.join(__dirname, 'ac.mjs');
const FLUSH_DELAY_MS = 600;
const RUN_TIMEOUT_MS = 120_000;
const CLIMATE_KEYS = new Set(['temp', 'modo', 'vento', 'extra', 'oscilar']);
const SETTABLE_KEYS = new Set(['ligado', ...CLIMATE_KEYS, 'display', 'bipe', 'autoclean']);

const RunKind = Object.freeze({
  Idle: 'idle',
  Command: 'command',
  Refresh: 'refresh',
});

function arTokens(changes) {
  const tokens = changes.get('ligado') === true ? ['liga'] : [];
  for (const [key, value] of changes) {
    if (key !== 'ligado') tokens.push(key, String(value));
  }
  if (changes.get('ligado') === false) tokens.push('desliga');
  return tokens;
}

function lowerPriority(pid) {
  if (!pid) return;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // The status read can finish before we get to lower its priority.
  }
}

class AcBridge extends EventEmitter {
  #script;
  #confirmed = null;
  #pending = new Map();
  #inflight = new Map();
  #run = RunKind.Idle;
  #error = null;
  #updatedAt = null;
  #flushTimer = null;

  constructor({ script = AC_SCRIPT } = {}) {
    super();
    this.#script = script;
  }

  get updatedAt() {
    return this.#updatedAt;
  }

  view() {
    const sendable = this.#sendable();
    const device = this.#confirmed && {
      ...this.#confirmed,
      ...Object.fromEntries(this.#inflight),
      ...Object.fromEntries(this.#pending),
    };
    return {
      device,
      syncing: this.#run === RunKind.Command || sendable.size > 0,
      held: [...this.#pending.keys()].filter((key) => !sendable.has(key)),
      error: this.#error,
      updatedAt: this.#updatedAt,
    };
  }

  set(key, value) {
    if (!SETTABLE_KEYS.has(key)) return;
    const alreadyThere = this.#confirmed?.[key] === value && !this.#inflight.has(key);
    if (alreadyThere) this.#pending.delete(key);
    else this.#pending.set(key, value);
    this.#error = null;
    this.#changed();
    this.#scheduleFlush();
  }

  refresh() {
    if (this.#run !== RunKind.Idle) return;
    this.#start([], RunKind.Refresh);
  }

  // The unit ignores climate changes while it is off, so those wait for a power-on.
  #sendable() {
    const willBeOn = this.#pending.get('ligado') ?? Boolean(this.#confirmed?.ligado);
    return new Map([...this.#pending].filter(([key]) => willBeOn || !CLIMATE_KEYS.has(key)));
  }

  #scheduleFlush() {
    clearTimeout(this.#flushTimer);
    this.#flushTimer = setTimeout(() => this.#flush(), FLUSH_DELAY_MS);
  }

  #flush() {
    if (this.#run !== RunKind.Idle) return;
    const changes = this.#sendable();
    if (changes.size === 0) return;
    for (const key of changes.keys()) this.#pending.delete(key);
    this.#inflight = changes;
    this.#start(arTokens(changes), RunKind.Command);
  }

  #start(tokens, kind) {
    this.#run = kind;
    this.#changed();
    // System Node on purpose: under Electron's runtime the SmartThings CLI's yargs misreads argv.
    const child = execFile(
      'node',
      [this.#script, ...tokens],
      { timeout: RUN_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => this.#finish(error, stdout, stderr),
    );
    if (kind === RunKind.Refresh) lowerPriority(child.pid);
  }

  #finish(error, stdout, stderr) {
    this.#run = RunKind.Idle;
    this.#inflight = new Map();
    try {
      if (error) throw new Error(stderr.trim().split('\n')[0] || error.message);
      const { pendente = [], ...device } = JSON.parse(stdout);
      this.#confirmed = device;
      this.#updatedAt = Date.now();
      this.#error = pendente.length > 0 ? { kind: 'unconfirmed', keys: pendente } : null;
    } catch (failure) {
      this.#error = { kind: 'failed', message: failure.message };
    }
    this.#changed();
    if (this.#sendable().size > 0) this.#scheduleFlush();
  }

  #changed() {
    this.emit('change', this.view());
  }
}

module.exports = { AcBridge };
