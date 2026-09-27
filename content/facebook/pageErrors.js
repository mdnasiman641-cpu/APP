/*
 * Detects Facebook's own transient error UI ("We're having trouble completing your request.").
 * Searches only alert/dialog/status containers, never the whole page text.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { isVisible, textOf, normalize, accessibleName, safeClick, isInExtensionUi } = NS.dom;
  const { waitFor, settle } = NS.wait;

  const ERROR_CONTAINERS = '[role="alert"], [role="alertdialog"], [role="dialog"], [role="status"]';
  const ERROR_PATTERNS = [
    /we're having trouble completing your request/,
    /something went wrong/,
    /please try again later/,
    /কিছু ভুল হয়েছে/,
    /আপনার অনুরোধ সম্পূর্ণ করতে সমস্যা/
  ];
  const DISMISS_NAMES = /^(close|ok|okay|dismiss|got it|বন্ধ করুন|ঠিক আছে)$/;

  function findErrorContainers() {
    return [...document.querySelectorAll(ERROR_CONTAINERS)].filter((el) => {
      if (!isVisible(el)) return false;
      const text = normalize(textOf(el, 600));
      return ERROR_PATTERNS.some((re) => re.test(text));
    });
  }

  const findErrorContainer = () => findErrorContainers()[0] || null;

  /**
   * Facebook's full-page crash: its error text is visible AND the page no longer has any
   * editable field (the composer is gone). A toast over a working page is not a crash.
   * Only called on failure paths, so the text scan is not continuous.
   */
  function isPageCrashed() {
    const editable = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].some(
      (el) => !isInExtensionUi(el) && isVisible(el)
    );
    if (editable) return false;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const value = t.nodeValue;
      if (!value || value.length > 200 || isInExtensionUi(t)) continue;
      if (ERROR_PATTERNS.some((re) => re.test(normalize(value))) && isVisible(t.parentElement)) return true;
    }
    return false;
  }

  /** Dismiss the error if it offers a harmless Close/OK button, then wait for it to go away. */
  async function waitForRecovery(timeout = 8000) {
    const container = findErrorContainer();
    if (!container) return true;
    const dismiss = [...container.querySelectorAll('button, [role="button"]')].find(
      (b) => isVisible(b) && DISMISS_NAMES.test(accessibleName(b))
    );
    if (dismiss) {
      try {
        safeClick(dismiss, { scopes: [container], label: 'error dismiss button' });
      } catch {
        /* the error may have vanished on its own */
      }
    }
    const cleared = await waitFor(() => !findErrorContainer(), { timeout });
    await settle(500);
    return Boolean(cleared);
  }

  NS.pageErrors = { findErrorContainer, findErrorContainers, isPageCrashed, waitForRecovery };
})();
