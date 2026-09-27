/*
 * Settings schema, defaults, migration and storage access.
 * Loaded by the service worker (importScripts) and the options page.
 * Content scripts never load this file: they cannot read chrome.storage.local
 * (access level is restricted to trusted contexts) and receive public
 * settings from the service worker instead. API keys never leave this context.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});

  const DEFAULT_PROMPT =
    'You are a professional Facebook Reel caption writer. Write engaging and natural descriptions for my mobile phone shop. ' +
    'Use Bangla unless another language is selected. Keep the description useful and concise. Use relevant emojis when appropriate. ' +
    'Use the provided business information. Do not invent product specifications, prices, offers, or features. Do not make false claims. ' +
    'Use relevant hashtags but do not overuse hashtags. Return only the final Facebook description.';

  const PROVIDER_IDS = ['gemini', 'openrouter', 'openai'];
  const PROVIDER_LABELS = { gemini: 'Gemini API (Old)', openrouter: 'OpenRouter API', openai: 'OpenAI API' };
  const MAX_CONCURRENCY = 5;
  const MAX_MODELS_PER_PROVIDER = 10;

  const emptyProvider = () => ({ enabled: false, apiKey: '', baseUrl: '', models: [] });

  /**
   * Normalise an optional custom API base URL. Empty means "use the provider's default".
   * Accepts only http(s), drops trailing slashes, and forgives a pasted full endpoint
   * (".../chat/completions") so the base is what the provider code expects.
   * @returns {string} the cleaned base URL, or '' when unusable
   */
  function normalizeBaseUrl(value) {
    const raw = str(value);
    if (!raw) return '';
    let url;
    try {
      url = new URL(raw);
    } catch {
      return '';
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    let path = url.pathname.replace(/\/+$/, '');
    path = path.replace(/\/(chat\/completions|completions|responses)$/i, '');
    return `${url.origin}${path}`;
  }

  const DEFAULT_SETTINGS = Object.freeze({
    aiProviders: {
      gemini: { enabled: true, apiKey: '', baseUrl: '', models: [] },
      openrouter: emptyProvider(),
      openai: emptyProvider()
    },
    providerOrder: [...PROVIDER_IDS],
    aiConcurrency: 3,
    businessName: 'খাদিজা টেলিকম',
    location: 'আমরাইদ বাজার, কাপাসিয়া, গাজীপুর',
    phone1: '01637676742',
    phone2: '01619872090',
    language: 'Bangla',
    customPrompt: DEFAULT_PROMPT,
    scheduleEnabled: false,
    scheduleDate: '',
    scheduleStartTime: '18:00',
    scheduleIntervalMinutes: 30
  });

  const LANGUAGES = ['Bangla', 'English', 'Bangla and English mixed', 'Hindi', 'Arabic'];
  const CONTENT_WRITABLE_KEYS = ['scheduleEnabled', 'scheduleDate', 'scheduleStartTime', 'scheduleIntervalMinutes'];
  const SETTINGS_KEY = 'settings';
  const MODEL_CACHE_KEY = 'modelCache';

  const str = (v) => (typeof v === 'string' ? v.trim() : '');

  function sanitizeModels(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const m of raw) {
      const id = typeof m === 'string' ? m.trim() : str(m?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, enabled: m?.enabled === undefined ? true : Boolean(m.enabled), priority: Number(m?.priority) || 0 });
      if (out.length >= MAX_MODELS_PER_PROVIDER) break;
    }
    // Explicit priorities win; otherwise array order decides.
    out.sort((a, b) => (a.priority || Number.MAX_SAFE_INTEGER) - (b.priority || Number.MAX_SAFE_INTEGER));
    return out;
  }

  function sanitizeProviders(raw, order) {
    const out = {};
    order.forEach((id, providerIndex) => {
      const p = raw?.[id] || {};
      const models = sanitizeModels(p.models);
      // Global priority: provider position first, then model position inside that provider.
      models.forEach((m, i) => {
        m.priority = (providerIndex + 1) * 100 + (i + 1);
      });
      out[id] = { enabled: Boolean(p.enabled), apiKey: str(p.apiKey), baseUrl: normalizeBaseUrl(p.baseUrl), models };
    });
    return out;
  }

  function sanitizeOrder(raw) {
    const order = Array.isArray(raw) ? raw.filter((id) => PROVIDER_IDS.includes(id)) : [];
    return [...new Set([...order, ...PROVIDER_IDS])];
  }

  /**
   * Bring forward the old single-provider Gemini settings (`apiKey`, `model`,
   * `geminiConcurrency`) so nobody has to re-enter their key.
   * @returns {{migrated: boolean, settings: object}}
   */
  function migrate(raw) {
    if (!raw || typeof raw !== 'object') return { migrated: false, settings: raw };
    const next = { ...raw };
    let migrated = false;

    if (raw.apiKey || raw.model) {
      const providers = { ...(next.aiProviders || {}) };
      const gemini = { ...(providers.gemini || {}) };
      if (!str(gemini.apiKey) && str(raw.apiKey)) gemini.apiKey = str(raw.apiKey);
      const existing = sanitizeModels(gemini.models);
      if (str(raw.model) && !existing.some((m) => m.id === str(raw.model))) existing.unshift({ id: str(raw.model), enabled: true, priority: 0 });
      gemini.models = existing;
      if (gemini.enabled === undefined) gemini.enabled = Boolean(str(raw.apiKey));
      providers.gemini = gemini;
      next.aiProviders = providers;
      delete next.apiKey;
      delete next.model;
      migrated = true;
    }
    if (raw.geminiConcurrency !== undefined) {
      if (next.aiConcurrency === undefined) next.aiConcurrency = raw.geminiConcurrency;
      delete next.geminiConcurrency;
      migrated = true;
    }
    return { migrated, settings: next };
  }

  function sanitize(input) {
    const raw = migrate(input).settings;
    const out = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (['aiProviders', 'providerOrder'].includes(key)) continue;
      if (!raw || !(key in raw)) continue;
      const def = DEFAULT_SETTINGS[key];
      const val = raw[key];
      if (typeof def === 'boolean') out[key] = Boolean(val);
      else if (typeof def === 'number') {
        const n = Number(val);
        out[key] = Number.isFinite(n) ? n : def;
      } else out[key] = typeof val === 'string' ? val.trim() : def;
    }
    if (!out.customPrompt) out.customPrompt = DEFAULT_PROMPT;
    out.aiConcurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(out.aiConcurrency) || 1));
    out.providerOrder = sanitizeOrder(raw?.providerOrder);
    out.aiProviders = sanitizeProviders(raw?.aiProviders, out.providerOrder);
    return out;
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    return sanitize(data[SETTINGS_KEY]);
  }

  /** Rewrites the stored settings if they still use the old single-Gemini shape. */
  async function migrateStoredSettings() {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const { migrated } = migrate(data[SETTINGS_KEY]);
    if (!migrated) return false;
    await chrome.storage.local.set({ [SETTINGS_KEY]: sanitize(data[SETTINGS_KEY]) });
    return true;
  }

  async function saveSettings(partial) {
    const current = await loadSettings();
    const next = sanitize({ ...current, ...partial });
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  /** What a provider's key status may be shown as. Never the key itself. */
  function providerStatus(provider) {
    if (!provider.enabled) return 'Disabled';
    if (!provider.apiKey) return 'Not configured';
    if (!provider.models.some((m) => m.enabled)) return 'No models';
    return 'Configured';
  }

  /** The content-script view: no keys, ever. */
  function toPublic(settings) {
    const out = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key === 'aiProviders') continue;
      out[key] = settings[key];
    }
    out.providers = settings.providerOrder.map((id) => ({
      id,
      label: PROVIDER_LABELS[id],
      enabled: settings.aiProviders[id].enabled,
      status: providerStatus(settings.aiProviders[id]),
      customEndpoint: Boolean(settings.aiProviders[id].baseUrl),
      models: settings.aiProviders[id].models.filter((m) => m.enabled).map((m) => m.id)
    }));
    out.hasApiKey = out.providers.some((p) => p.enabled && p.status === 'Configured');
    return out;
  }

  NS.settings = {
    DEFAULT_PROMPT,
    normalizeBaseUrl,
    DEFAULT_SETTINGS,
    PROVIDER_IDS,
    PROVIDER_LABELS,
    MAX_CONCURRENCY,
    MAX_MODELS_PER_PROVIDER,
    LANGUAGES,
    CONTENT_WRITABLE_KEYS,
    MODEL_CACHE_KEY,
    SETTINGS_KEY,
    sanitize,
    migrate,
    migrateStoredSettings,
    loadSettings,
    saveSettings,
    providerStatus,
    toPublic
  };
})();
