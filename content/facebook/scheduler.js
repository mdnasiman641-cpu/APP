/*
 * Per-row scheduling through Facebook's own UI. Strictly one row at a time.
 *
 *   reacquire row (once) → click that row's "Publish now" control → wait for the popover
 *   → click the "Schedule" tab inside THAT POPOVER directly (always, even when date/time
 *     fields are already on screen — Facebook shows them on the "Publish now" tab too,
 *     and filling them without switching tabs schedules nothing) → verify Schedule mode
 *   → DATE: focus → read its editing format → select all → type the target in that format →
 *     native input/change events → blur → read back → compare as a calendar date
 *   → TIME: the same, compared as minutes of the day ("06:00 PM" == "18:00")
 *   → both re-checked together → press Update → verify the row is scheduled.
 *
 * Each field is entered directly first (execCommand insertText, i.e. a native edit that React's
 * controlled input sees as typing; the native value setter + events only if the browser refuses),
 * retried once on a reacquired input, and only then typed with the REAL keyboard (Ctrl+A, the
 * text, Tab) through the same debugger bridge. Update is never pressed before both values read
 * back correctly.
 *
 * Only when the direct DOM click on the Schedule tab does not make it active does the
 * scheduler fall back to REAL key presses (chrome.debugger via bridge.attachKeyboard/pressKey):
 * Tab → check the focused element → Enter. The debugger is attached lazily, the first time a
 * row needs it, and released by the runner when the scheduling phase ends.
 *
 * Waits are MutationObserver-driven and scoped to the popover/row where possible, with short
 * polling only as a fallback; there are no fixed long delays. Every step is timed
 * ([SCHEDULE] [TIMING] row=N step=… ms=…) so slow operations are easy to spot.
 *
 * Clicks are limited to the row and the overlay that appeared after our own click, and
 * all go through dom.safeClick (which refuses final Publish/Post buttons).
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { log } = NS.logger;
  const { isVisible, accessibleName, fieldHints, safeClick, setNativeValue, pressEscape, isPopupTrigger, isForbiddenTarget, hasDropdownAffordance, isInExtensionUi, normalize, textOf, CLICKABLE_SELECTOR } =
    NS.dom;
  const { waitFor, nextFrame, sleep, visibleMatches, MENU_SELECTOR, DIALOG_SELECTOR } = NS.wait;
  const { ElementNotFoundError, VerificationError, FacebookTransientError } = NS.errors;

  const OVERLAY_SELECTOR = `${MENU_SELECTOR}, ${DIALOG_SELECTOR}`;
  const SCHEDULE_OPTION_RE = /^(schedule( (post|reel|video|for later))?|publish later|later|সময়সূচি নির্ধারণ করুন|শিডিউল( করুন)?)(?=$|[\s,.:–-])/;
  const EXCLUDE_OPTION_RE = /publish now|post now|share now|এখনই/;
  const TRIGGER_RE = /publish|post|share|schedul|প্রকাশ|শিডিউল|সময়সূচি/;
  const CANCEL_RE = /^(cancel|close|বাতিল( করুন)?|বন্ধ করুন)$/;
  // The popover's own confirm button. Checked in two passes so a "Schedule" TAB is never
  // mistaken for the confirm button (the tabs come first in the DOM).
  const CONFIRM_STRONG_RE = /^(update|save|done|apply|set|confirm|ok|আপডেট|সংরক্ষণ করুন|হয়ে গেছে|ঠিক আছে)$/;
  const CONFIRM_FALLBACK_RE = /^(schedule|schedule post|schedule reel|schedule video|শিডিউল করুন|সময়সূচি নির্ধারণ করুন)$/;
  const TAB_ROLE_RE = /tab|radio|option|menuitem/;
  const TAB_SELECTOR = '[role="tab"], [role="radio"], [role="option"], [role="menuitemradio"], [role="menuitem"]';
  const MODE_SELECTOR_RE = /publish now|post now|share now|এখনই প্রকাশ/; // the row's publish-mode selector
  // A row control that is (only) the "Publish now" mode selector: short, starts with the mode.
  const MODE_NAME_RE = /^(publish now|post now|share now|এখনই প্রকাশ( করুন)?)(?=$|[\s,.:–-])/;
  // Optional, secondary: what some layouts call the scheduling dropdown. Not required.
  const SCHEDULING_CONTROL_RE =
    /^(scheduling( and editing)? options?|schedule options?|scheduling|publishing options?|edit schedule|সময়সূচির বিকল্প|শিডিউলিং অপশন)(?=$|[\s,.:–-])/;
  const NAMED_SELECTOR = '[aria-label], [aria-labelledby], [title], button, [role="button"], [role="combobox"], [aria-haspopup]';
  const MODE_CANDIDATE_SELECTOR = `${CLICKABLE_SELECTOR}, [tabindex]`;
  const OPENER_CHILD_SELECTOR = '[role="combobox"], [aria-haspopup], button, [role="button"]';
  const MAX_OPEN_TARGETS = 3;
  const MAX_SCOPE_LEVELS = 3; // how far above the row element the "Publish now" control may sit
  const SCHEDULED_MARKER_RE = /schedul|সময়সূচি|শিডিউল/;
  const DATE_HINT_RE = /date|mm\/dd|dd\/mm|yyyy|তারিখ/;
  const TIME_HINT_RE = /(^|[^a-z])time|hh:mm|সময়/;
  const TAB_ATTRS = ['aria-selected', 'aria-checked', 'aria-pressed', 'data-selected', 'class', 'style', 'hidden', 'aria-hidden', 'disabled', 'aria-disabled'];

  // Time budgets (upper bounds; every wait returns as soon as its condition holds).
  const POPOVER_TIMEOUT = 2500;
  const TAB_CLICK_TIMEOUT = 700;
  const KEY_ACTIVATE_TIMEOUT = 1500;
  const FIELDS_TIMEOUT = 2000;
  const VALUES_TIMEOUT = 800; // after blur: until the field shows the value
  const STABLE_MS = 80; // …and it still shows it a moment later (not reverted)
  const UPDATE_CLOSE_TIMEOUT = 3000;
  const ROW_VERIFY_TIMEOUT = 1500;
  const CLOSE_TIMEOUT = 500;

  const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const MONTHS_BN = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];
  const pad = (n) => String(n).padStart(2, '0');
  const bengaliToAscii = (s) => s.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function assertNoFacebookError(step) {
    if (NS.pageErrors.findErrorContainer()) throw new FacebookTransientError(`Facebook reported an error during: ${step}`);
  }

  /** Tag an error with the scheduling step that failed, for the panel and the logs. */
  function fail(err, step) {
    if (!err.step) err.step = step;
    return err;
  }

  /** Per-row stopwatch: logs each step's duration and a one-line summary at the end. */
  function createTimer(rowNo) {
    const start = now();
    let last = start;
    const steps = [];
    return {
      mark(step) {
        const t = now();
        const ms = Math.round(t - last);
        last = t;
        steps.push(`${step}=${ms}`);
        log('SCHEDULE', `[TIMING] row=${rowNo} step=${step} ms=${ms}`);
        return ms;
      },
      summary(ok) {
        log('SCHEDULE', `[TIMING] row=${rowNo} total=${Math.round(now() - start)}ms ok=${ok} ${steps.join(' ')}`);
      }
    };
  }
  const NO_TIMER = { mark() {}, summary() {} };

  const snapshotOverlays = () => new Set(visibleMatches(OVERLAY_SELECTOR));

  function clickables(scope) {
    return [...scope.querySelectorAll(CLICKABLE_SELECTOR)].filter((el) => isVisible(el) && !isForbiddenTarget(el));
  }

  /* ------------------------------------------------------------------ row control */

  /** Can this element open a popover (so clicking it cannot publish)? */
  const opensPopover = (el) => isPopupTrigger(el) || hasDropdownAffordance(el);

  /**
   * "Publish now" mode selectors inside `scope`: clickable elements whose own name starts with
   * the mode, plus the clickable ancestor of a leaf "Publish now" label. Only ones that open a
   * popover (aria-haspopup/expanded/combobox or a chevron) are returned — a bare "Publish now"
   * button may publish and is never clicked.
   */
  function modeSelectors(scope) {
    const found = new Set();
    for (const el of scope.querySelectorAll(MODE_CANDIDATE_SELECTOR)) {
      const name = accessibleName(el);
      if (name.length <= 60 && MODE_NAME_RE.test(name)) found.add(el);
    }
    for (const leaf of scope.querySelectorAll('span, div')) {
      if (leaf.children.length || !MODE_NAME_RE.test(normalize(leaf.textContent))) continue;
      const clickable = leaf.closest(MODE_CANDIDATE_SELECTOR);
      // Only a small control around the label — never a whole row that happens to be clickable.
      if (clickable && scope.contains(clickable) && accessibleName(clickable).length <= 60) found.add(clickable);
    }
    const usable = [...found].filter((el) => isVisible(el) && !isInExtensionUi(el) && opensPopover(el));
    // Innermost first: Facebook often binds the handler to the element closest to the label.
    return usable.filter((el) => !usable.some((o) => o !== el && el.contains(o) && opensPopover(o)));
  }

  /**
   * The row's "Publish now" control. Searched in the row element first; if the row element
   * does not contain it, in up to MAX_SCOPE_LEVELS ancestors — but only while that ancestor
   * still belongs to this reel alone (exactly one mode selector and at most one description
   * editor), so another reel's control can never be picked.
   * @returns {{el: Element, scope: Element} | null}
   */
  function findPublishNowControl(row) {
    let scope = row.element;
    for (let level = 0; scope && level <= MAX_SCOPE_LEVELS; level++, scope = scope.parentElement) {
      if (level > 0) {
        const editors = scope.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]').length;
        if (editors > 1) return null; // shared container of several reels
      }
      const found = modeSelectors(scope);
      if (found.length === 1 || (level === 0 && found.length > 1)) return { el: found[0], scope };
      if (found.length > 1) return null;
    }
    return null;
  }

  /**
   * Secondary opener when the row has no "Publish now" selector (e.g. after it was scheduled):
   * a control the row names as its scheduling dropdown, then a "Schedule…" control, then a
   * dropdown whose name is about publishing/scheduling. All scoped to this row.
   * @returns {{el: Element, targets: Element[]} | null}
   */
  function findFallbackControl(rowEl) {
    const candidates = [...rowEl.querySelectorAll(NAMED_SELECTOR)].filter(isVisible);
    const named = candidates.find((el) => SCHEDULING_CONTROL_RE.test(accessibleName(el)) && !isForbiddenTarget(el));
    if (named) {
      const targets = [named];
      for (const child of named.querySelectorAll(OPENER_CHILD_SELECTOR)) {
        if (isVisible(child) && !targets.includes(child)) targets.push(child);
      }
      return { el: named, targets: targets.slice(0, MAX_OPEN_TARGETS) };
    }
    const safe = candidates.filter((el) => !isForbiddenTarget(el) && !MODE_SELECTOR_RE.test(accessibleName(el)));
    const direct = safe.find((el) => SCHEDULE_OPTION_RE.test(accessibleName(el)));
    if (direct) return { el: direct, targets: [direct] };
    const dropdown = safe.find((el) => opensPopover(el) && (TRIGGER_RE.test(accessibleName(el)) || SCHEDULED_MARKER_RE.test(accessibleName(el))));
    if (dropdown) return { el: dropdown, targets: [dropdown] };
    return null;
  }

  /** The control to open for this row, as ordered click targets with their allowed scope. */
  function findRowControl(row) {
    const rowEl = row.element;
    const primary = findPublishNowControl(row);
    if (primary) return { kind: 'publish-now', el: primary.el, scope: primary.scope, targets: [primary.el], mode: accessibleName(primary.el) };
    const fallback = findFallbackControl(rowEl);
    if (fallback) return { kind: 'fallback', el: fallback.el, scope: fallback.el, targets: fallback.targets, mode: accessibleName(fallback.el) };

    const names = [...rowEl.querySelectorAll(NAMED_SELECTOR)].filter(isVisible).map((el) => accessibleName(el)).filter(Boolean);
    const seen = [...new Set(names)].slice(0, 8).map((n) => `"${n.slice(0, 40)}"`);
    throw fail(
      new ElementNotFoundError(
        `No "Publish now" dropdown found for this row (a "Publish now" control without a dropdown is never clicked). ` +
          `Controls found: ${seen.length ? seen.join(', ') : 'none'}. Run "Debug Facebook" and send the output.`
      ),
      'control'
    );
  }

  /* ------------------------------------------------------------------ overlays */

  /**
   * Start watching for an overlay that was not visible in `before`. Must be started BEFORE the
   * click: React may render the popover synchronously inside the click handler.
   * Wakes on added nodes only (checking just those subtrees, never re-scanning the page), with a
   * light role-selector poll as a fallback for an overlay that is shown by a style change.
   */
  function watchNewOverlay(before, trigger) {
    const pending = new Set();
    const accept = (el) => el && el.isConnected && !before.has(el) && !isInExtensionUi(el) && isVisible(el);
    const collect = (node) => {
      if (node.nodeType !== 1) return;
      if (node.matches(OVERLAY_SELECTOR)) pending.add(node);
      const up = node.parentElement?.closest(OVERLAY_SELECTOR);
      if (up) pending.add(up);
      for (const el of node.querySelectorAll(OVERLAY_SELECTOR)) pending.add(el);
    };
    const byControls = () => {
      const id = trigger?.getAttribute('aria-controls');
      const el = id && document.getElementById(id);
      if (!el) return null;
      const overlay = el.matches(OVERLAY_SELECTOR) ? el : el.closest(OVERLAY_SELECTOR) || el.querySelector(OVERLAY_SELECTOR) || el;
      return accept(overlay) ? overlay : null;
    };
    const check = () => {
      for (const el of pending) if (accept(el)) return el;
      return byControls();
    };
    const observer = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) collect(n);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return {
      async wait(timeout = POPOVER_TIMEOUT) {
        let polls = 0;
        const result = await waitFor(
          () => {
            const hit = check();
            if (hit) return hit;
            // Every ~4th check, fall back to a role-selector query (no text scanning).
            if (++polls % 4 === 0) return visibleMatches(OVERLAY_SELECTOR).find((el) => accept(el)) || null;
            return null;
          },
          { timeout, minInterval: 16, pollInterval: 60, observeAttributes: false }
        );
        observer.disconnect();
        return result;
      },
      stop: () => observer.disconnect()
    };
  }

  /**
   * Reacquire-free open: click the row's control and return the popover that appeared.
   * @returns {Promise<{overlay: Element, control: object}>}
   */
  async function openPopover(row, onStage = () => {}) {
    let control;
    try {
      control = findRowControl(row);
    } catch (err) {
      onStage('control-found', false);
      throw err;
    }
    onStage('control-found', control.kind);
    onStage('current-mode', control.mode);

    for (const target of control.targets) {
      if (!target.isConnected) continue;
      const watch = watchNewOverlay(snapshotOverlays(), target);
      try {
        // "Publish now ⌄" is a mode selector here: allowed only because it opens a popover
        // (checked in modeSelectors) and only inside this row's scope.
        safeClick(target, {
          scopes: [control.scope],
          label: 'row "Publish now" control',
          allowModeSelector: control.kind === 'publish-now' || (target !== control.el && control.el.contains(target))
        });
      } catch {
        watch.stop();
        continue;
      }
      onStage('control-clicked', true);
      const overlay = await watch.wait();
      if (overlay) {
        onStage('popover-visible', true);
        onStage('popover-opened', true);
        return { overlay, control };
      }
    }
    onStage('popover-visible', false);
    throw fail(new ElementNotFoundError(`The row's "${control.mode || 'Publish now'}" control did not open its popover`), 'popover');
  }

  /** Reacquire the row (full detection), then open its popover. Used for verify-by-reopening. */
  async function openSchedulingPopover(ref, onStage) {
    return openPopover(await NS.row.acquireRow(ref), onStage);
  }

  /* ------------------------------------------------------------------ Schedule tab */

  /** True when a tab/option is the currently chosen one. */
  function isChosen(el) {
    for (const attr of ['aria-selected', 'aria-checked', 'aria-pressed', 'data-selected']) {
      if (el.getAttribute(attr) === 'true') return true;
    }
    return el.tagName === 'INPUT' && el.checked === true;
  }

  const hasChoiceState = (el) => ['aria-selected', 'aria-checked', 'aria-pressed', 'data-selected'].some((a) => el.hasAttribute(a)) || el.tagName === 'INPUT';

  /**
   * The "Schedule" tab/option inside THIS popover only (never a page-wide search).
   * @returns {{el: Element, name: string, chosen: boolean} | null}
   */
  function findScheduleOption(overlay) {
    const options = clickables(overlay).filter((el) => {
      const name = accessibleName(el);
      return SCHEDULE_OPTION_RE.test(name) && !EXCLUDE_OPTION_RE.test(name);
    });
    const rank = (el) => (/tab|menuitem|option|radio/.test(el.getAttribute('role') || '') ? 0 : el.tagName === 'INPUT' ? 1 : 2);
    const el = options.sort((a, b) => rank(a) - rank(b))[0];
    return el ? { el, name: accessibleName(el), chosen: isChosen(el) } : null;
  }

  /** The popover's "Publish now" tab (never clicked; only read to compare states). */
  function findPublishNowTab(overlay, scheduleEl) {
    return (
      [...overlay.querySelectorAll(`${TAB_SELECTOR}, ${CLICKABLE_SELECTOR}`)].find(
        (el) => el !== scheduleEl && !el.contains(scheduleEl) && !scheduleEl.contains(el) && isVisible(el) && MODE_NAME_RE.test(accessibleName(el))
      ) || null
    );
  }

  /** Style fingerprint, so a tab that carries no aria state can still be seen to change. */
  function tabLook(el) {
    const st = getComputedStyle(el);
    return [st.backgroundColor, st.color, st.fontWeight, st.borderBottomColor, st.boxShadow].join('|');
  }

  /** Everything needed to tell whether the tab really became the active one. */
  function tabState(overlay, tabEl) {
    const other = findPublishNowTab(overlay, tabEl);
    return {
      chosen: hasChoiceState(tabEl) ? isChosen(tabEl) : null,
      look: tabLook(tabEl),
      otherLook: other ? tabLook(other) : null,
      otherChosen: other && hasChoiceState(other) ? isChosen(other) : null,
      fields: Boolean(findDateTimeInputs(overlay)),
      othersChosen: [...overlay.querySelectorAll(TAB_SELECTOR)].filter((el) => el !== tabEl && isChosen(el)).length
    };
  }

  /**
   * Strict check used after a DOM click (hover/focus styling must not count as "active"):
   * aria state first (definitive); then another tab losing its selection; then date/time
   * fields that appeared; then, for tabs without any aria state, the "Publish now" tab taking on
   * the inactive look the Schedule tab had before. The Schedule tab's own look is not used: the
   * click focuses/hovers it, which restyles it whether or not it became active.
   */
  function strictlyActive(before, after) {
    if (after.chosen === true) return true;
    if (after.chosen === false) return false;
    if (after.otherChosen === true) return false;
    if (before.othersChosen > 0 && after.othersChosen === 0) return true;
    if (!before.fields && after.fields) return true;
    return Boolean(before.otherLook && before.look !== before.otherLook && after.otherLook === before.look);
  }

  /** Looser check for the keyboard path (the `before` state is taken after focusing the tab). */
  function becameActive(before, after) {
    if (after.chosen === true) return true;
    if (after.chosen === false) return false; // Facebook says plainly that it is not selected
    if (before.othersChosen > 0 && after.othersChosen === 0) return true;
    if (after.look !== before.look) return true;
    return !before.fields && after.fields;
  }

  /**
   * The tab currently selected in this popover — for the logs only, so it also reports a
   * tab the click guard would refuse (the selected tab is often "Publish now").
   */
  function currentTab(overlay) {
    const chosen = [...overlay.querySelectorAll(TAB_SELECTOR)].filter(isVisible).find(isChosen);
    return chosen ? accessibleName(chosen) : '(unknown)';
  }

  /** The popover again, after a React update: the same node if still shown, else the visible one offering "Schedule". */
  function reacquirePopover(previous) {
    if (previous && previous.isConnected && isVisible(previous)) return previous;
    return visibleMatches(OVERLAY_SELECTOR).find((el) => findScheduleOption(el)) || null;
  }

  /** Where to observe a popover: its parent, so a re-rendered copy is seen too. */
  const observeRootOf = (el) => (el?.isConnected && el.parentElement) || document.body;

  /**
   * Wait (event-driven, scoped to the popover) until the Schedule option is active.
   * Resolves to the popover to keep working in, or null.
   */
  function waitForScheduleActive(popover, before, { strict, timeout }) {
    const test = strict ? strictlyActive : becameActive;
    return waitFor(
      () => {
        const fresh = reacquirePopover(popover);
        const opt = fresh && findScheduleOption(fresh);
        if (opt && (opt.chosen || test(before, tabState(fresh, opt.el)))) return fresh;
        if (popover.isConnected && isVisible(popover)) return null;
        // A menu-style chooser closes and opens a separate date/time dialog instead.
        return visibleMatches(DIALOG_SELECTOR).find((o) => !findScheduleOption(o) && findDateTimeInputs(o)) || null;
      },
      { timeout, minInterval: 16, pollInterval: 80, root: observeRootOf(popover), attributeFilter: TAB_ATTRS }
    );
  }

  /** Pointer leaves the tab after the click, so hover styling does not linger. */
  function leave(el) {
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    for (const type of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) {
      try {
        el.dispatchEvent(new (type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent)(type, opts));
      } catch {
        /* element gone */
      }
    }
  }

  /**
   * PRIMARY: click the Schedule tab itself (then, once, its tab wrapper / inner control) and
   * verify strictly that it became active. Resolves to the active popover, or null.
   */
  async function clickScheduleTab(overlay, option, onStage) {
    const targets = [option.el];
    const wrapper = option.el.parentElement?.closest(TAB_SELECTOR);
    if (wrapper && overlay.contains(wrapper)) targets.push(wrapper);
    const inner = option.el.querySelector(CLICKABLE_SELECTOR);
    if (inner && isVisible(inner)) targets.push(inner);

    let popover = overlay;
    for (const target of targets.slice(0, 2)) {
      popover = reacquirePopover(popover);
      if (!popover || !target.isConnected) break;
      const fresh = findScheduleOption(popover);
      if (!fresh) break;
      const before = tabState(popover, fresh.el);
      try {
        safeClick(target, { scopes: [popover], label: 'Schedule tab' });
      } catch (err) {
        onStage('dom-click-failed', err.message);
        continue;
      }
      leave(target);
      onStage('dom-tab-clicked', target === option.el ? 'tab' : 'tab wrapper');
      const active = await waitForScheduleActive(popover, before, { strict: true, timeout: TAB_CLICK_TIMEOUT });
      if (active) return active;
      onStage('dom-click-failed', 'Schedule tab did not become active after the click');
    }
    return null;
  }

  /* ------------------------------------------------------------------ keyboard fallback */

  const MAX_TAB_PRESSES = 15;
  const KEY_MARKER = 'data-fbra-kbd-target'; // must match background/keyboard.js
  let keyboardAttached = false;

  /** Attach the debugger keyboard on first use (Chrome then shows its "debugging" bar). */
  async function ensureKeyboard() {
    if (keyboardAttached) return false;
    try {
      await NS.bridge.attachKeyboard();
    } catch (err) {
      throw fail(new ElementNotFoundError(`Keyboard: ${err.message}`), 'keyboard');
    }
    keyboardAttached = true;
    return true;
  }

  /** Called by the runner when the scheduling phase ends. */
  async function releaseKeyboard() {
    if (!keyboardAttached) return;
    keyboardAttached = false;
    await NS.bridge.releaseKeyboard().catch(() => {});
  }

  /** A real key press from the service worker; a failure stops this row with step "keyboard". */
  async function realKey(key) {
    try {
      await NS.bridge.pressKey(key);
    } catch (err) {
      throw fail(new ElementNotFoundError(`Keyboard: ${err.message}`), 'keyboard');
    }
    // Input.dispatchKeyEvent resolves after the page handled the key; one frame lets React commit.
    await nextFrame();
  }

  function selectedTab(overlay) {
    return [...overlay.querySelectorAll(TAB_SELECTOR)].filter(isVisible).find(isChosen);
  }

  /**
   * The focused element when keyboard focus is on the Schedule option: the option itself, an
   * element inside it, or a tab wrapper around it that is itself named "Schedule". Else null.
   */
  function focusedScheduleTarget(el) {
    const active = document.activeElement;
    if (!active || !el || active === document.body) return null;
    if (active === el || el.contains(active)) return active;
    const name = accessibleName(active);
    if (active.contains(el) && SCHEDULE_OPTION_RE.test(name) && !EXCLUDE_OPTION_RE.test(name)) return active;
    return null;
  }
  const focusIsOn = (el) => Boolean(focusedScheduleTarget(el));

  /** Fresh popover + fresh Schedule option, or a row error if Facebook took them away. */
  function freshScheduleOption(overlay) {
    const popover = reacquirePopover(overlay);
    const option = popover && findScheduleOption(popover);
    if (!option) throw fail(new ElementNotFoundError('The scheduling popover closed while moving to the Schedule tab'), 'schedule-tab-focus');
    return { popover, option };
  }

  /**
   * Move keyboard focus to the Schedule tab with REAL key presses, checking after every press
   * which element has focus:
   *   1. focus the currently selected tab ("Publish now") — focus only, nothing is activated
   *   2. Tab until the focused element is the Schedule tab (stops if focus leaves the popover)
   *   3. tab lists with a roving tabindex skip unselected tabs on Tab: use the arrow keys
   */
  async function focusScheduleTab(overlay) {
    let { popover, option } = freshScheduleOption(overlay);
    const start = selectedTab(popover) || popover.querySelector('[role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"]), button');
    start?.focus?.({ preventScroll: true });
    await nextFrame();
    ({ popover, option } = freshScheduleOption(popover));
    if (focusIsOn(option.el)) return { popover, option, presses: 'already focused' };

    for (let n = 1; n <= MAX_TAB_PRESSES; n++) {
      await realKey('Tab');
      ({ popover, option } = freshScheduleOption(popover));
      if (focusIsOn(option.el)) return { popover, option, presses: `Tab ×${n}` };
      if (!popover.contains(document.activeElement)) break; // focus left the popover: stop tabbing
    }

    const arrow = /menuitem|option/.test(option.el.getAttribute('role') || '') ? 'ArrowDown' : 'ArrowRight';
    const tabs = popover.querySelectorAll(TAB_SELECTOR).length || 3;
    (selectedTab(popover) || start)?.focus?.({ preventScroll: true });
    for (let n = 1; n <= tabs; n++) {
      await realKey(arrow);
      ({ popover, option } = freshScheduleOption(popover));
      if (focusIsOn(option.el)) return { popover, option, presses: `${arrow} ×${n}` };
    }
    throw fail(new ElementNotFoundError('Schedule tab could not be focused with the keyboard'), 'schedule-tab-focus');
  }

  /**
   * FALLBACK: make the Schedule tab active with real keys and prove it — focus it (Tab), confirm
   * focus is on it, press Enter (Space once as a retry), wait until it is active.
   * @returns {Promise<Element>} the popover to keep working in
   */
  async function keyboardActivate(overlay, onStage) {
    onStage('navigating', true);
    for (const key of ['Enter', 'Space']) {
      const { popover, option, presses } = await focusScheduleTab(overlay);
      if (!focusIsOn(option.el)) throw fail(new ElementNotFoundError('Schedule tab lost keyboard focus'), 'schedule-tab-focus');
      onStage('tab-focused', presses);
      const before = tabState(popover, option.el);
      // The worker presses Enter/Space only while focus is inside this marked element.
      const focused = focusedScheduleTarget(option.el);
      const marked = option.el.contains(focused) ? option.el : focused;
      marked.setAttribute(KEY_MARKER, '');
      try {
        await realKey(key);
      } finally {
        marked.removeAttribute(KEY_MARKER);
      }
      onStage('key-pressed', key);
      const active = await waitForScheduleActive(popover, before, { strict: false, timeout: KEY_ACTIVATE_TIMEOUT });
      assertNoFacebookError('selecting the Schedule tab');
      if (active) return active;
      overlay = reacquirePopover(popover) || popover;
    }
    throw fail(new ElementNotFoundError('Schedule tab could not be activated'), 'schedule-tab-activate');
  }

  /**
   * Schedule tab: direct DOM click first, real keyboard only if that did not activate it.
   * @returns {Promise<{overlay: Element, method: string}>}
   */
  async function activateScheduleTab(ctx, onStage, timer) {
    const { overlay, option } = ctx;
    const byClick = await clickScheduleTab(overlay, option, onStage);
    timer.mark('schedule-tab-dom-click');
    assertNoFacebookError('selecting the Schedule tab');
    if (byClick) return { overlay: byClick, method: 'dom' };

    log('SCHEDULE', `row=${ctx.rowNo} direct Schedule-tab click did not activate it; falling back to the real keyboard`);
    const freshlyAttached = await ensureKeyboard();
    timer.mark('keyboard-attach');
    let popover = reacquirePopover(overlay);
    if (!popover && freshlyAttached) {
      // Chrome's "debugging" bar resizes the page and can close the popover: open it again.
      ({ overlay: popover } = await openPopover(ctx.row, onStage));
      ctx.opened.add(popover);
      timer.mark('popover-reopen');
    }
    if (!popover) throw fail(new ElementNotFoundError('The scheduling popover closed before the keyboard fallback'), 'schedule-tab-focus');
    const active = await keyboardActivate(popover, onStage);
    timer.mark('schedule-tab-keyboard');
    return { overlay: active, method: 'keyboard' };
  }

  /* ------------------------------------------------------------------ date/time */

  /**
   * The popover's confirm button ("Update" in Meta Business Suite). Tabs are excluded, so
   * clicking the Schedule tab again can never be mistaken for confirming.
   */
  function findConfirmButton(scope, exclude) {
    const candidates = clickables(scope).filter((el) => el !== exclude && !TAB_ROLE_RE.test(el.getAttribute('role') || ''));
    return (
      candidates.find((el) => CONFIRM_STRONG_RE.test(accessibleName(el))) ||
      candidates.find((el) => CONFIRM_FALLBACK_RE.test(accessibleName(el))) ||
      null
    );
  }

  function findDateTimeInputs(scope) {
    if (!scope) return null;
    let date = null;
    let time = null;
    const spin = {};
    for (const el of scope.querySelectorAll('input, [role="spinbutton"]')) {
      if (!isVisible(el) || el.disabled || el.readOnly) continue;
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      const hints = fieldHints(el);
      if (el.getAttribute('role') === 'spinbutton') {
        if (/hour|ঘণ্টা/.test(hints)) spin.hour = el;
        else if (/minute|মিনিট/.test(hints)) spin.minute = el;
        else if (/am|pm|meridiem|period/.test(hints)) spin.meridiem = el;
      } else if (!date && (type === 'date' || (type === 'text' && DATE_HINT_RE.test(hints)))) date = el;
      else if (!time && (type === 'time' || (type === 'text' && TIME_HINT_RE.test(hints) && !/zone/.test(hints)))) time = el;
    }
    const hasTime = time || (spin.hour && spin.minute);
    return date && hasTime ? { date, time, spin } : null;
  }

  /* Date/time values are compared as calendar dates / minutes of the day, never as text:
   * the extension plans "2026-09-29 18:00" while Facebook may show "29 September 2026",
   * "29/9/2026" or "09/29/2026", and "06:00 PM" or "18:00". */

  const MONTH_WORDS = MONTHS_EN.map((m, i) => [m.slice(0, 3), i]).concat(MONTHS_BN.map((m, i) => [m, i]));

  function monthIndex(word) {
    const w = normalize(word).replace(/\.$/, '');
    for (const [name, i] of MONTH_WORDS) if (w.startsWith(name)) return i;
    return -1;
  }

  /** Is this page's numeric date day-first (29/9/2026) rather than month-first (9/29/2026)? */
  function localeDayFirst() {
    try {
      const lang = document.documentElement.lang || navigator.language || 'en-US';
      const parts = new Intl.DateTimeFormat(lang).formatToParts(new Date(2026, 0, 15));
      return parts.findIndex((p) => p.type === 'day') < parts.findIndex((p) => p.type === 'month');
    } catch {
      return false;
    }
  }

  /**
   * Day/month order of a numeric date field: the field's own value when it is unambiguous
   * (a first number over 12), then its placeholder/label, then the page language.
   */
  function numericDayFirst(input, current) {
    const m = /(\d{1,2})[/.-](\d{1,2})[/.-]\d{4}/.exec(current || '');
    if (m && Number(m[1]) > 12) return true;
    if (m && Number(m[2]) > 12) return false;
    const hint = fieldHints(input);
    if (/dd[/.-]mm/.test(hint)) return true;
    if (/mm[/.-]dd/.test(hint)) return false;
    return localeDayFirst();
  }

  /** @returns {{y: number, m: number, d: number} | null} (m is 0-based) */
  function parseDateValue(value, dayFirst) {
    const v = bengaliToAscii(normalize(value));
    let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
    if (m) return { y: +m[1], m: +m[2] - 1, d: +m[3] };
    m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(v);
    if (m) {
      let [a, b] = [+m[1], +m[2]];
      const df = a > 12 ? true : b > 12 ? false : dayFirst;
      return df ? { y: +m[3], m: b - 1, d: a } : { y: +m[3], m: a - 1, d: b };
    }
    m = /(\d{1,2})\s+([^\d\s,]+),?\s+(\d{4})/.exec(v); // 29 September 2026
    if (m && monthIndex(m[2]) >= 0) return { y: +m[3], m: monthIndex(m[2]), d: +m[1] };
    m = /([^\d\s,]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(v); // September 29, 2026
    if (m && monthIndex(m[1]) >= 0) return { y: +m[3], m: monthIndex(m[1]), d: +m[2] };
    return null;
  }

  function sameDate(value, slot, dayFirst) {
    const p = parseDateValue(value, dayFirst);
    const d = slot.date;
    return Boolean(p && p.y === d.getFullYear() && p.m === d.getMonth() && p.d === d.getDate());
  }

  /** Minutes since midnight, or null. "06:00 PM", "6:00pm", "18:00", "৬:০০ PM". */
  function parseTimeValue(value) {
    const v = bengaliToAscii(normalize(value));
    const m = /(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/.exec(v);
    if (!m) return null;
    let h = +m[1];
    const mi = +m[2];
    if (m[3]) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (m[3].startsWith('p') ? 12 : 0);
    }
    return h > 23 || mi > 59 ? null : h * 60 + mi;
  }

  const sameTime = (value, slot) => parseTimeValue(value) === slot.date.getHours() * 60 + slot.date.getMinutes();

  /**
   * The target date written the way THIS field writes dates (read while it is focused, because
   * Facebook may switch "29 September 2026" to "29/9/2026" for editing).
   */
  function formatDateLike(input, current, slot) {
    const d = slot.date;
    if (input.type === 'date') return slot.dateISO;
    const month = MONTHS_EN[d.getMonth()].replace(/^./, (c) => c.toUpperCase());
    const cur = String(current || '').trim();
    if (/^\d{1,2}\s+[A-Za-z]{3,}\.?\s+\d{4}$/.test(cur)) {
      const abbr = /^\d{1,2}\s+[A-Za-z]{3}\.?\s/.test(cur) ? month.slice(0, 3) : month;
      return `${d.getDate()} ${abbr} ${d.getFullYear()}`;
    }
    if (/^[A-Za-z]{3,}\.?\s+\d{1,2},?\s+\d{4}$/.test(cur)) {
      const abbr = /^[A-Za-z]{3}\.?\s/.test(cur) ? month.slice(0, 3) : month;
      return `${abbr} ${d.getDate()}${cur.includes(',') ? ',' : ''} ${d.getFullYear()}`;
    }
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(cur) || /yyyy-mm-dd/.test(fieldHints(input))) return slot.dateISO;
    const sep = (/\d([/.-])\d/.exec(cur) || [, '/'])[1];
    const padded = /(^|\D)0\d/.test(cur);
    const [dd, mm] = padded ? [pad(d.getDate()), pad(d.getMonth() + 1)] : [String(d.getDate()), String(d.getMonth() + 1)];
    return numericDayFirst(input, cur) ? `${dd}${sep}${mm}${sep}${d.getFullYear()}` : `${mm}${sep}${dd}${sep}${d.getFullYear()}`;
  }

  function to12h(d) {
    const h = d.getHours() % 12 || 12;
    return { h, mm: pad(d.getMinutes()), ampm: d.getHours() < 12 ? 'AM' : 'PM' };
  }

  /** The target time written the way THIS field writes times ("06:00 PM", "6:00 pm", "18:00"). */
  function formatTimeLike(input, current, slot) {
    if (input.type === 'time') return slot.time24;
    const cur = String(current || '').trim();
    const twelve = /[ap]\.?m\.?/i.test(cur) || (!cur && /am|pm/.test(fieldHints(input)));
    const padHour = /^0\d/.test(cur);
    if (!twelve) return padHour || !cur ? slot.time24 : `${slot.date.getHours()}:${pad(slot.date.getMinutes())}`;
    const { h, mm, ampm } = to12h(slot.date);
    const mer = /[ap]m/.test(cur) ? ampm.toLowerCase() : ampm;
    return `${padHour ? pad(h) : h}:${mm}${/\d\s+[ap]/i.test(cur) || !cur ? ' ' : ''}${mer}`;
  }

  /** The date/time the fields hold, as values the planner can compare (for row verification). */
  function fieldsMatch(inputs, slot) {
    const dateOk = sameDate(inputs.date.value, slot, numericDayFirst(inputs.date, inputs.date.value));
    const timeOk = inputs.time ? sameTime(inputs.time.value, slot) : sameTime(spinText(inputs.spin), slot);
    return dateOk && timeOk;
  }

  const spinValue = (el) => (el ? el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow') || textOf(el) : '');
  const spinText = (spin) => (spin?.hour ? `${spinValue(spin.hour)}:${pad(parseInt(bengaliToAscii(spinValue(spin.minute)), 10) || 0)} ${spinValue(spin.meridiem)}`.trim() : '');

  /**
   * DIRECT: focus → select all (Ctrl+A equivalent) → insert the text as a native edit
   * (execCommand fires real beforeinput/input events, exactly what React's onChange listens
   * to) → if the browser refused, the native value setter + input event (so React's value
   * tracker sees the change; never `.value =` alone) → change → blur (commit).
   */
  function directEnter(input, text) {
    input.focus({ preventScroll: true });
    // Native type="date"/"time" inputs have no text selection; they take the setter below.
    const selectable = !/^(date|time|datetime-local)$/.test(input.type);
    let inserted = false;
    if (selectable) {
      try {
        input.select();
        input.setSelectionRange(0, input.value.length);
        inserted = document.execCommand('insertText', false, text);
      } catch {
        inserted = false;
      }
    }
    if (!inserted || input.value !== text) setNativeValue(input, text);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  }

  /** Wait until `ok()` holds and still holds a moment later (Facebook may reformat or revert on blur). */
  async function settledTrue(ok, scope) {
    await nextFrame();
    if (!ok() && !(await waitFor(ok, { timeout: VALUES_TIMEOUT, minInterval: 16, pollInterval: 40, root: observeRootOf(scope) }))) return false;
    await sleep(STABLE_MS);
    await nextFrame();
    return ok();
  }

  /**
   * Set one field (date or time) and prove it: direct entry, then once more on a reacquired
   * input, then the REAL keyboard (focus → Ctrl+A → type → Tab). Logs every step as
   * [DATE][ROW n] … / [TIME][ROW n] ….
   * @param {object} f { tag, rowNo, getInput: () => Element|null, format(input, current), matches(value, input) }
   */
  async function setFieldVerified(f) {
    const say = (msg) => log(f.tag, `[ROW ${f.rowNo}] ${msg}`);
    const kind = f.tag.toLowerCase();
    const attempts = [
      { how: 'direct', reacquire: false },
      { how: 'direct', reacquire: true },
      { how: 'keyboard', reacquire: true }
    ];
    let last = '';
    for (const [i, attempt] of attempts.entries()) {
      const input = f.getInput();
      if (!input) throw fail(new ElementNotFoundError(`The ${kind} input is no longer in the Schedule popup`), `${kind}-field`);
      if (i === 0) say('input found');
      else say(`retry ${i} (${attempt.how}${attempt.reacquire ? ', input reacquired' : ''})`);

      let target;
      if (attempt.how === 'direct') {
        input.focus({ preventScroll: true });
        await nextFrame(); // Facebook may switch the field to its editing format on focus
        const before = input.value;
        target = f.format(input, before);
        say(`before="${before}"`);
        say(`target="${target}"`);
        say('select-all');
        directEnter(input, target);
        say('typed');
      } else {
        await ensureKeyboard();
        const fresh = f.getInput();
        if (!fresh) throw Object.assign(fail(new ElementNotFoundError(`The ${kind} input disappeared when keyboard control started`), `${kind}-field`), { restartRow: true });
        // The worker types and presses Ctrl+A only while focus is inside this marked field.
        fresh.setAttribute(KEY_MARKER, '');
        try {
          fresh.focus({ preventScroll: true });
          await nextFrame();
          const before = fresh.value;
          target = f.format(fresh, before);
          say(`before="${before}" (keyboard)`);
          say(`target="${target}"`);
          await realKey('SelectAll');
          say('select-all (Ctrl+A)');
          try {
            await NS.bridge.typeText(target);
          } catch (err) {
            throw fail(new ElementNotFoundError(`Keyboard: ${err.message}`), 'keyboard');
          }
          say('typed (keyboard)');
        } finally {
          fresh.removeAttribute(KEY_MARKER);
        }
        await realKey('Tab'); // blur, so Facebook commits the typed value
      }

      const read = () => f.getInput()?.value ?? '';
      const ok = () => {
        const el = f.getInput();
        return Boolean(el && f.matches(el.value, el));
      };
      const verified = await settledTrue(ok, input);
      last = read();
      say(`after="${last}"`);
      say(`verified=${verified}`);
      if (verified) return { value: last, method: attempt.how, attempts: i + 1 };
      assertNoFacebookError(`setting the ${kind}`);
    }
    throw fail(new VerificationError(`The ${kind} field did not keep the value (it shows "${last}")`), kind === 'date' ? 'date' : 'time');
  }

  /** Spin-button time pickers (hour / minute / AM-PM): real keyboard only, then verified. */
  async function setSpinTimeVerified(rowNo, getSpin, slot) {
    const say = (msg) => log('TIME', `[ROW ${rowNo}] ${msg}`);
    say('input found (hour/minute spin buttons)');
    say(`before="${spinText(getSpin())}"`);
    const { h, mm, ampm } = to12h(slot.date);
    const spin0 = getSpin();
    const parts = [
      ['hour', String(spin0.meridiem ? h : slot.date.getHours())],
      ['minute', mm],
      ['meridiem', spin0.meridiem ? ampm : '']
    ];
    say(`target="${slot.time24}"`);
    await ensureKeyboard();
    for (const [name, text] of parts) {
      const el = getSpin()?.[name];
      if (!el || !text) continue;
      el.setAttribute(KEY_MARKER, '');
      try {
        el.focus({ preventScroll: true });
        await nextFrame();
        await realKey('SelectAll');
        await NS.bridge.typeText(text).catch((err) => {
          throw fail(new ElementNotFoundError(`Keyboard: ${err.message}`), 'keyboard');
        });
      } finally {
        el.removeAttribute(KEY_MARKER);
      }
    }
    say('typed (keyboard)');
    const ok = () => sameTime(spinText(getSpin()), slot);
    const verified = await settledTrue(ok, getSpin()?.hour);
    say(`after="${spinText(getSpin())}"`);
    say(`verified=${verified}`);
    if (!verified) throw fail(new VerificationError(`The time did not keep the value (it shows "${spinText(getSpin())}")`), 'time');
  }

  function timeVariants(slot) {
    const { h, mm, ampm } = to12h(slot.date);
    const a = ampm.toLowerCase();
    return [`${h}:${mm} ${a}`, `${h}:${mm}${a}`, slot.time24, `${slot.date.getHours()}:${mm}`];
  }

  function dateVariants(slot, today = new Date()) {
    const d = slot.date;
    const [dd, m, y] = [d.getDate(), d.getMonth(), d.getFullYear()];
    const en = MONTHS_EN[m];
    const out = [
      `${en.slice(0, 3)} ${dd}`, `${en} ${dd}`, `${dd} ${en.slice(0, 3)}`, `${dd} ${en}`,
      `${m + 1}/${dd}/${y}`, `${pad(m + 1)}/${pad(dd)}/${y}`, `${dd}/${m + 1}/${y}`, `${pad(dd)}/${pad(m + 1)}/${y}`,
      slot.dateISO, `${dd} ${MONTHS_BN[m]}`, `${MONTHS_BN[m]} ${dd}`
    ];
    const dayDiff = Math.round((new Date(y, m, dd) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    if (dayDiff === 0) out.push('today', 'আজ');
    if (dayDiff === 1) out.push('tomorrow', 'আগামীকাল');
    return out;
  }

  /**
   * Close only overlays this operation opened: prefer their own Cancel/Close button,
   * else Escape on the overlay itself. Never a page-level Escape (it could close the
   * whole bulk-upload composer). Waits only until each one is actually gone.
   */
  async function closeOpenedOverlays(opened) {
    for (const overlay of [...opened].reverse()) {
      if (!overlay.isConnected || !isVisible(overlay)) continue;
      const cancel = clickables(overlay).find((el) => CANCEL_RE.test(accessibleName(el)));
      try {
        if (cancel) safeClick(cancel, { scopes: [overlay], label: 'overlay cancel button' });
        else pressEscape(overlay);
      } catch {
        /* overlay vanished meanwhile */
      }
      await waitFor(() => !overlay.isConnected || !isVisible(overlay), { timeout: CLOSE_TIMEOUT, minInterval: 16, pollInterval: 50, root: observeRootOf(overlay) });
    }
  }

  /**
   * Real verification: the row must actually show the intended time, either in its own
   * date/time inputs or in its text (with the date, or with a "Scheduled" marker).
   * A click alone never counts as scheduled.
   */
  function rowShowsSchedule(rowEl, slot) {
    const inline = findDateTimeInputs(rowEl);
    if (inline && fieldsMatch(inline, slot)) return true;
    const text = bengaliToAscii(normalize(textOf(rowEl, 3000)));
    if (!timeVariants(slot).some((t) => text.includes(t))) return false;
    return dateVariants(slot).some((v) => text.includes(v)) || SCHEDULED_MARKER_RE.test(text);
  }

  /**
   * Read Facebook's own state back: reopen the row's popover and check that the Schedule
   * tab is selected and the fields hold the wanted values. Closes the popover again.
   */
  async function verifyByReopening(ref, slot) {
    let overlay = null;
    try {
      ({ overlay } = await openSchedulingPopover(ref));
      const option = findScheduleOption(overlay);
      const inputs = findDateTimeInputs(overlay);
      if (!option?.chosen || !inputs) return false;
      return fieldsMatch(inputs, slot);
    } catch {
      return false;
    } finally {
      if (overlay) await closeOpenedOverlays(new Set([overlay]));
    }
  }

  /** The row element to check: the one we hold while it is on the page, else a fresh lookup. */
  function currentRowElement(ref, row) {
    if (row.element?.isConnected) return row.element;
    return NS.row.resolveRow(ref)?.element || null;
  }

  /* ------------------------------------------------------------------ one row */

  /**
   * Schedule one row through Facebook's own UI.
   * @param {object} ref   stable row descriptor
   * @param {object} slot  { dateISO, time24, date }
   * @param {{onStage?: Function}} opts onStage(name, value) reports every step for logging
   */
  async function scheduleRow(ref, slot, { onStage = () => {}, timing = true } = {}) {
    const rowNo = ref.index + 1;
    const label = `Row ${rowNo}`;
    const timer = timing ? createTimer(rowNo) : NO_TIMER;
    let row;
    try {
      row = await NS.row.acquireRow(ref);
    } catch (err) {
      timer.summary(false);
      throw fail(err, 'reacquire');
    }
    timer.mark('reacquire');
    onStage('reacquired', true);

    if (rowShowsSchedule(row.element, slot)) {
      log('SCHEDULE', `${label}: already shows ${slot.dateISO} ${slot.time24}`);
      onStage('already-scheduled', true);
      onStage('complete', true);
      timer.summary(true);
      return;
    }

    const opened = new Set(); // overlays this operation opened, for cleanup on failure
    try {
      // Normally one pass. A second pass only when starting the keyboard fallback (Chrome's
      // "debugging" bar) closed the popover mid-way; the keyboard is attached by then.
      let result;
      for (let pass = 1; ; pass++) {
        try {
          result = await configurePopover({ ref, row, slot, rowNo, label, opened, onStage, timer });
          break;
        } catch (err) {
          if (!err.restartRow || pass > 1) throw err;
          log('SCHEDULE', `[ROW ${rowNo}] popup closed when keyboard control started; opening it again`);
          await closeOpenedOverlays(opened);
          opened.clear();
          row = await NS.row.acquireRow(ref);
        }
      }
      const { scope, method } = result;

      // 9. press this popover's own Update button — never Facebook's final Publish
      const confirm = findConfirmButton(scope, findScheduleOption(scope)?.el);
      if (!confirm) {
        const offered = clickables(scope).map((el) => accessibleName(el)).filter(Boolean).slice(0, 6);
        throw fail(new ElementNotFoundError(`No Update button in the popup. It offered: ${offered.join(', ') || 'nothing readable'}`), 'update');
      }
      safeClick(confirm, { scopes: [scope], label: 'schedule Update button' });
      log('UPDATE', `[ROW ${rowNo}] clicked`);
      onStage('update-clicked', true);
      onStage('update', true);
      // Stop waiting the moment the popover closes or Facebook shows its error.
      const outcome = await waitFor(() => (!scope.isConnected || !isVisible(scope) ? 'closed' : NS.pageErrors.findErrorContainer() ? 'error' : null), {
        timeout: UPDATE_CLOSE_TIMEOUT,
        minInterval: 16,
        pollInterval: 100,
        observeAttributes: false
      });
      timer.mark('update-close');
      assertNoFacebookError('confirming the schedule');
      if (outcome !== 'closed') log('SCHEDULE', `${label}: popover stayed open after Update; verifying the row anyway`);

      // 10. verify — only now may the row count as scheduled
      const shows = () => {
        const el = currentRowElement(ref, row);
        return el && rowShowsSchedule(el, slot) ? el : null;
      };
      let verified = Boolean(
        shows() ||
          (await waitFor(shows, { timeout: ROW_VERIFY_TIMEOUT, minInterval: 50, pollInterval: 150, root: observeRootOf(row.element), attributeFilter: TAB_ATTRS }))
      );
      timer.mark('verify-row');
      if (!verified) {
        // The row may not print the schedule: ask Facebook by reopening its own popover.
        verified = await verifyByReopening(ref, slot);
        timer.mark('verify-reopen');
      }
      log('UPDATE', `[ROW ${rowNo}] success=${verified}`);
      if (!verified) {
        onStage('verified', false);
        throw fail(new VerificationError(`${label}: Facebook does not show ${slot.dateISO} ${slot.time24} for this row after Update`), 'verify');
      }
      onStage('verified', true);
      onStage('row-verified', true);
      onStage('complete', true);
      log('SCHEDULE', `${label}: schedule verified (Schedule tab via ${method})`);
      await closeOpenedOverlays(opened); // only one popover open at a time
      timer.mark('cleanup');
      timer.summary(true);
    } catch (err) {
      await closeOpenedOverlays(opened); // leave the page clean for the next row
      onStage('complete', false);
      timer.summary(false);
      throw err;
    }
  }

  /**
   * Steps 2–8 for one row: open the popup from "Publish now", make Schedule the active tab,
   * set and verify the date, then the time, and re-check both (and the Schedule tab) right
   * before Update may be pressed.
   * @returns {Promise<{scope: Element, method: string}>} the popup holding Update
   */
  async function configurePopover({ ref, row, slot, rowNo, label, opened, onStage, timer }) {
    // 2–4. click the row's "Publish now" control and wait for its popup
    let { overlay } = await openPopover(row, onStage);
    opened.add(overlay);
    timer.mark('open-popover');
    assertNoFacebookError('opening the scheduling popup');
    log('SCHEDULE', `[ROW ${rowNo}] popup opened`);

    // find the Schedule tab INSIDE this popup
    onStage('current-tab', currentTab(overlay));
    const option = findScheduleOption(overlay);
    onStage('schedule-tab-found', Boolean(option));
    if (!option) {
      const offered = clickables(overlay).map((el) => accessibleName(el)).filter(Boolean).slice(0, 6);
      throw fail(new ElementNotFoundError(`No "Schedule" tab in this row's popup. It offered: ${offered.join(', ') || 'nothing readable'}`), 'schedule-tab');
    }
    timer.mark('find-schedule-tab');

    // 5. ALWAYS make Schedule the active tab (direct click; keyboard only as fallback)
    onStage('tab-initial-selected', option.chosen);
    let method = 'already-selected';
    if (!option.chosen) {
      ({ overlay, method } = await activateScheduleTab({ overlay, option, row, rowNo, opened }, onStage, timer));
      opened.add(overlay);
    }
    onStage('tab-method', method);
    onStage('schedule-active', true);
    onStage('schedule-mode-verified', true);
    log('SCHEDULE', `[ROW ${rowNo}] schedule tab active (${method})`);

    // the date/time fields: this popup first, then a separate dialog it opened, then the row
    const locate = () => {
      const popover = reacquirePopover(overlay) || (overlay.isConnected ? overlay : null);
      const scopes = [popover, ...visibleMatches(DIALOG_SELECTOR).filter((o) => !opened.has(o) && !isInExtensionUi(o))];
      for (const scope of scopes) {
        if (scope?.isConnected) {
          const hit = findDateTimeInputs(scope);
          if (hit) return { scope, inputs: hit };
        }
      }
      return null;
    };
    let found = locate();
    if (!found) found = await waitFor(locate, { timeout: FIELDS_TIMEOUT, minInterval: 16, pollInterval: 100, root: observeRootOf(overlay), attributeFilter: TAB_ATTRS });
    if (!found) {
      const rowEl = currentRowElement(ref, row);
      const inRow = rowEl && findDateTimeInputs(rowEl);
      if (inRow) found = { scope: rowEl, inputs: inRow };
    }
    timer.mark('wait-fields');
    if (!found) {
      onStage('date-field-found', false);
      onStage('time-field-found', false);
      throw fail(new ElementNotFoundError('Date/time fields did not appear after selecting Schedule'), 'date-field');
    }
    if (found.scope !== overlay && found.scope.matches(OVERLAY_SELECTOR)) opened.add(found.scope);
    onStage('fields-visible', true);
    onStage('date-field-found', true);
    onStage('time-field-found', Boolean(found.inputs.time || found.inputs.spin.hour));

    // Fresh inputs on every read: React may re-render the popup and replace them.
    const fields = () => {
      const scope = found.scope.isConnected ? found.scope : reacquirePopover(overlay);
      return (scope && findDateTimeInputs(scope)) || null;
    };
    const lost = (kind) =>
      Object.assign(fail(new ElementNotFoundError(`The Schedule popup closed while setting the ${kind}`), `${kind}-field`), { restartRow: true });

    // 6–15. DATE
    const date = await setFieldVerified({
      tag: 'DATE',
      rowNo,
      getInput: () => fields()?.date || null,
      format: (input, current) => formatDateLike(input, current, slot),
      matches: (value, input) => sameDate(value, slot, numericDayFirst(input, value))
    }).catch((err) => {
      throw fields() ? err : lost('date');
    });
    onStage('date-set', `${slot.dateISO} (field: ${date.value}, ${date.method})`);
    timer.mark('set-date');

    // 16–25. TIME
    if (fields()?.time) {
      const time = await setFieldVerified({
        tag: 'TIME',
        rowNo,
        getInput: () => fields()?.time || null,
        format: (input, current) => formatTimeLike(input, current, slot),
        matches: (value) => sameTime(value, slot)
      }).catch((err) => {
        throw fields() ? err : lost('time');
      });
      onStage('time-set', `${slot.time24} (field: ${time.value}, ${time.method})`);
    } else {
      if (!fields()) throw lost('time');
      await setSpinTimeVerified(rowNo, () => fields()?.spin || null, slot);
      onStage('time-set', `${slot.time24} (spin buttons)`);
    }
    timer.mark('set-time');

    // 26. Update only after BOTH values read back correctly — checked again together, because
    // setting the time can make a date picker re-render — and Schedule is still the active tab.
    const now = fields();
    const bothOk = Boolean(now && fieldsMatch(now, slot));
    onStage('values-verified', bothOk);
    if (!bothOk) {
      const shown = now ? `date "${now.date.value}", time "${now.time ? now.time.value : spinText(now.spin)}"` : 'no fields';
      throw fail(new VerificationError(`${label}: the date/time changed after being set (${shown}; wanted ${slot.dateISO} ${slot.time24})`), 'values');
    }
    onStage('datetime-set', `${now.date.value} ${now.time ? now.time.value : spinText(now.spin)}`.trim());
    const scope = found.scope.matches(OVERLAY_SELECTOR) ? found.scope : reacquirePopover(overlay) || overlay;
    const stillSchedule = findScheduleOption(scope);
    if (stillSchedule && hasChoiceState(stillSchedule.el) && !stillSchedule.chosen) {
      throw fail(new VerificationError(`${label}: the popup switched back from Schedule before Update`), 'schedule-tab-activate');
    }
    return { scope, method };
  }

  NS.scheduler = { scheduleRow, releaseKeyboard, rowShowsSchedule, findDateTimeInputs, findRowControl, findPublishNowControl, parseDateValue, parseTimeValue, formatDateLike, formatTimeLike };
})();
