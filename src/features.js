// Favoritos (presets): save the current climate state and re-apply it with one
// click. Stored locally in the webview (localStorage), no backend changes needed.
(() => {
  const KEY = 'windfree.presets';
  const FIELDS = ['temp', 'modo', 'vento', 'extra', 'oscilar'];
  const MODE_LABEL = { cool: 'Frio', dry: 'Seco', wind: 'Ventilar', auto: 'Auto' };
  let last = null;

  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || [];
    } catch {
      return [];
    }
  };
  const save = (presets) => localStorage.setItem(KEY, JSON.stringify(presets));

  function icon(name) {
    const pascal = name.replace(/(^|-)(\w)/g, (_m, _d, c) => c.toUpperCase());
    return lucide.createElement(lucide.icons[pascal], { class: 'lucide' });
  }

  function describe(p) {
    const windFree = p.extra === 'windFree' || p.extra === 'windFreeSleep';
    return `${p.temp}° ${MODE_LABEL[p.modo] ?? p.modo}${windFree ? ' · WindFree' : ''}`;
  }

  function applyPreset(p) {
    window.ac.set('ligado', true);
    for (const f of FIELDS) {
      if (p[f] !== undefined) window.ac.set(f, p[f]);
    }
  }

  function render() {
    const listEl = document.getElementById('preset-list');
    if (!listEl) return;
    const presets = load();
    listEl.replaceChildren();
    if (presets.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'preset-empty';
      empty.textContent = 'Ligue o ar do jeito que gosta e toque em Salvar.';
      listEl.append(empty);
      return;
    }
    for (const p of presets) {
      const row = document.createElement('div');
      row.className = 'preset-row';
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'preset-apply';
      apply.append(icon('star'), Object.assign(document.createElement('span'), { textContent: describe(p) }));
      apply.addEventListener('click', () => applyPreset(p));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'preset-del';
      del.setAttribute('aria-label', 'Apagar favorito');
      del.append(icon('trash-2'));
      del.addEventListener('click', () => {
        save(load().filter((x) => x.id !== p.id));
        render();
      });
      row.append(apply, del);
      listEl.append(row);
    }
  }

  function saveCurrent() {
    if (!last || !last.ligado) return;
    const presets = load();
    const preset = { id: Date.now() };
    for (const f of FIELDS) preset[f] = last[f];
    presets.push(preset);
    save(presets);
    render();
  }

  window.ac.onState((view) => {
    if (view && view.device) last = view.device;
    const btn = document.getElementById('preset-save');
    if (btn) btn.disabled = !(last && last.ligado);
  });

  const saveBtn = document.getElementById('preset-save');
  if (saveBtn) saveBtn.addEventListener('click', saveCurrent);
  render();
})();
