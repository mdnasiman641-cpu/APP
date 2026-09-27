(() => {
  const { settings: Settings, schedule: Schedule } = globalThis.FBRA;
  const $ = (id) => document.getElementById(id);
  const SIMPLE_FIELDS = [
    'aiConcurrency',
    'businessName',
    'location',
    'phone1',
    'phone2',
    'language',
    'customPrompt',
    'scheduleEnabled',
    'scheduleDate',
    'scheduleStartTime',
    'scheduleIntervalMinutes'
  ];

  // Working copy of the provider config; the form is rendered from this.
  let order = [...Settings.PROVIDER_IDS];
  let providers = {};
  let discovered = {}; // provider -> [{id, label, confirmed}]

  const DEFAULT_ENDPOINTS = {
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    openrouter: 'https://openrouter.ai/api/v1',
    openai: 'https://api.openai.com/v1'
  };

  /**
   * A custom endpoint is an arbitrary host, so the extension has to be granted access to it.
   * Asking here is fine: the click that saved the form is the required user gesture.
   * @returns {Promise<string[]>} the base URLs that were refused
   */
  async function ensureEndpointPermissions(providerConfigs) {
    const refused = [];
    for (const [id, cfg] of Object.entries(providerConfigs)) {
      const base = Settings.normalizeBaseUrl(cfg.baseUrl);
      if (!base) continue;
      const origins = [`${new URL(base).origin}/*`];
      try {
        if (await chrome.permissions.contains({ origins })) continue;
        if (!(await chrome.permissions.request({ origins }))) refused.push(`${Settings.PROVIDER_LABELS[id]} (${base})`);
      } catch {
        refused.push(`${Settings.PROVIDER_LABELS[id]} (${base})`);
      }
    }
    return refused;
  }

  function setStatus(text, isError = false) {
    $('status').textContent = text;
    $('status').className = isError ? 'error' : '';
  }

  async function send(type, payload = {}) {
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    if (!res?.ok) throw new Error(res?.error?.message || 'No response from the extension background');
    return res.data;
  }

  // ---------- provider rendering ----------

  function move(list, index, delta) {
    const to = index + delta;
    if (to < 0 || to >= list.length) return;
    [list[index], list[to]] = [list[to], list[index]];
  }

  function renderModels(provider, host) {
    const template = $('modelTemplate');
    host.replaceChildren();
    if (!provider.models.length) {
      const empty = document.createElement('li');
      empty.className = 'hint';
      empty.textContent = 'No models yet — add one below.';
      host.append(empty);
      return;
    }
    provider.models.forEach((model, index) => {
      const li = template.content.firstElementChild.cloneNode(true);
      const ref = (name) => li.querySelector(`[data-ref="${name}"]`);
      ref('enabled').checked = model.enabled;
      ref('enabled').addEventListener('change', (e) => {
        model.enabled = e.target.checked;
        renderPool();
      });
      ref('id').textContent = model.id;
      li.querySelector('[data-act="up"]').addEventListener('click', () => {
        move(provider.models, index, -1);
        renderProviders();
      });
      li.querySelector('[data-act="down"]').addEventListener('click', () => {
        move(provider.models, index, 1);
        renderProviders();
      });
      li.querySelector('[data-act="remove"]').addEventListener('click', () => {
        provider.models.splice(index, 1);
        renderProviders();
      });
      host.append(li);
    });
  }

  function addModel(providerId, id) {
    const provider = providers[providerId];
    const value = String(id || '').trim();
    if (!value) return setStatus('Type or pick a model ID first.', true);
    if (provider.models.some((m) => m.id === value)) return setStatus(`${value} is already in the list.`, true);
    if (provider.models.length >= Settings.MAX_MODELS_PER_PROVIDER) {
      return setStatus(`At most ${Settings.MAX_MODELS_PER_PROVIDER} models per provider.`, true);
    }
    provider.models.push({ id: value, enabled: true, priority: 0 });
    setStatus(`Added ${value}. Remember to save.`);
    renderProviders();
  }

  async function loadModels(providerId, keyInput) {
    setStatus(`Loading ${Settings.PROVIDER_LABELS[providerId]} models…`);
    try {
      const baseUrl = Settings.normalizeBaseUrl(providers[providerId].baseUrl);
      // A custom host needs permission before it can be called at all.
      const refused = await ensureEndpointPermissions({ [providerId]: { baseUrl } });
      if (refused.length) {
        setStatus(`Access was not granted for ${refused.join(', ')}, so its models cannot be loaded.`, true);
        return;
      }
      const { models } = await send('REFRESH_MODELS', { provider: providerId, apiKey: keyInput.value.trim(), baseUrl });
      discovered[providerId] = models;
      renderProviders();
      const unconfirmed = models.some((m) => !m.confirmed);
      setStatus(
        `${models.length} model(s) available for ${Settings.PROVIDER_LABELS[providerId]}${
          unconfirmed ? ' (this provider does not confirm chat support; a model that refuses is skipped automatically)' : ''
        }.`
      );
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  function renderProviders() {
    const template = $('providerTemplate');
    const host = $('providers');
    host.replaceChildren();

    order.forEach((providerId, providerIndex) => {
      const provider = providers[providerId];
      const node = template.content.firstElementChild.cloneNode(true);
      const ref = (name) => node.querySelector(`[data-ref="${name}"]`);
      node.dataset.provider = providerId;

      ref('label').textContent = Settings.PROVIDER_LABELS[providerId];
      const status = Settings.providerStatus(provider);
      const badge = ref('badge');
      badge.textContent = status;
      badge.className = `badge ${status === 'Configured' ? 'ok' : status === 'Disabled' ? '' : 'warn'}`;

      ref('enabled').checked = provider.enabled;
      ref('enabled').addEventListener('change', (e) => {
        provider.enabled = e.target.checked;
        renderProviders();
      });

      const keyInput = ref('key');
      keyInput.value = provider.apiKey;
      keyInput.addEventListener('input', (e) => {
        provider.apiKey = e.target.value;
        badge.textContent = Settings.providerStatus(provider);
      });

      const baseUrlInput = ref('baseUrl');
      const baseUrlHint = ref('baseUrlHint');
      baseUrlInput.value = provider.baseUrl || '';
      const describeBaseUrl = () => {
        const cleaned = Settings.normalizeBaseUrl(baseUrlInput.value);
        if (!baseUrlInput.value.trim()) baseUrlHint.textContent = `Default: ${DEFAULT_ENDPOINTS[providerId]}`;
        else if (!cleaned) baseUrlHint.textContent = '⚠ Not a valid http(s) URL — the default endpoint will be used.';
        else baseUrlHint.textContent = `Will call ${cleaned}${providerId === 'gemini' ? '/models/…:generateContent' : '/chat/completions'}`;
      };
      baseUrlInput.addEventListener('input', (e) => {
        provider.baseUrl = e.target.value;
        describeBaseUrl();
        renderPool();
      });
      describeBaseUrl();

      node.querySelector('[data-act="toggleKey"]').addEventListener('click', (e) => {
        keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
        e.target.textContent = keyInput.type === 'password' ? 'Show' : 'Hide';
      });
      node.querySelector('[data-act="up"]').addEventListener('click', () => {
        move(order, providerIndex, -1);
        renderProviders();
      });
      node.querySelector('[data-act="down"]').addEventListener('click', () => {
        move(order, providerIndex, 1);
        renderProviders();
      });

      renderModels(provider, ref('modelList'));

      const input = ref('modelInput');
      const picker = ref('modelPicker');
      const list = discovered[providerId] || [];
      if (list.length) {
        picker.hidden = false;
        picker.replaceChildren(new Option('— pick a discovered model —', ''));
        for (const m of list) picker.add(new Option(`${m.label}${m.confirmed ? '' : ' (unconfirmed)'}`, m.id));
        picker.addEventListener('change', () => {
          if (picker.value) addModel(providerId, picker.value);
        });
        ref('modelHint').textContent = `${list.length} discovered`;
      } else {
        ref('modelHint').textContent = providerId === 'gemini' ? 'discovery confirms generateContent support' : '';
      }

      node.querySelector('[data-act="addModel"]').addEventListener('click', () => addModel(providerId, input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addModel(providerId, input.value);
        }
      });
      node.querySelector('[data-act="loadModels"]').addEventListener('click', () => loadModels(providerId, keyInput));

      host.append(node);
    });
    renderPool();
  }

  /** The order generation will actually try, mirroring the manager's pool. */
  function renderPool() {
    const host = $('pool');
    host.replaceChildren();
    const entries = [];
    for (const providerId of order) {
      const provider = providers[providerId];
      if (!provider.enabled || !provider.apiKey) continue;
      const custom = Settings.normalizeBaseUrl(provider.baseUrl) ? ' (custom endpoint)' : '';
      for (const model of provider.models) if (model.enabled && model.id) entries.push(`${providerId} / ${model.id}${custom}`);
    }
    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = 'Nothing usable yet: enable a provider, paste its key and add at least one model.';
      host.append(li);
      return;
    }
    for (const entry of entries) {
      const li = document.createElement('li');
      li.textContent = entry;
      host.append(li);
    }
  }

  // ---------- form ----------

  function readForm() {
    const out = { aiProviders: {}, providerOrder: [...order] };
    for (const key of SIMPLE_FIELDS) {
      const el = $(key);
      out[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    }
    for (const providerId of order) {
      const provider = providers[providerId];
      out.aiProviders[providerId] = {
        enabled: provider.enabled,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl || '',
        models: provider.models.map((m, i) => ({ id: m.id, enabled: m.enabled, priority: i + 1 }))
      };
    }
    return out;
  }

  function updatePreview() {
    const v = readForm();
    const el = $('schedulePreview');
    if (!v.scheduleEnabled) {
      el.textContent = 'Scheduling is off.';
      return;
    }
    const plan = Schedule.buildSchedule({ date: v.scheduleDate, startTime: v.scheduleStartTime, intervalMinutes: v.scheduleIntervalMinutes, count: 3 });
    el.textContent = plan.ok
      ? `Example for 3 reels: ${plan.slots.map((s) => `${s.dateISO} ${s.time24}`).join(' · ')}`
      : `⚠ ${plan.error}`;
  }

  async function load() {
    for (const lang of Settings.LANGUAGES) $('language').add(new Option(lang, lang));
    const s = await Settings.loadSettings();
    for (const key of SIMPLE_FIELDS) {
      const el = $(key);
      if (el.type === 'checkbox') el.checked = s[key];
      else el.value = s[key];
    }
    order = [...s.providerOrder];
    providers = {};
    for (const id of order) providers[id] = { ...s.aiProviders[id], models: s.aiProviders[id].models.map((m) => ({ ...m })) };
    try {
      const { cache } = await send('GET_MODELS');
      for (const [id, entry] of Object.entries(cache || {})) discovered[id] = entry.models || [];
    } catch {
      /* discovery cache is optional */
    }
    renderProviders();
    updatePreview();
  }

  async function save() {
    const v = readForm();
    const usable = Object.entries(v.aiProviders).some(([, p]) => p.enabled && p.apiKey && p.models.some((m) => m.enabled));
    if (!usable) {
      setStatus('Not saved: at least one enabled provider needs an API key and one enabled model.', true);
      return false;
    }
    if (v.scheduleEnabled) {
      const plan = Schedule.buildSchedule({ date: v.scheduleDate, startTime: v.scheduleStartTime, intervalMinutes: v.scheduleIntervalMinutes, count: 1 });
      if (!plan.ok) {
        setStatus(`Not saved: ${plan.error}`, true);
        return false;
      }
    }
    await Settings.saveSettings(v);
    const refused = await ensureEndpointPermissions(v.aiProviders);
    setStatus(
      refused.length
        ? `Saved, but access was not granted for: ${refused.join(', ')}. Those custom endpoints cannot be called until you allow them.`
        : 'Saved.',
      refused.length > 0
    );
    renderProviders();
    return true;
  }

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    save().catch((err) => setStatus(err.message, true));
  });

  $('resetPrompt').addEventListener('click', () => {
    $('customPrompt').value = Settings.DEFAULT_PROMPT;
  });

  $('testGenerate').addEventListener('click', async () => {
    const pre = $('sample');
    try {
      if (!(await save())) return;
      setStatus('Generating a sample…');
      const res = await send('TEST_GENERATION', {});
      pre.hidden = false;
      pre.textContent = res.text;
      setStatus(`Sample generated using ${res.provider} / ${res.model} (attempt ${res.attempts}).`);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  for (const id of ['scheduleEnabled', 'scheduleDate', 'scheduleStartTime', 'scheduleIntervalMinutes']) {
    $(id).addEventListener('input', updatePreview);
  }

  load().catch((err) => setStatus(err.message, true));
})();
