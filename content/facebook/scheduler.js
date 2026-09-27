/*
 * Per-row scheduling through Facebook's own UI.
 *
 *   reacquire row → open that row's scheduling control → wait for the popover
 *   → select the "Schedule" tab INSIDE THAT POPOVER (always, even when date/time
 *     fields are already on screen — Facebook shows them on the "Publish now" tab too,
 *     and filling them without switching tabs schedules nothing)
 *   → set date + time → read them back → press Update → verify the row is scheduled.
 *
 * Clicks are limited to the row and the overlay that appeared after our own click, and
 * all go through dom.safeClick (which refuses final Publish/Post buttons). Rows are
 * processed one at a time, and any popover left open is closed before the next row.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { log } = NS.logger;
  const { isVisible, accessibleName, fieldHints, safeClick, setNativeValue, pressEscape, isPopupTrigger, isForbiddenTarget, hasDropdownAffordance, normalize, textOf, CLICKABLE_SELECTOR } =
    NS.dom;
  const { waitFor, settle, visibleMatches, MENU_SELECTOR, DIALOG_SELECTOR } = NS.wait;
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
  const MODE_SELECTOR_RE = /publish now|post now|share now|এখনই প্রকাশ/; // the row's publish-mode selector
  // What the row calls its scheduling dropdown. "Publish now" is deliberately NOT here: it is
  // the current mode shown on (or next to) that dropdown, and on its own it may publish.
  const SCHEDULING_CONTROL_RE =
    /^(scheduling( and editing)? options?|schedule options?|scheduling|publishing options?|edit schedule|সময়সূচির বিকল্প|শিডিউলিং অপশন)(?=$|[\s,.:–-])/;
  const NAMED_SELECTOR = '[aria-label], [aria-labelledby], [title], button, [role="button"], [role="combobox"], [aria-haspopup]';
  const OPENER_CHILD_SELECTOR = '[role="combobox"], [aria-haspopup], button, [role="button"]';
  const MAX_OPEN_TARGETS = 3;
  const SCHEDULED_MARKER_RE = /schedul|সময়সূচি|শিডিউল/;
  const DATE_HINT_RE = /date|mm\/dd|dd\/mm|yyyy|তারিখ/;
  const TIME_HINT_RE = /(^|[^a-z])time|hh:mm|সময়/;

  const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const MONTHS_BN = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];
  const pad = (n) => String(n).padStart(2, '0');
  const bengaliToAscii = (s) => s.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));

  function assertNoFacebookError(step) {
    if (NS.pageErrors.findErrorContainer()) throw new FacebookTransientError(`Facebook reported an error during: ${step}`);
  }

  /** Tag an error with the scheduling step that failed, for the panel and the logs. */
  function fail(err, step) {
    if (!err.step) err.step = step;
    return err;
  }

  const snapshotOverlays = () => new Set(visibleMatches(OVERLAY_SELECTOR));

  function clickables(scope) {
    return [...scope.querySelectorAll(CLICKABLE_SELECTOR)].filter((el) => isVisible(el) && !isForbiddenTarget(el));
  }

  /**
   * The row's own "Scheduling options" control, and what to click to open it.
   * Order of preference, all scoped to this row:
   *   1. an element the row itself NAMES as its scheduling dropdown (aria-label/title/text
   *      "Scheduling options") — then its own interactive children, since Facebook often
   *      binds the handler to an inner node
   *   2. a control named Schedule / Publish later
   *   3. a dropdown trigger (aria-haspopup / combobox) whose name is not a publish action
   * The row's "Publish now" button is never used on its own to open anything — it can be
   * a publish action, and it is not what opens this popover.
   * @returns {{el: Element, targets: Element[], mode: string}}
   */
  function findRowControl(rowEl) {
    const candidates = [...rowEl.querySelectorAll(NAMED_SELECTOR)].filter(isVisible);

    const named = candidates.find((el) => SCHEDULING_CONTROL_RE.test(accessibleName(el)) && !isForbiddenTarget(el));
    if (named) {
      const targets = [named];
      for (const child of named.querySelectorAll(OPENER_CHILD_SELECTOR)) {
        if (isVisible(child) && !targets.includes(child)) targets.push(child);
      }
      return { el: named, targets: targets.slice(0, MAX_OPEN_TARGETS), mode: describeMode(named) };
    }

    const safe = candidates.filter((el) => !isForbiddenTarget(el) && !MODE_SELECTOR_RE.test(accessibleName(el)));
    const direct = safe.find((el) => SCHEDULE_OPTION_RE.test(accessibleName(el)));
    if (direct) return { el: direct, targets: [direct], mode: describeMode(direct) };

    const dropdown = safe.find((el) => isPopupTrigger(el) && TRIGGER_RE.test(accessibleName(el)));
    if (dropdown) return { el: dropdown, targets: [dropdown], mode: describeMode(dropdown) };

    const names = candidates.map((el) => accessibleName(el)).filter(Boolean);
    const seen = [...new Set(names)].slice(0, 8).map((n) => `"${n.slice(0, 40)}"`);
    throw fail(
      new ElementNotFoundError(
        `No "Scheduling options" control found in this row (the row's "Publish now" button is never used to open scheduling). ` +
          `Controls found: ${seen.length ? seen.join(', ') : 'none'}. Run "Debug Facebook" and send the output.`
      ),
      'control'
    );
  }

  /** The mode the row currently shows (e.g. "publish now"), for the logs only. */
  function describeMode(control) {
    for (const scope of [control, control.parentElement]) {
      if (!scope) continue;
      const shown = [...scope.querySelectorAll('span, div')].find((el) => !el.children.length && MODE_SELECTOR_RE.test(normalize(el.textContent)));
      if (shown) return normalize(shown.textContent);
    }
    return accessibleName(control);
  }

  /**
   * Reacquire the row, click its Scheduling options control and return the popover that
   * appeared — only once it is actually visible. Tries the control, then its interactive
   * children, and never anything outside that control.
   * @returns {Promise<{overlay: Element, control: object}>}
   */
  async function openSchedulingPopover(ref, onStage = () => {}) {
    const row = await NS.row.acquireRow(ref);
    let control;
    try {
      control = findRowControl(row.element);
    } catch (err) {
      onStage('control-found', false);
      throw err;
    }
    onStage('control-found', true);
    onStage('current-mode', control.mode);

    for (const target of control.targets) {
      if (!target.isConnected) continue;
      const before = snapshotOverlays();
      try {
        // An inner "Publish now ⌄" is acceptable ONLY here: it is part of the dropdown the row
        // names "Scheduling options", not a free-standing publish button.
        safeClick(target, {
          scopes: [control.el],
          label: 'Scheduling options control',
          allowModeSelector: target !== control.el && control.el.contains(target)
        });
      } catch {
        continue;
      }
      onStage('control-clicked', true);
      const overlay = await waitFor(() => visibleMatches(OVERLAY_SELECTOR).find((el) => !before.has(el) && isVisible(el)) || null, {
        timeout: 2500
      });
      if (overlay) {
        onStage('popover-visible', true);
        onStage('popover-opened', true);
        return { overlay, control };
      }
    }
    onStage('popover-visible', false);
    throw fail(new ElementNotFoundError(`The row's "Scheduling options" control did not open its popover`), 'popover');
  }

  /** True when a tab/option is the currently chosen one. */
  function isChosen(el) {
    for (const attr of ['aria-selected', 'aria-checked', 'aria-pressed', 'data-selected']) {
      if (el.getAttribute(attr) === 'true') return true;
    }
    return el.tagName === 'INPUT' && el.checked === true;
  }

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

  /** Style fingerprint, so a tab that carries no aria state can still be seen to change. */
  function tabLook(el) {
    const st = getComputedStyle(el);
    return [st.backgroundColor, st.color, st.fontWeight, st.borderBottomColor, st.boxShadow].join('|');
  }

  /** Everything needed to tell whether the tab really became the active one. */
  function tabState(overlay, tabEl) {
    return {
      chosen: tabEl.hasAttribute('aria-selected') || tabEl.hasAttribute('aria-checked') ? isChosen(tabEl) : null,
      look: tabLook(tabEl),
      fields: Boolean(findDateTimeInputs(overlay)),
      othersChosen: [...overlay.querySelectorAll('[role="tab"], [role="radio"], [role="option"], [role="menuitemradio"]')].filter(
        (el) => el !== tabEl && isChosen(el)
      ).length
    };
  }

  /**
   * Did the tab actually become active? aria state first (definitive), then the loss of
   * another tab's selection, then a visual change, then date/time fields that were absent
   * before and are present now.
   */
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
    const chosen = [...overlay.querySelectorAll('[role="tab"], [role="radio"], [role="option"], [role="menuitemradio"]')]
      .filter(isVisible)
      .find(isChosen);
    return chosen ? accessibleName(chosen) : '(unknown)';
  }

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

  function formatDate(input, slot) {
    if (input.type === 'date') return slot.dateISO;
    const d = slot.date;
    const monthName = MONTHS_EN[d.getMonth()].replace(/^./, (c) => c.toUpperCase());
    const current = input.value || '';
    // Facebook's popover shows a long date ("28 September 2026"); mirror whatever shape it uses.
    if (/^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(current)) return `${d.getDate()} ${monthName} ${d.getFullYear()}`;
    if (/^[A-Za-z]{3,}\s+\d{1,2},?\s+\d{4}$/.test(current)) return `${monthName} ${d.getDate()}, ${d.getFullYear()}`;
    const hint = fieldHints(input) + ' ' + current;
    if (/yyyy-mm-dd/.test(hint) || /^\d{4}-\d{2}-\d{2}$/.test(input.value)) return slot.dateISO;
    const existing = /^(\d{1,2})\/(\d{1,2})\/\d{4}$/.exec(input.value || '');
    const dayFirst = /dd\/mm/.test(hint) || (existing && Number(existing[1]) > 12);
    return dayFirst ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
  }

  function to12h(d) {
    const h = d.getHours() % 12 || 12;
    return { h, mm: pad(d.getMinutes()), ampm: d.getHours() < 12 ? 'AM' : 'PM' };
  }

  function formatTime(input, slot) {
    if (input.type === 'time') return slot.time24;
    const hint = fieldHints(input) + ' ' + (input.value || '');
    const existing24 = /^([01]\d|2[0-3]):\d{2}$/.exec(input.value || '');
    if (existing24 && !/am|pm/.test(hint)) return slot.time24;
    const { h, mm, ampm } = to12h(slot.date);
    return `${h}:${mm} ${ampm}`;
  }

  function typeInto(el, str) {
    el.focus();
    for (const ch of str) {
      const opts = { key: ch, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }
  }

  /** @returns {{date: string, time: string}} the values as the fields actually read back */
  function fillDateTime(inputs, slot) {
    setNativeValue(inputs.date, formatDate(inputs.date, slot));
    inputs.date.blur();
    if (inputs.time) {
      setNativeValue(inputs.time, formatTime(inputs.time, slot));
      inputs.time.blur();
      return { date: inputs.date.value, time: inputs.time.value };
    }
    {
      const { h, mm, ampm } = to12h(slot.date);
      typeInto(inputs.spin.hour, String(inputs.spin.meridiem ? h : slot.date.getHours()));
      typeInto(inputs.spin.minute, mm);
      if (inputs.spin.meridiem) typeInto(inputs.spin.meridiem, ampm[0]);
      return { date: inputs.date.value, time: `${inputs.spin.hour.textContent || ''}:${inputs.spin.minute.textContent || ''}`.trim() };
    }
  }

  function timeVariants(slot) {
    const { h, mm, ampm } = to12h(slot.date);
    const a = ampm.toLowerCase();
    return [`${h}:${mm} ${a}`, `${h}:${mm}${a}`, slot.time24, `${slot.date.getHours()}:${mm}`];
  }

  function dateVariants(slot, now = new Date()) {
    const d = slot.date;
    const [dd, m, y] = [d.getDate(), d.getMonth(), d.getFullYear()];
    const en = MONTHS_EN[m];
    const out = [
      `${en.slice(0, 3)} ${dd}`, `${en} ${dd}`, `${dd} ${en.slice(0, 3)}`, `${dd} ${en}`,
      `${m + 1}/${dd}/${y}`, `${pad(m + 1)}/${pad(dd)}/${y}`, `${dd}/${m + 1}/${y}`, `${pad(dd)}/${pad(m + 1)}/${y}`,
      slot.dateISO, `${dd} ${MONTHS_BN[m]}`, `${MONTHS_BN[m]} ${dd}`
    ];
    const dayDiff = Math.round((new Date(y, m, dd) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    if (dayDiff === 0) out.push('today', 'আজ');
    if (dayDiff === 1) out.push('tomorrow', 'আগামীকাল');
    return out;
  }

  /**
   * Close only overlays this operation opened: prefer their own Cancel/Close button,
   * else Escape on the overlay itself. Never a page-level Escape (it could close the
   * whole bulk-upload composer).
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
      await settle(150);
    }
  }

  /**
   * Real verification: the row must actually show the intended time, either in its own
   * date/time inputs or in its text (with the date, or with a "Scheduled" marker).
   * A click alone never counts as scheduled.
   */
  function rowShowsSchedule(rowEl, slot) {
    const inline = findDateTimeInputs(rowEl);
    if (inline) {
      const dateOk = inline.date.value === formatDate(inline.date, slot);
      const timeOk = inline.time ? inline.time.value === formatTime(inline.time, slot) : true;
      if (dateOk && timeOk) return true;
    }
    const text = bengaliToAscii(normalize(textOf(rowEl, 3000)));
    if (!timeVariants(slot).some((t) => text.includes(t))) return false;
    return dateVariants(slot).some((v) => text.includes(v)) || SCHEDULED_MARKER_RE.test(text);
  }

  const MAX_TAB_PRESSES = 15;
  const KEY_MARKER = 'data-fbra-kbd-target'; // must match background/keyboard.js

  /** A real key press from the service worker; a failure stops this row with step "keyboard". */
  async function realKey(key) {
    try {
      await NS.bridge.pressKey(key);
    } catch (err) {
      throw fail(new ElementNotFoundError(`Keyboard: ${err.message}`), 'keyboard');
    }
  }

  /** The popover again, after a React update: the same node if still shown, else the visible one offering "Schedule". */
  function reacquirePopover(previous) {
    if (previous && previous.isConnected && isVisible(previous)) return previous;
    return visibleMatches(OVERLAY_SELECTOR).find((el) => findScheduleOption(el)) || null;
  }

  function selectedTab(overlay) {
    return [...overlay.querySelectorAll('[role="tab"], [role="radio"], [role="option"], [role="menuitemradio"], [role="menuitem"]')]
      .filter(isVisible)
      .find(isChosen);
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
   * Move keyboard focus to the Schedule tab with REAL key presses (sent by the service
   * worker through chrome.debugger — the browser ignores script-made Tab keys), checking
   * after every press which element has focus. Never a fixed number of presses and never a
   * click on the tab.
   *   1. focus the currently selected tab ("Publish now") — focus only, nothing is activated
   *   2. Tab until the focused element is the Schedule tab (stops if focus leaves the popover)
   *   3. tab lists with a roving tabindex skip unselected tabs on Tab: use the arrow keys
   */
  async function focusScheduleTab(overlay) {
    let { popover, option } = freshScheduleOption(overlay);
    const start = selectedTab(popover) || popover.querySelector('[role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"]), button');
    start?.focus?.({ preventScroll: true });
    await settle(100);
    ({ popover, option } = freshScheduleOption(popover));
    if (focusIsOn(option.el)) return { popover, option, presses: 'already focused' };

    for (let n = 1; n <= MAX_TAB_PRESSES; n++) {
      await realKey('Tab');
      await settle(120);
      ({ popover, option } = freshScheduleOption(popover));
      if (focusIsOn(option.el)) return { popover, option, presses: `Tab ×${n}` };
      if (!popover.contains(document.activeElement)) break; // focus left the popover: stop tabbing
    }

    const arrow = /menuitem|option/.test(option.el.getAttribute('role') || '') ? 'ArrowDown' : 'ArrowRight';
    const tabs = popover.querySelectorAll('[role="tab"], [role="radio"], [role="option"], [role="menuitemradio"], [role="menuitem"]').length || 3;
    (selectedTab(popover) || start)?.focus?.({ preventScroll: true });
    for (let n = 1; n <= tabs; n++) {
      await realKey(arrow);
      await settle(120);
      ({ popover, option } = freshScheduleOption(popover));
      if (focusIsOn(option.el)) return { popover, option, presses: `${arrow} ×${n}` };
    }
    throw fail(new ElementNotFoundError('Schedule tab could not be focused with the keyboard'), 'schedule-tab-focus');
  }

  /**
   * Make the Schedule tab the active one with the keyboard, and prove it:
   * focus it (real Tab presses), confirm focus is on it, press a real Enter (Space once as a
   * retry), then wait until the tab is selected AND the date/time fields are shown.
   * @returns {Promise<Element>} the popover to keep working in
   */
  async function activateScheduleTab(overlay, onStage) {
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
      const active = await waitFor(
        () => {
          // A menu-style chooser closes and opens a separate date/time dialog instead
          // (its fields are checked in the next step, like the popover's).
          const fresh = reacquirePopover(popover); // same popover, or its re-rendered copy
          const now = fresh && findScheduleOption(fresh);
          if (now && (now.chosen || becameActive(before, tabState(fresh, now.el)))) return fresh;
          if (popover.isConnected && isVisible(popover)) return null;
          return visibleMatches(DIALOG_SELECTOR).find((o) => !findScheduleOption(o)) || null;
        },
        { timeout: 2500, minInterval: 150 }
      );
      assertNoFacebookError('selecting the Schedule tab');
      if (active) return active;
      overlay = reacquirePopover(popover) || popover;
    }
    throw fail(new ElementNotFoundError('Schedule tab could not be activated'), 'schedule-tab-activate');
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
      const dateOk = inputs.date.value === formatDate(inputs.date, slot);
      const timeOk = !inputs.time || inputs.time.value === formatTime(inputs.time, slot);
      return dateOk && timeOk;
    } catch {
      return false;
    } finally {
      if (overlay) await closeOpenedOverlays(new Set([overlay]));
    }
  }

  /**
   * Schedule one row through Facebook's own UI.
   * @param {object} ref   stable row descriptor
   * @param {object} slot  { dateISO, time24, date }
   * @param {{onStage?: Function}} opts onStage(name, value) reports every step for logging
   */
  async function scheduleRow(ref, slot, { onStage = () => {} } = {}) {
    const label = `Row ${ref.index + 1}`;
    let row;
    try {
      row = await NS.row.acquireRow(ref);
    } catch (err) {
      throw fail(err, 'reacquire');
    }
    onStage('reacquired', true);

    if (rowShowsSchedule(row.element, slot)) {
      log('SCHEDULE', `${label}: already shows ${slot.dateISO} ${slot.time24}`);
      onStage('already-scheduled', true);
      onStage('complete', true);
      return;
    }

    const opened = new Set(); // overlays this operation opened, for cleanup on failure
    try {
      // 1. open the row's "Scheduling options" popover (reacquires the row first)
      let { overlay } = await openSchedulingPopover(ref, onStage);
      opened.add(overlay);
      assertNoFacebookError('opening the scheduling options');

      // 2. ALWAYS select the Schedule tab inside this popover first.
      //    Facebook shows the date/time fields on the "Publish now" tab as well, so finding
      //    them proves nothing: without this click the row stays on Publish now.
      onStage('current-tab', currentTab(overlay));

      const option = findScheduleOption(overlay);
      onStage('schedule-tab-found', Boolean(option));
      if (!option) {
        const offered = clickables(overlay)
          .map((el) => accessibleName(el))
          .filter(Boolean)
          .slice(0, 6);
        throw fail(
          new ElementNotFoundError(`No "Schedule" tab in this row's popover. It offered: ${offered.join(', ') || 'nothing readable'}`),
          'schedule-tab'
        );
      }

      onStage('tab-initial-selected', option.chosen);
      if (!option.chosen) {
        overlay = await activateScheduleTab(overlay, onStage);
        opened.add(overlay);
      }
      onStage('schedule-active', true);
      onStage('schedule-mode-verified', true);

      // 3. wait for the date/time fields of this popover (or, in some layouts, of the row)
      const found = await waitFor(() => {
        const fresh = NS.row.resolveRow(ref);
        for (const scope of [overlay, ...visibleMatches(OVERLAY_SELECTOR), fresh?.element]) {
          if (scope && scope.isConnected) {
            const hit = findDateTimeInputs(scope);
            if (hit) return { scope, inputs: hit };
          }
        }
        return null;
      }, { minInterval: 200 });
      if (!found) {
        onStage('date-field-found', false);
        onStage('time-field-found', false);
        throw fail(new ElementNotFoundError('Date/time fields did not appear after selecting Schedule'), 'date-field');
      }
      if (found.scope !== overlay && found.scope.matches(OVERLAY_SELECTOR)) opened.add(found.scope);
      const inputs = found.inputs;
      onStage('fields-visible', true);
      onStage('date-field-found', true);
      onStage('time-field-found', Boolean(inputs.time || inputs.spin.hour));

      // 4. set date and time, then read the fields back
      const wanted = { date: formatDate(inputs.date, slot), time: inputs.time ? formatTime(inputs.time, slot) : '' };
      fillDateTime(inputs, slot);
      await settle(300);
      assertNoFacebookError('setting date/time');
      onStage('date-set', `${slot.dateISO} (field: ${inputs.date.value})`);
      onStage('time-set', `${slot.time24}${inputs.time ? ` (field: ${inputs.time.value})` : ''}`);

      const dateOk = inputs.date.value === wanted.date;
      const timeOk = !inputs.time || inputs.time.value === wanted.time;
      onStage('values-verified', dateOk && timeOk);
      if (dateOk && timeOk) onStage('datetime-set', `${inputs.date.value} ${inputs.time ? inputs.time.value : ''}`.trim());
      if (!dateOk || !timeOk) {
        throw fail(
          new VerificationError(
            `${label}: the fields did not keep the values (date "${inputs.date.value}" wanted "${wanted.date}"` +
              `${inputs.time ? `, time "${inputs.time.value}" wanted "${wanted.time}"` : ''})`
          ),
          'values'
        );
      }
      log('SCHEDULE', `${label}: date/time configured (${slot.dateISO} ${slot.time24})`);

      // 5. press this popover's own Update/Save button — never Facebook's final Publish
      const scope = found.scope.matches(OVERLAY_SELECTOR) ? found.scope : overlay;
      const confirm = findConfirmButton(scope, option.el);
      if (!confirm) {
        const offered = clickables(scope).map((el) => accessibleName(el)).filter(Boolean).slice(0, 6);
        throw fail(new ElementNotFoundError(`No Update/Save button in the popover. It offered: ${offered.join(', ') || 'nothing readable'}`), 'update');
      }
      safeClick(confirm, { scopes: [scope], label: 'schedule Update button' });
      onStage('update-clicked', true);
      onStage('update', true);
      // Stop waiting the moment Facebook shows its error, instead of clicking on.
      const outcome = await waitFor(() =>
        !scope.isConnected || !isVisible(scope) ? 'closed' : NS.pageErrors.findErrorContainer() ? 'error' : null
      );
      assertNoFacebookError('confirming the schedule');
      if (outcome !== 'closed') log('SCHEDULE', `${label}: popover stayed open after Update; verifying the row anyway`);

      // 6. verify — only now may the row count as scheduled
      await settle(500);
      row = await NS.row.acquireRow(ref);
      let verified = rowShowsSchedule(row.element, slot);
      if (!verified) {
        // The row may not print the schedule: ask Facebook by reopening its own popover.
        verified = await verifyByReopening(ref, slot);
      }
      if (!verified) {
        onStage('verified', false);
        throw fail(new VerificationError(`${label}: Facebook does not show ${slot.dateISO} ${slot.time24} for this row after Update`), 'verify');
      }
      onStage('verified', true);
      onStage('row-verified', true);
      onStage('complete', true);
      log('SCHEDULE', `${label}: schedule verified`);
      await closeOpenedOverlays(opened); // only one popover open at a time
    } catch (err) {
      await closeOpenedOverlays(opened); // leave the page clean for the next row
      onStage('complete', false);
      throw err;
    }
  }

  NS.scheduler = { scheduleRow, rowShowsSchedule, findDateTimeInputs, findRowControl };
})();
