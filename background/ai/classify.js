/*
 * Error classification. Decides — per failure — whether another model has a
 * reasonable chance of succeeding, so failover never fires for a bad prompt
 * and never gives up on a temporary limit.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});

  const CATEGORY = {
    RATE_LIMIT: 'RATE_LIMIT',
    QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
    AUTH_ERROR: 'AUTH_ERROR',
    MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
    SERVER_ERROR: 'SERVER_ERROR',
    NETWORK_ERROR: 'NETWORK_ERROR',
    BAD_REQUEST: 'BAD_REQUEST',
    UNKNOWN: 'UNKNOWN'
  };

  // Try the next provider/model for these; the request itself was fine.
  const FAILOVER = new Set([
    CATEGORY.RATE_LIMIT,
    CATEGORY.QUOTA_EXCEEDED,
    CATEGORY.MODEL_UNAVAILABLE,
    CATEGORY.SERVER_ERROR,
    CATEGORY.NETWORK_ERROR,
    CATEGORY.AUTH_ERROR, // a different provider may still work
    CATEGORY.UNKNOWN // unclear failures are treated as this model's problem, not the prompt's
  ]);

  const QUOTA_RE = /quota|resource[_ ]exhausted|billing|credit|insufficient[_ ]funds|hard limit|spend limit/i;
  const RATE_RE = /rate[ _-]?limit|too many requests|slow down/i;
  const MODEL_RE = /model|engine|deployment|not found|does not exist|unsupported|not supported|unavailable|overloaded|no endpoints|decommission|deprecat/i;
  const AUTH_RE = /api[ _-]?key|unauthori[sz]ed|forbidden|permission|invalid[_ ]authentication|token/i;

  /**
   * @param {{status?: number, body?: object, message?: string, network?: boolean, timeout?: boolean}} failure
   * @returns {string} one of CATEGORY
   */
  function classify(failure = {}) {
    if (failure.timeout) return CATEGORY.NETWORK_ERROR;
    if (failure.network) return CATEGORY.NETWORK_ERROR;

    const status = Number(failure.status) || 0;
    const detail = `${providerMessage(failure.body) || ''} ${failure.message || ''}`;
    const providerStatus = String(failure.body?.error?.status || '');

    if (status === 429 || /RESOURCE_EXHAUSTED/i.test(providerStatus)) {
      return QUOTA_RE.test(detail) && !RATE_RE.test(detail) ? CATEGORY.QUOTA_EXCEEDED : CATEGORY.RATE_LIMIT;
    }
    if (status === 401) return CATEGORY.AUTH_ERROR;
    if (status === 403) {
      // Gemini/OpenAI use 403 for both a bad key and an exhausted/blocked project.
      return QUOTA_RE.test(detail) ? CATEGORY.QUOTA_EXCEEDED : CATEGORY.AUTH_ERROR;
    }
    if (status === 402) return CATEGORY.QUOTA_EXCEEDED; // OpenRouter: out of credits
    if (status === 404) return CATEGORY.MODEL_UNAVAILABLE;
    if (status === 408) return CATEGORY.NETWORK_ERROR;
    if (status === 503 && /overload/i.test(detail)) return CATEGORY.MODEL_UNAVAILABLE;
    if (status >= 500) return CATEGORY.SERVER_ERROR;
    if (status === 400) {
      if (QUOTA_RE.test(detail)) return CATEGORY.QUOTA_EXCEEDED;
      // A 400 that blames the model/parameters is this model's problem: another may accept it.
      if (MODEL_RE.test(detail)) return CATEGORY.MODEL_UNAVAILABLE;
      if (AUTH_RE.test(detail)) return CATEGORY.AUTH_ERROR;
      return CATEGORY.BAD_REQUEST; // the prompt/body itself — every model would reject it
    }
    if (status && status < 500) return CATEGORY.BAD_REQUEST;
    return CATEGORY.UNKNOWN;
  }

  function providerMessage(body) {
    if (!body || typeof body !== 'object') return '';
    return String(body.error?.message || body.error?.code || body.message || body.detail || '');
  }

  const shouldFailover = (category) => FAILOVER.has(category);
  /** An auth failure is the provider's (key's) problem, not just this model's. */
  const isProviderLevel = (category) => category === CATEGORY.AUTH_ERROR;

  NS.aiClassify = { CATEGORY, classify, shouldFailover, isProviderLevel, providerMessage };
})();
