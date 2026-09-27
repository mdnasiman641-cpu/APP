/*
 * Runs in the page's MAIN world. Its only job: announce SPA navigation.
 * An isolated-world content script cannot observe the page's own history.pushState calls.
 * Holds no data and exposes nothing.
 */
(() => {
  if (window.__fbraNavHook) return;
  window.__fbraNavHook = true;
  const notify = () => window.dispatchEvent(new Event('fbra:locationchange'));
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      notify();
      return result;
    };
  }
})();
