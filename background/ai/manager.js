/*
 * AI provider manager: builds one ordered provider/model pool from the settings and
 * walks it until a model answers.
 *
 *   pool = enabled providers (with a key) × their enabled models, ordered by priority
 *   each entry is tried AT MOST ONCE per generation request  → no infinite retrying
 *   a failure is classified; only categories with a real chance elsewhere fail over
 *   a temporary failure puts that model (or, for auth, that provider) into cooldown
 *
 * The content script never learns any of this: it asks for a description and gets
 * { text, provider, model } back, or one error.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { CATEGORY, classify, shouldFailover, isProviderLevel } = NS.aiClassify;
  const Health = NS.aiHealth;

  const PROVIDERS = {
    gemini: NS.aiProviderGemini,
    openrouter: NS.aiProviderOpenRouter,
    openai: NS.aiProviderOpenAI
  };

  // If every candidate is cooling down but one frees up very soon, wait rather than fail.
  const MAX_WAIT_FOR_COOLDOWN_MS = 10000;

  class GenerationFailedError extends Error {
    constructor(attempts, poolSize) {
      const summary = attempts.map((a) => `${a.provider}/${a.model}: ${a.category}`).join('; ');
      super(
        poolSize === 0
          ? 'No AI provider is configured. Open Settings, enable a provider, add its API key and at least one model.'
          : `GENERATION_FAILED — all ${poolSize} provider/model combination(s) failed. ${summary}`
      );
      this.name = 'GenerationFailedError';
      this.code = 'GENERATION_FAILED';
      this.attempts = attempts;
      this.permanent = poolSize === 0;
    }
  }

  /** @returns {Array<{provider: string, model: string, apiKey: string, priority: number}>} */
  function buildPool(settings) {
    const pool = [];
    for (const providerId of settings.providerOrder) {
      const provider = settings.aiProviders[providerId];
      if (!provider?.enabled || !provider.apiKey || !PROVIDERS[providerId]) continue;
      for (const model of provider.models) {
        if (!model.enabled || !model.id) continue;
        pool.push({
          provider: providerId,
          model: model.id,
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl || '', // empty = that provider's default endpoint
          priority: model.priority
        });
      }
    }
    pool.sort((a, b) => a.priority - b.priority);
    return pool;
  }

  /** The pool without entries in cooldown, plus how long until the soonest one frees up. */
  function splitByHealth(pool) {
    const usable = [];
    let soonest = Infinity;
    for (const entry of pool) {
      const cooling = Health.cooldownOf(entry.provider, entry.model);
      if (!cooling) usable.push(entry);
      else soonest = Math.min(soonest, cooling.until);
    }
    return { usable, waitMs: soonest === Infinity ? 0 : Math.max(0, soonest - Date.now()) };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Generate one description with automatic failover.
   * @param {object} settings full settings (keys stay in this context)
   * @param {{filename: string, index: number, total: number}} reel
   * @param {{onEvent?: Function, deps?: object, sleepImpl?: Function}} opts
   * @returns {Promise<{text: string, provider: string, model: string, attempts: number}>}
   */
  async function generateDescription(settings, reel, { onEvent = () => {}, deps = {}, sleepImpl = sleep } = {}) {
    const pool = buildPool(settings);
    const systemPrompt = settings.customPrompt;
    const userPrompt = NS.aiPrompt.buildUserPrompt(settings, reel);
    const attempts = [];
    const skippedProviders = new Set(); // auth failed during THIS request

    onEvent({ type: 'pool', size: pool.length });
    if (!pool.length) throw new GenerationFailedError(attempts, 0);

    let { usable, waitMs } = splitByHealth(pool);
    if (!usable.length && waitMs > 0 && waitMs <= MAX_WAIT_FOR_COOLDOWN_MS) {
      onEvent({ type: 'waiting', ms: waitMs });
      await sleepImpl(waitMs);
      ({ usable } = splitByHealth(pool));
    }
    // Everything is cooling down for a while: say so instead of hammering the same models.
    if (!usable.length) {
      const err = new GenerationFailedError(
        pool.map((e) => ({ provider: e.provider, model: e.model, category: 'COOLDOWN' })),
        pool.length
      );
      err.message = `GENERATION_FAILED — every model is rate-limited or cooling down. Next one free in ${Math.ceil(waitMs / 1000)} s.`;
      throw err;
    }

    for (let i = 0; i < usable.length; i++) {
      const entry = usable[i];
      if (skippedProviders.has(entry.provider)) continue;
      const provider = PROVIDERS[entry.provider];

      onEvent({ type: 'attempt', provider: entry.provider, model: entry.model, index: attempts.length + 1, of: usable.length });
      try {
        const text = await provider.generate({
          apiKey: entry.apiKey,
          baseUrl: entry.baseUrl,
          modelId: entry.model,
          systemPrompt,
          userPrompt,
          deps
        });
        Health.noteSuccess(entry.provider, entry.model);
        onEvent({ type: 'success', provider: entry.provider, model: entry.model });
        return { text, provider: entry.provider, model: entry.model, attempts: attempts.length + 1 };
      } catch (err) {
        const category = classify(err);
        const cooldown = Health.noteFailure(entry.provider, entry.model, category, err.retryAfterMs || 0);
        attempts.push({ provider: entry.provider, model: entry.model, category, message: err.message });
        onEvent({
          type: 'failure',
          provider: entry.provider,
          model: entry.model,
          category,
          status: err.status || 0,
          cooldownMs: cooldown.ms,
          scope: cooldown.scope,
          message: err.message
        });

        if (isProviderLevel(category)) skippedProviders.add(entry.provider);
        if (!shouldFailover(category)) {
          // The request itself is the problem — another model would reject it too.
          const fatal = new Error(`${category}: ${err.message}`);
          fatal.code = category;
          fatal.permanent = true;
          fatal.provider = entry.provider;
          fatal.model = entry.model;
          throw fatal;
        }
        const next = usable.slice(i + 1).find((e) => !skippedProviders.has(e.provider));
        if (next) onEvent({ type: 'switching', provider: next.provider, model: next.model, fromProvider: entry.provider });
      }
    }
    throw new GenerationFailedError(attempts, usable.length);
  }

  async function listModels(providerId, apiKey, deps = {}, baseUrl = '') {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider "${providerId}"`);
    if (!apiKey) throw Object.assign(new Error(`No API key set for ${provider.label}.`), { permanent: true });
    return provider.listModels({ apiKey, baseUrl, deps });
  }

  /** Pool as the options page may see it: no keys, with health state. */
  function describePool(settings) {
    return buildPool(settings).map((entry, i) => {
      const cooling = Health.cooldownOf(entry.provider, entry.model);
      return {
        order: i + 1,
        provider: entry.provider,
        model: entry.model,
        endpoint: entry.baseUrl ? 'custom' : 'default',
        state: cooling ? `cooldown (${cooling.category}, ${Math.ceil((cooling.until - Date.now()) / 1000)}s)` : 'available'
      };
    });
  }

  NS.aiManager = { buildPool, generateDescription, listModels, describePool, GenerationFailedError, PROVIDERS, CATEGORY };
})();
