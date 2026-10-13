// Energia (custo + histórico), Timer (desligar em X) e Alertas. Tudo no frontend,
// persistido em localStorage; o webview segue vivo na bandeja, então timer e alertas
// funcionam com o painel fechado.
(() => {
  const byId = (id) => document.getElementById(id);
  const store = {
    get: (k, d) => {
      try {
        const v = localStorage.getItem(k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  };

  // ---------- Energia ----------
  const PRICE_KEY = 'windfree.kwhPrice';
  const HIST_KEY = 'windfree.energyHistory';
  const today = () => new Date().toISOString().slice(0, 10);

  function recordEnergy(total) {
    if (typeof total !== 'number' || total <= 0) return;
    const hist = store.get(HIST_KEY, []);
    const day = today();
    const last = hist[hist.length - 1];
    if (last && last.d === day) last.k = total;
    else hist.push({ d: day, k: total });
    store.set(HIST_KEY, hist.slice(-31));
  }

  function dailyDeltas() {
    const hist = store.get(HIST_KEY, []);
    const out = [];
    for (let i = 1; i < hist.length; i += 1) {
      const delta = hist[i].k - hist[i - 1].k;
      if (delta >= 0) out.push({ d: hist[i].d, kwh: delta });
    }
    return out;
  }

  function renderEnergy() {
    const price = Number(store.get(PRICE_KEY, 0.95)) || 0;
    const days = dailyDeltas();
    const note = byId('cost-note');
    if (note) {
      if (days.length === 0) {
        note.textContent = 'Juntando dados de consumo…';
      } else {
        const recent = days.slice(-7);
        const avg = recent.reduce((s, d) => s + d.kwh, 0) / recent.length;
        const month = avg * 30 * price;
        const todayKwh = days[days.length - 1].kwh;
        note.textContent = `Hoje ${todayKwh.toFixed(1)} kWh · ~R$ ${month.toFixed(2).replace('.', ',')}/mês`;
      }
    }
    const chart = byId('energy-chart');
    const wrap = chart ? chart.closest('.chart-wrap') : null;
    if (wrap) wrap.hidden = days.length === 0;
    if (chart && days.length > 0) {
      const last = days.slice(-14);
      const max = Math.max(0.1, ...last.map((d) => d.kwh));
      chart.replaceChildren();
      last.forEach((d, i) => {
        const w = 320 / 14;
        const h = (d.kwh / max) * 48;
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', (i * w + 2).toFixed(1));
        rect.setAttribute('y', (56 - h).toFixed(1));
        rect.setAttribute('width', (w - 4).toFixed(1));
        rect.setAttribute('height', Math.max(1, h).toFixed(1));
        rect.setAttribute('rx', '2');
        rect.setAttribute('class', 'energy-bar');
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        t.textContent = `${d.d}: ${d.kwh.toFixed(2)} kWh`;
        rect.append(t);
        chart.append(rect);
      });
    }
  }

  // ---------- Timer: desligar em X ----------
  const TIMER_KEY = 'windfree.offTimer';
  function setTimer(hours) {
    if (!hours) {
      localStorage.removeItem(TIMER_KEY);
    } else {
      store.set(TIMER_KEY, Date.now() + hours * 3600_000);
    }
    renderTimer();
  }
  function renderTimer() {
    const target = store.get(TIMER_KEY, null);
    const note = byId('timer-note');
    for (const chip of document.querySelectorAll('#timer-chips .chip')) {
      chip.classList.toggle('on', !target && chip.dataset.h === '0');
    }
    if (!note) return;
    if (!target) {
      note.textContent = 'Nenhum';
      return;
    }
    const left = target - Date.now();
    if (left <= 0) {
      note.textContent = 'Nenhum';
      return;
    }
    const h = Math.floor(left / 3600_000);
    const m = Math.floor((left % 3600_000) / 60_000);
    note.textContent = `Desliga em ${h > 0 ? `${h}h ` : ''}${m}min`;
    for (const chip of document.querySelectorAll('#timer-chips .chip')) {
      chip.classList.toggle('on', chip.dataset.h !== '0' && Number(chip.dataset.h) * 3600_000 >= left - 60_000 && Number(chip.dataset.h) * 3600_000 <= left + 3600_000);
    }
  }
  function tickTimer() {
    const target = store.get(TIMER_KEY, null);
    if (target && Date.now() >= target) {
      localStorage.removeItem(TIMER_KEY);
      window.ac.set('ligado', false);
    }
    renderTimer();
  }

  // ---------- Alertas ----------
  const ALERT_KEY = 'windfree.alerts';
  const ON_SINCE_KEY = 'windfree.onSince';
  function alertCfg() {
    return store.get(ALERT_KEY, { filtro: true, offline: true, longo: 0 });
  }
  function evalAlerts(view) {
    const cfg = alertCfg();
    const d = view && view.device;
    let msg = null;
    if (cfg.offline && view && view.error && view.error.kind === 'failed') {
      msg = { icon: 'cloud-off', text: 'Ar sem resposta na rede' };
    } else if (d) {
      if (d.ligado) {
        if (!store.get(ON_SINCE_KEY, null)) store.set(ON_SINCE_KEY, Date.now());
      } else {
        localStorage.removeItem(ON_SINCE_KEY);
      }
      if (cfg.filtro && d.filtroStatus && d.filtroStatus !== 'normal') {
        msg = { icon: 'wind', text: 'Hora de lavar o filtro' };
      }
      if (!msg && cfg.longo > 0 && d.ligado) {
        const since = store.get(ON_SINCE_KEY, Date.now());
        const hours = (Date.now() - since) / 3600_000;
        if (hours >= cfg.longo) msg = { icon: 'clock', text: `Ligado há ${Math.floor(hours)}h` };
      }
    }
    const banner = byId('alert-banner');
    if (!banner) return;
    if (!msg) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.replaceChildren(
      lucide.createElement(lucide.icons[msg.icon.replace(/(^|-)(\w)/g, (_a, _b, c) => c.toUpperCase())], { class: 'lucide' }),
      Object.assign(document.createElement('span'), { textContent: msg.text }),
    );
  }

  // ---------- wiring ----------
  const price = byId('kwh-price');
  if (price) {
    price.value = String(store.get(PRICE_KEY, 0.95)).replace('.', ',');
    price.addEventListener('change', () => {
      const n = parseFloat(price.value.replace(',', '.'));
      if (!Number.isNaN(n)) store.set(PRICE_KEY, n);
      renderEnergy();
    });
  }
  for (const chip of document.querySelectorAll('#timer-chips .chip')) {
    chip.addEventListener('click', () => setTimer(Number(chip.dataset.h)));
  }
  for (const toggle of document.querySelectorAll('[data-alert]')) {
    toggle.addEventListener('click', () => {
      const cfg = alertCfg();
      cfg[toggle.dataset.alert] = !cfg[toggle.dataset.alert];
      store.set(ALERT_KEY, cfg);
      toggle.setAttribute('aria-checked', String(cfg[toggle.dataset.alert]));
    });
    toggle.setAttribute('aria-checked', String(alertCfg()[toggle.dataset.alert]));
  }
  const longo = byId('alert-longo');
  if (longo) {
    longo.value = String(alertCfg().longo);
    longo.addEventListener('change', () => {
      const cfg = alertCfg();
      cfg.longo = Number(longo.value);
      store.set(ALERT_KEY, cfg);
    });
  }

  window.ac.onState((view) => {
    if (view && view.device) recordEnergy(view.device.energia);
    renderEnergy();
    evalAlerts(view);
  });

  setInterval(tickTimer, 20_000);
  renderTimer();
  renderEnergy();
})();
