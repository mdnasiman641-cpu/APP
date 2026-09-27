/*
 * In-memory model/provider health. A temporary failure puts one model (or, for an
 * auth failure, one provider) into cooldown so the pool stops hammering it — never a
 * permanent disable. Cleared whenever settings change, so fixing a key takes effect at once.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { CATEGORY } = NS.aiClassify;

  // Used only when the provider gives no Retry-After / RetryInfo of its own.
  const DEFAULT_COOLDOWN_MS = {
    [CATEGORY.RATE_LIMIT]: 60000,
    [CATEGORY.QUOTA_EXCEEDED]: 60000,
    [CATEGORY.SERVER_ERROR]: 30000,
    [CATEGORY.MODEL_UNAVAILABLE]: 30000,
    [CATEGORY.NETWORK_ERROR]: 15000,
    [CATEGORY.AUTH_ERROR]: 300000, // the key is wrong: stop using it for a while
    [CATEGORY.UNKNOWN]: 15000
  };
  const MAX_COOLDOWN_MS = 15 * 60000;

  const models = new Map(); // "provider/model" -> { until, category }
  const providers = new Map(); // "provider"      -> { until, category }
  const now = () => Date.now();

  const modelKey = (providerId, modelId) => `${providerId}/${modelId}`;

  function readEntry(map, key) {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.until <= now()) {
      map.delete(key); // cooldown expired: available again
      return null;
    }
    return entry;
  }

  /**
   * Record a failure. `retryAfterMs` from the provider always wins over the default.
   * @returns {{scope: 'model'|'provider', until: number, ms: number}}
   */
  function noteFailure(providerId, modelId, category, retryAfterMs = 0) {
    const base = DEFAULT_COOLDOWN_MS[category] ?? DEFAULT_COOLDOWN_MS[CATEGORY.UNKNOWN];
    const ms = Math.min(retryAfterMs > 0 ? retryAfterMs : base, MAX_COOLDOWN_MS);
    const until = now() + ms;
    if (NS.aiClassify.isProviderLevel(category)) {
      providers.set(providerId, { until, category });
      return { scope: 'provider', until, ms };
    }
    models.set(modelKey(providerId, modelId), { until, category });
    return { scope: 'model', until, ms };
  }

  function noteSuccess(providerId, modelId) {
    models.delete(modelKey(providerId, modelId));
    providers.delete(providerId);
  }

  /** null when usable, otherwise why and until when. */
  function cooldownOf(providerId, modelId) {
    const p = readEntry(providers, providerId);
    if (p) return { scope: 'provider', ...p };
    const m = readEntry(models, modelKey(providerId, modelId));
    return m ? { scope: 'model', ...m } : null;
  }

  const isAvailable = (providerId, modelId) => cooldownOf(providerId, modelId) === null;

  function reset() {
    models.clear();
    providers.clear();
  }

  /** For the options page: a safe, key-free view of what is cooling down. */
  function snapshot() {
    const out = { models: {}, providers: {} };
    for (const [key] of models) {
      const entry = readEntry(models, key);
      if (entry) out.models[key] = { until: entry.until, category: entry.category };
    }
    for (const [key] of providers) {
      const entry = readEntry(providers, key);
      if (entry) out.providers[key] = { until: entry.until, category: entry.category };
    }
    return out;
  }

  NS.aiHealth = { noteFailure, noteSuccess, cooldownOf, isAvailable, reset, snapshot, DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS };
})();
