/*
 * Generic HTTP for AI providers: async fetch, one AbortController timeout per call,
 * no retries (failover replaces same-model retrying). Keys travel in headers only and
 * are scrubbed from every message this module produces.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});

  const TIMEOUT_MS = 30000;

  class AiHttpError extends Error {
    constructor(message, { status = 0, body = null, network = false, timeout = false, retryAfterMs = 0 } = {}) {
      super(message);
      this.name = 'AiHttpError';
      this.status = status;
      this.body = body;
      this.network = network;
      this.timeout = timeout;
      this.retryAfterMs = retryAfterMs;
    }
  }

  /** Remove anything that looks like a credential from text that may be logged or shown. */
  function scrub(text, secrets = []) {
    let out = String(text ?? '');
    for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
    return out
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
      .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
      .slice(0, 300);
  }

  /** Seconds from a Retry-After header (or Gemini's RetryInfo) as milliseconds. */
  function retryAfterMs(res, body) {
    const header = res?.headers?.get?.('retry-after');
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 15 * 60000);
    if (header) {
      const at = Date.parse(header);
      if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 15 * 60000));
    }
    const details = body?.error?.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        const delay = /^([0-9.]+)s$/.exec(String(d?.retryDelay || ''));
        if (delay) return Math.min(Number(delay[1]) * 1000, 15 * 60000);
      }
    }
    return 0;
  }

  async function parseBody(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  /**
   * One HTTP attempt. Resolves with the parsed JSON body, or throws AiHttpError.
   * @param {{url: string, method?: string, headers?: object, body?: object, secrets?: string[], fetchImpl?: Function}} opts
   */
  async function request({ url, method = 'GET', headers = {}, body, secrets = [], fetchImpl = fetch }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (err) {
      const timeout = err?.name === 'AbortError';
      throw new AiHttpError(timeout ? 'Request timed out after 30 s' : `Network error: ${scrub(err?.message, secrets)}`, {
        network: !timeout,
        timeout
      });
    } finally {
      clearTimeout(timer);
    }

    const parsed = await parseBody(res);
    if (res.ok) return parsed ?? {};
    const message = NS.aiClassify.providerMessage(parsed) || res.statusText || `HTTP ${res.status}`;
    throw new AiHttpError(`HTTP ${res.status}: ${scrub(message, secrets)}`, {
      status: res.status,
      body: parsed,
      retryAfterMs: retryAfterMs(res, parsed)
    });
  }

  NS.aiHttp = { request, AiHttpError, scrub, retryAfterMs, TIMEOUT_MS };
})();
