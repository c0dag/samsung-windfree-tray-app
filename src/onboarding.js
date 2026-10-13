// First run (or "Trocar" in Ajustes): find the air conditioners on the LAN and pick one,
// so nobody has to look up an id or edit device.json. Uses app.js's byId, iconElement,
// closeSettings and panel.
(() => {
  const setup = byId('setup');
  let found = [];
  let chosen = 0;
  let cancelable = false;
  let scanning = false;
  // chooseDevice is async: ignore the setup flag until the backend confirms the choice.
  let choosing = false;

  const showStep = (step) => {
    setup.dataset.step = step;
  };

  function describe(device) {
    const parts = [device.ligado ? `Ligado · ${device.temp}°` : 'Desligado'];
    if (device.ambiente != null) parts.push(`ambiente ${device.ambiente}°`);
    parts.push(device.ip);
    return parts.join(' · ');
  }

  function renderList() {
    byId('setup-found-title').textContent =
      found.length === 1 ? 'Encontrei seu ar-condicionado:' : `Encontrei ${found.length} ares-condicionados. Escolha qual controlar:`;
    const options = found.map((device, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'row device-option';
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', String(index === chosen));
      const text = document.createElement('span');
      text.className = 'row-text';
      text.append(
        Object.assign(document.createElement('span'), { className: 'row-title', textContent: 'Ar-condicionado Samsung' }),
        Object.assign(document.createElement('span'), { className: 'row-note', textContent: describe(device) }),
      );
      option.append(iconElement('air-vent'), text, Object.assign(document.createElement('span'), { className: 'device-radio' }));
      option.addEventListener('click', () => {
        chosen = index;
        renderList();
      });
      return option;
    });
    byId('setup-list').replaceChildren(...options);
  }

  function reasonFor(scan) {
    if (!scan.network) return 'O PC não parece estar conectado a uma rede local.';
    if (scan.responded === 0) return `Nenhum aparelho Samsung respondeu na rede ${scan.network}.x.`;
    return `${scan.responded} aparelho(s) Samsung responderam, mas nenhum é um ar-condicionado compatível.`;
  }

  function showFound(list) {
    found = list;
    chosen = 0;
    renderList();
    showStep('found');
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    showStep('scanning');
    try {
      const result = await window.ac.scanDevices();
      if (result.found.length > 0) {
        showFound(result.found);
        return;
      }
      byId('setup-reason').textContent = reasonFor(result);
      showStep('empty');
    } catch (error) {
      byId('setup-reason').textContent = String(error);
      showStep('empty');
    } finally {
      scanning = false;
    }
  }

  async function connectIp() {
    const ip = byId('setup-ip').value.trim();
    const errorText = byId('setup-ip-error');
    errorText.hidden = true;
    if (!ip) return;
    const button = byId('setup-connect');
    button.disabled = true;
    button.textContent = 'Conectando…';
    try {
      showFound([await window.ac.probeIp(ip)]);
    } catch (error) {
      errorText.textContent = String(error);
      errorText.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Conectar';
    }
  }

  function open(canCancel) {
    cancelable = canCancel;
    byId('setup-back').hidden = !canCancel;
    byId('setup-name').value = '';
    panel.classList.add('setup-open');
    setup.inert = false;
    document.querySelector('.view-main').inert = true;
    scan();
  }

  function close() {
    panel.classList.remove('setup-open');
    setup.inert = true;
    document.querySelector('.view-main').inert = false;
  }

  function use() {
    const device = found[chosen];
    if (!device) return;
    choosing = true;
    window.ac.chooseDevice({ id: device.id, ip: device.ip, nome: byId('setup-name').value.trim() || 'Ar-condicionado' });
    close();
  }

  function maybeOpen(view) {
    if (!view?.setup) {
      choosing = false;
      return;
    }
    if (!choosing && !panel.classList.contains('setup-open')) open(false);
  }

  byId('setup-use').addEventListener('click', use);
  byId('setup-rescan').addEventListener('click', scan);
  byId('setup-retry').addEventListener('click', scan);
  byId('setup-back').addEventListener('click', close);
  byId('setup-connect').addEventListener('click', connectIp);
  byId('setup-manual-back').addEventListener('click', () => showStep('empty'));
  byId('setup-manual').addEventListener('click', () => {
    byId('setup-ip-error').hidden = true;
    showStep('manual');
    byId('setup-ip').focus();
  });
  byId('setup-ip').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') connectIp();
  });
  byId('change-device').addEventListener('click', () => {
    closeSettings();
    open(true);
  });

  // Runs before app.js's Escape handler, which would hide the whole panel.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !cancelable || !panel.classList.contains('setup-open')) return;
      event.stopImmediatePropagation();
      close();
    },
    true,
  );

  window.ac.onHide(() => {
    if (cancelable) close();
  });
  window.ac.onState(maybeOpen);
  window.ac.getState().then(({ view }) => maybeOpen(view));
})();
