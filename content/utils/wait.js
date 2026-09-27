/*
 * Bounded wait helpers. Each one: timeout (default 5 s), MutationObserver trigger,
 * polling fallback, throttled predicate, full cleanup. They resolve to the found value
 * or null on timeout — never wait forever.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { isVisible } = NS.dom;

  const DEFAULT_TIMEOUT = 5000;
  const MENU_SELECTOR = '[role="menu"], [role="listbox"]';
  const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // rAF never fires in a background tab, so race it against a timer.
  const nextFrame = () =>
    new Promise((r) => {
      const t = setTimeout(r, 50);
      requestAnimationFrame(() => {
        clearTimeout(t);
        r();
      });
    });

  /** Let React commit: two frames plus a small delay. */
  async function settle(ms = 300) {
    await nextFrame();
    await nextFrame();
    await sleep(ms);
  }

  /**
   * @param {object} opts
   *   backoff: polling delays in ms (last one repeats) instead of a fixed pollInterval
   *   observeAttributes: false to wake only on nodes being added/removed
   *   attributeFilter: which attribute changes wake the check (when observeAttributes)
   *   root: observe only this subtree (e.g. one popover) instead of the whole body
   */
  function waitFor(
    predicate,
    {
      timeout = DEFAULT_TIMEOUT,
      minInterval = 100,
      pollInterval = 250,
      backoff = null,
      observeAttributes = true,
      attributeFilter = ['style', 'class', 'hidden', 'aria-expanded'],
      root = document.body
    } = {}
  ) {
    return new Promise((resolve) => {
      let done = false;
      let lastRun = 0;
      let scheduled = null;
      let observer = null;
      let poll = null;
      let timer = null;

      const finish = (value) => {
        if (done) return;
        done = true;
        observer?.disconnect();
        clearInterval(poll);
        clearTimeout(poll);
        clearTimeout(timer);
        clearTimeout(scheduled);
        resolve(value);
      };

      const check = () => {
        if (done) return;
        lastRun = Date.now();
        let value = null;
        try {
          value = predicate();
        } catch {
          value = null;
        }
        if (value) finish(value);
      };

      const throttledCheck = () => {
        if (done || scheduled) return;
        const wait = Math.max(0, minInterval - (Date.now() - lastRun));
        scheduled = setTimeout(() => {
          scheduled = null;
          check();
        }, wait);
      };

      check();
      if (done) return;
      observer = new MutationObserver(throttledCheck);
      observer.observe(
        root || document.documentElement,
        observeAttributes
          ? { childList: true, subtree: true, attributes: true, attributeFilter }
          : { childList: true, subtree: true }
      );
      if (backoff) {
        let step = 0;
        const next = () => {
          poll = setTimeout(() => {
            check();
            if (!done) next();
          }, backoff[Math.min(step++, backoff.length - 1)]);
        };
        next();
      } else {
        poll = setInterval(check, pollInterval);
      }
      timer = setTimeout(() => finish(null), timeout);
    });
  }

  function visibleMatches(selector) {
    return [...document.querySelectorAll(selector)].filter(isVisible);
  }

  function waitForVisibleElement(selectorOrFn, opts) {
    const find = typeof selectorOrFn === 'function' ? selectorOrFn : () => visibleMatches(selectorOrFn)[0] || null;
    return waitFor(find, opts);
  }

  /** A visible menu/listbox that was not in `exclude` (snapshot taken before the click). */
  function waitForVisibleMenu({ exclude = new Set(), ...opts } = {}) {
    return waitFor(() => visibleMatches(MENU_SELECTOR).find((el) => !exclude.has(el)) || null, opts);
  }

  function waitForVisibleDialog({ exclude = new Set(), ...opts } = {}) {
    return waitFor(() => visibleMatches(DIALOG_SELECTOR).find((el) => !exclude.has(el)) || null, opts);
  }

  /**
   * Reacquire a batch row from its stable descriptor. Polls at 100, 200, 300, 500, 750 ms,
   * then every 1 s, and wakes early (at most every 300 ms) when nodes are added/removed.
   */
  function waitForRow(ref, { purpose, timeout = DEFAULT_TIMEOUT } = {}) {
    return waitFor(() => NS.row.resolveRow(ref, { purpose }), {
      timeout,
      minInterval: 300,
      backoff: [100, 200, 300, 500, 750, 1000],
      observeAttributes: false
    });
  }

  NS.wait = {
    DEFAULT_TIMEOUT,
    MENU_SELECTOR,
    DIALOG_SELECTOR,
    sleep,
    nextFrame,
    settle,
    waitFor,
    visibleMatches,
    waitForVisibleElement,
    waitForVisibleMenu,
    waitForVisibleDialog,
    waitForRow
  };
})();
