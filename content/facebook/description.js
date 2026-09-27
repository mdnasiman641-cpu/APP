/*
 * Writes a description into the current row's field and verifies it from a fresh lookup.
 * Success is reported only after the exact text is read back from the page.
 *
 * Rich-text editors (Facebook uses Lexical) only receive text through input paths the
 * EDITOR itself handles (beforeinput, paste). Native execCommand typing and direct DOM
 * writes are deliberately not used: on a real Lexical editor they wipe or rewrite the
 * editor's DOM behind its back, and a corrupted editor makes Facebook replace the whole
 * page with "We're having trouble completing your request."
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { log } = NS.logger;
  const { setNativeValue, isEditable } = NS.dom;
  const { settle, waitFor } = NS.wait;
  const { VerificationError, FacebookTransientError, PageCrashedError } = NS.errors;

  const DESCRIPTION = { purpose: 'description' }; // needs filename + editor only
  const SELECTION_SYNC_MS = 80;
  const METHOD_WAIT_MS = 1500;

  function isPlainInput(el) {
    return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
  }

  function editableTarget(el) {
    if (isPlainInput(el) || isEditable(el)) return el;
    return el.querySelector('[contenteditable="true"], textarea, input') || el;
  }

  function readText(el) {
    if (isPlainInput(el)) return el.value;
    return typeof el.innerText === 'string' ? el.innerText : el.textContent || '';
  }

  // Compare letters/marks/digits only: editors reformat whitespace, line breaks, emoji and hashtags.
  const comparable = (s) => String(s || '').normalize('NFC').replace(/[^\p{L}\p{M}\p{N}]/gu, '');

  function containsText(actual, expected) {
    const e = comparable(expected);
    return e.length > 0 && comparable(actual).includes(e);
  }

  /**
   * Select the editor's whole content, then give the editor a moment to sync its own
   * selection (Lexical reads it on 'selectionchange', which fires asynchronously).
   * Without that pause the editor still has its old caret and appends instead of replacing.
   */
  async function selectAllIn(el) {
    el.focus();
    let ok = false;
    try {
      ok = document.execCommand('selectAll'); // changes the selection only, never the DOM
    } catch {
      ok = false;
    }
    const sel = window.getSelection();
    if (!ok || !sel.rangeCount || !el.contains(sel.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    await settle(SELECTION_SYNC_MS);
  }

  const RICH_METHODS = [
    function beforeInput(el, text) {
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text }));
      return true;
    },
    function paste(el, text) {
      if (typeof DataTransfer !== 'function' || typeof ClipboardEvent !== 'function') return false;
      const data = new DataTransfer();
      data.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      return true;
    }
  ];

  /** The row's editor as it is now (React may have replaced it since we last looked). */
  function currentEditor(ref, el) {
    if (el.isConnected) return el;
    const row = NS.row.resolveRow(ref, DESCRIPTION);
    return row ? editableTarget(row.descriptionElement) : null;
  }

  /**
   * Try each method once; after each, wait up to 1.5 s for the editor to show exactly the text.
   * Never stack another method on top of a partial or unexpected result.
   * @returns {{method: string, ok: boolean, changed: boolean}}
   */
  async function writeText(ref, el, text) {
    if (isPlainInput(el)) {
      setNativeValue(el, text); // dispatches input + change so React sees the value
      return { method: 'value-setter', ok: true, changed: true };
    }
    const expected = comparable(text);
    const initial = comparable(readText(el));
    for (const method of RICH_METHODS) {
      const target = currentEditor(ref, el);
      if (!target) break;
      await selectAllIn(target);
      if (!method(target, text)) continue;
      const matched = await waitFor(
        () => {
          const cur = currentEditor(ref, el);
          return Boolean(cur) && comparable(readText(cur)) === expected;
        },
        { timeout: METHOD_WAIT_MS, minInterval: 100, pollInterval: 150, observeAttributes: false }
      );
      if (matched) return { method: method.name, ok: true, changed: true };
      if (NS.pageErrors.isPageCrashed()) throw new PageCrashedError();
      const cur = currentEditor(ref, el);
      if (cur && comparable(readText(cur)) !== initial) return { method: method.name, ok: false, changed: true };
      log('APPLY', `Row ${ref.index + 1}: editor ignored ${method.name}, trying the next method`);
    }
    return { method: 'none', ok: false, changed: false };
  }

  async function writeAndVerify(ref, text) {
    // An error toast already on screen is not caused by this write; only a new one counts.
    const errorsBefore = new Set(NS.pageErrors.findErrorContainers());
    const row = await NS.row.acquireRow(ref, DESCRIPTION); // fresh DOM, never the pre-Gemini element
    const result = await writeText(ref, editableTarget(row.descriptionElement), text);
    if (!result.ok) {
      throw new VerificationError(
        result.changed
          ? `Row ${ref.index + 1}: the editor changed but does not show the generated text (${result.method}); not retried to avoid duplicate text`
          : `Row ${ref.index + 1}: the editor did not accept the text`,
        { changed: result.changed }
      );
    }
    log('APPLY', `Description inserted — row ${ref.index + 1} (${result.method})`);

    await settle(600); // let React/Lexical commit its own state
    if (NS.pageErrors.isPageCrashed()) throw new PageCrashedError();
    if (NS.pageErrors.findErrorContainers().some((el) => !errorsBefore.has(el))) {
      throw new FacebookTransientError('Facebook reported an error after inserting the description');
    }

    // Exact match (letters/digits): also catches leftover old text and duplicated text.
    const fresh = await NS.row.acquireRow(ref, DESCRIPTION);
    if (comparable(readText(editableTarget(fresh.descriptionElement))) !== comparable(text)) {
      throw new VerificationError(`Row ${ref.index + 1}: description not exactly present after re-reading the field`, { changed: true });
    }
    log('VERIFY', `Description verified — row ${ref.index + 1}`);
  }

  /** One extra attempt, but only if the first one left the editor untouched. */
  async function applyDescription(ref, text) {
    try {
      await writeAndVerify(ref, text);
    } catch (err) {
      if (!(err instanceof VerificationError) || err.changed) throw err;
      log('VERIFY', `Row ${ref.index + 1}: editor unchanged, trying once more`);
      await writeAndVerify(ref, text);
    }
  }

  NS.description = { applyDescription, containsText, readText };
})();
