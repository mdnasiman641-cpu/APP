/*
 * Service worker: custody of every API key and the only place that talks to an AI provider.
 * Content scripts receive public settings, generated text and provider/model names — never a key.
 */
importScripts(
  '../shared/settings.js',
  'ai/classify.js',
  'ai/http.js',
  'ai/health.js',
  'ai/prompt.js',
  'ai/providers/gemini.js',
  'ai/providers/chat.js',
  'ai/providers/openrouter.js',
  'ai/providers/openai.js',
  'ai/manager.js',
  'keyboard.js'
);

const { settings: Settings, aiManager: Manager, aiHealth: Health, aiHttp: Http, keyboard: Keyboard } = globalThis.FBRA;

// Content scripts must not be able to read chrome.storage.local (it holds the API keys).
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

const log = (tag, msg) => console.info(`[FBRA][${tag}] ${Http.scrub(msg)}`);

// Changing settings clears health state, so a corrected key or model works immediately.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[Settings.SETTINGS_KEY]) Health.reset();
});

/*
 * Generation concurrency, enforced across every tab: at most `limit` requests in flight.
 * Each request runs its own failover independently; a slow or failing one never restarts
 * the others.
 */
const gen = { active: 0, queue: [], limit: 3 };

function pump() {
  while (gen.queue.length && gen.active < gen.limit) {
    const job = gen.queue.shift();
    gen.active++;
    job.run().then(job.resolve, job.reject).finally(() => {
      gen.active--;
      pump();
    });
  }
}

function enqueue(run, limit) {
  if (Number.isInteger(limit) && limit >= 1) gen.limit = limit;
  return new Promise((resolve, reject) => {
    gen.queue.push({ run, resolve, reject });
    pump();
  });
}

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

function serializeError(err) {
  return {
    message: Http.scrub(err?.message || String(err)),
    status: err?.status || 0,
    code: err?.code || '',
    permanent: Boolean(err?.permanent)
  };
}

/** Live AI status for the panel. Provider and model names only — never a key. */
function notifyTab(tabId, status) {
  if (tabId === undefined) return;
  chrome.tabs.sendMessage(tabId, { type: 'AI_STATUS', status }).catch(() => {});
}

function aiEventLogger(rowLabel, tabId) {
  return (event) => {
    switch (event.type) {
      case 'pool':
        log('AI', `request ${rowLabel} pool=${event.size} model(s)`);
        break;
      case 'waiting':
        log('AI', `all models cooling down, waiting ${Math.ceil(event.ms / 1000)}s`);
        notifyTab(tabId, { state: 'waiting', text: 'Waiting for a model to free up…' });
        break;
      case 'attempt': {
        log('AI', `selected provider=${event.provider} model=${event.model} (${event.index}/${event.of})`);
        log('AI', 'request started');
        // A later attempt is a fallback: say so for as long as it runs, not for an instant.
        const fallback = event.index > 1;
        notifyTab(tabId, {
          state: fallback ? 'switching' : 'attempt',
          provider: event.provider,
          model: event.model,
          text: `${fallback ? 'Fallback: ' : ''}${event.provider} → ${event.model}`
        });
        break;
      }
      case 'failure':
        log('AI', `response status=${event.status || 'network'}`);
        log('AI', `failure category=${event.category} — ${event.message}`);
        log('AI', `${event.scope} cooldown started for ${Math.ceil(event.cooldownMs / 1000)}s`);
        break;
      case 'switching':
        log('AI', `switching provider=${event.provider} model=${event.model}`);
        notifyTab(tabId, {
          state: 'switching',
          text: event.provider === event.fromProvider ? 'Switching model…' : 'Switching provider…'
        });
        break;
      case 'success':
        log('AI', 'response success');
        log('AI', `generation completed provider=${event.provider} model=${event.model}`);
        notifyTab(tabId, { state: 'success', provider: event.provider, model: event.model, text: `✓ ${event.provider} → ${event.model}` });
        break;
      default:
        break;
    }
  };
}

/**
 * A custom Base URL points at a host outside the manifest, so Chrome must have been
 * granted access to it (the options page asks when the setting is saved).
 */
async function assertEndpointAllowed(providerId, baseUrl) {
  if (!baseUrl) return;
  const origins = [`${new URL(baseUrl).origin}/*`];
  const allowed = await chrome.permissions.contains({ origins }).catch(() => false);
  if (allowed) return;
  throw Object.assign(
    new Error(
      `The custom Base URL for ${Settings.PROVIDER_LABELS[providerId] || providerId} (${baseUrl}) has not been allowed. ` +
        'Open Settings and press Save settings, then accept the permission prompt.'
    ),
    { permanent: true }
  );
}

const handlers = {
  async GET_PUBLIC_SETTINGS() {
    return Settings.toPublic(await Settings.loadSettings());
  },

  async SAVE_SCHEDULE_SETTINGS(msg) {
    const partial = {};
    for (const key of Settings.CONTENT_WRITABLE_KEYS) if (key in (msg.values || {})) partial[key] = msg.values[key];
    return Settings.toPublic(await Settings.saveSettings(partial));
  },

  /** Is anything usable configured? Checked once before a batch starts. */
  async CHECK_GENERATION_READY() {
    const settings = await Settings.loadSettings();
    const pool = Manager.buildPool(settings);
    for (const entry of pool) await assertEndpointAllowed(entry.provider, entry.baseUrl);
    if (!pool.length) {
      throw Object.assign(
        new Error('No AI provider is configured. Open Settings, enable a provider, add its API key and at least one model.'),
        { permanent: true }
      );
    }
    return { pool: pool.length, first: { provider: pool[0].provider, model: pool[0].model } };
  },

  async GENERATE_DESCRIPTION(msg, sender) {
    const settings = await Settings.loadSettings();
    const rowLabel = `row=${(msg.reel?.index ?? 0) + 1}`;
    return enqueue(async () => {
      try {
        const result = await Manager.generateDescription(settings, msg.reel, { onEvent: aiEventLogger(rowLabel, sender.tab?.id) });
        return { success: true, text: result.text, provider: result.provider, model: result.model, attempts: result.attempts };
      } catch (err) {
        if (err?.code === 'GENERATION_FAILED') log('AI', '[ERROR] all provider/model combinations failed');
        throw err;
      }
    }, settings.aiConcurrency);
  },

  /** Cached model lists per provider, for the options page. */
  async GET_MODELS() {
    const [cache, settings] = await Promise.all([chrome.storage.local.get(Settings.MODEL_CACHE_KEY), Settings.loadSettings()]);
    return {
      cache: cache[Settings.MODEL_CACHE_KEY] || {},
      providers: Settings.toPublic(settings).providers,
      pool: Manager.describePool(settings)
    };
  },

  async REFRESH_MODELS(msg, sender) {
    const providerId = msg.provider;
    const settings = await Settings.loadSettings();
    // Only the extension's own pages may test a key that has not been saved yet.
    const apiKey = isExtensionPage(sender) && msg.apiKey ? msg.apiKey : settings.aiProviders[providerId]?.apiKey;
    const baseUrl = Settings.normalizeBaseUrl(isExtensionPage(sender) && msg.baseUrl ? msg.baseUrl : settings.aiProviders[providerId]?.baseUrl);
    await assertEndpointAllowed(providerId, baseUrl);
    const models = await Manager.listModels(providerId, apiKey, {}, baseUrl);
    const store = await chrome.storage.local.get(Settings.MODEL_CACHE_KEY);
    const cache = { ...(store[Settings.MODEL_CACHE_KEY] || {}), [providerId]: { models, fetchedAt: Date.now() } };
    await chrome.storage.local.set({ [Settings.MODEL_CACHE_KEY]: cache });
    log('AI', `models refreshed provider=${providerId} count=${models.length}`);
    return { models };
  },

  /** A one-off generation from the options page, to prove a provider works. */
  async TEST_GENERATION(msg, sender) {
    if (!isExtensionPage(sender)) throw new Error('Not allowed from this context.');
    const settings = await Settings.loadSettings();
    const result = await Manager.generateDescription(settings, msg.reel || { filename: 'sample-phone-video.mp4', index: 0, total: 1 }, {
      onEvent: aiEventLogger('test', undefined)
    });
    return { success: true, ...result };
  },

  async GET_AI_HEALTH() {
    const settings = await Settings.loadSettings();
    return { pool: Manager.describePool(settings), health: Health.snapshot() };
  },

  async OPEN_OPTIONS() {
    await chrome.runtime.openOptionsPage();
    return {};
  },

  /** Real (trusted) key presses for the scheduler — see keyboard.js for the safety rules. */
  async KEYBOARD_ATTACH(msg, sender) {
    await Keyboard.attach(facebookTabId(sender));
    return {};
  },

  async KEY_PRESS(msg, sender) {
    await Keyboard.press(facebookTabId(sender), msg.key);
    return { key: msg.key };
  },

  async KEY_TYPE(msg, sender) {
    await Keyboard.type(facebookTabId(sender), msg.text);
    return {};
  },

  async KEYBOARD_RELEASE(msg, sender) {
    await Keyboard.release(facebookTabId(sender));
    return {};
  }
};

/** Keyboard control only for the Facebook tab that asked for it. */
function facebookTabId(sender) {
  const url = sender.tab?.url || sender.url || '';
  if (sender.tab?.id == null || !/^https:\/\/(business|www)\.facebook\.com\//.test(url)) throw new Error('Keyboard control is only available on Facebook.');
  return sender.tab.id;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler || sender.id !== chrome.runtime.id) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      log('ERROR', `${msg.type}: ${serializeError(err).message}`);
      sendResponse({ ok: false, error: serializeError(err) });
    });
  return true; // async response
});

chrome.runtime.onInstalled.addListener(async () => {
  const migrated = await Settings.migrateStoredSettings().catch(() => false);
  log('INIT', `Installed / updated${migrated ? ' — existing Gemini key and model migrated to AI providers' : ''}`);
});
