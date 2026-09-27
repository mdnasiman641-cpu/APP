/*
 * Structured, concise logging. Tags: INIT DETECT GENERATE APPLY VERIFY SCHEDULE ERROR.
 * Never pass DOM nodes, API keys or page dumps here; strings are length-capped and scrubbed.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const MAX_ENTRIES = 200;
  const entries = [];
  const listeners = new Set();

  const scrub = (s) =>
    String(s)
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
      .slice(0, 400);

  function log(tag, message) {
    const entry = { time: new Date().toISOString().slice(11, 19), tag, message: scrub(message) };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    const line = `[${entry.tag}] ${entry.message}`;
    (tag === 'ERROR' ? console.warn : console.info)(`[FBRA] ${line}`);
    for (const fn of listeners) fn(entry);
  }

  NS.logger = {
    log,
    recent: (n = 30) => entries.slice(-n),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
})();
