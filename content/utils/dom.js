/*
 * DOM helpers: visibility, accessible names, text normalisation and the
 * publish-safety click guard. Every click the extension performs goes through safeClick().
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { SafetyError, ElementNotFoundError } = NS.errors;

  const ROOT_ID = 'fb-bulk-reel-assistant-root';
  const UI_ATTR = 'data-fbra-ui'; // marks every extension-owned node (panel, row buttons)
  const CLICKABLE_SELECTOR =
    'button, [role="button"], [role="combobox"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], [role="tab"], [aria-haspopup], input[type="radio"], label';

  // Final-action buttons the extension must never click. Menu/dropdown triggers are exempt
  // because clicking them only opens a menu.
  const FORBIDDEN_NAMES = [
    /^(final\s+)?(publish|post|share)(\s+(now|all|reels?|videos?))?$/,
    /^(publish|post|share|schedule)\s+(all|\d+)\b/,
    /^(এখনই\s+)?প্রকাশ\s+করুন$/,
    /^পোস্ট\s+করুন$/,
    /^শেয়ার\s+করুন$/
  ];

  function normalize(text) {
    return String(text || '')
      .normalize('NFC')
      .replace(/[​-‍﻿]/g, '')
      .replace(/[’‘]/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isInExtensionUi(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return Boolean(el && el.closest && el.closest(`#${ROOT_ID}, [${UI_ATTR}]`));
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function textOf(el, max = 200) {
    return String(el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function labelledByText(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return ids.map((id) => textOf(document.getElementById(id))).join(' ').trim();
  }

  /** Approximation of the accessible name. */
  function accessibleName(el) {
    if (!el) return '';
    const name =
      el.getAttribute('aria-label') ||
      labelledByText(el) ||
      (el.labels && el.labels[0] ? textOf(el.labels[0]) : '') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('alt') ||
      textOf(el);
    return normalize(name);
  }

  /** Placeholder/label/title/nearby text describing an editable field. */
  function fieldHints(el) {
    const parts = [
      el.getAttribute('placeholder'),
      el.getAttribute('aria-placeholder'),
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-placeholder'),
      labelledByText(el)
    ];
    // Nearby text: first short ancestor text that is not just the field's own content.
    const own = textOf(el, 2000);
    let node = el.parentElement;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      const text = textOf(node, 400).replace(own, '').trim();
      if (text && text.length <= 200) {
        parts.push(text);
        break;
      }
    }
    return normalize(parts.filter(Boolean).join(' | '));
  }

  function isEditable(el) {
    return el.isContentEditable === true || ['true', ''].includes(el.getAttribute('contenteditable'));
  }

  /**
   * A small decorative child (chevron/caret) — the usual sign that a control opens a menu
   * even when it carries no aria-haspopup, which is common in Facebook's own markup.
   */
  function hasDropdownAffordance(el) {
    for (const child of el.querySelectorAll('svg, i, img, span[aria-hidden="true"], div[aria-hidden="true"]')) {
      if (child.getAttribute('aria-hidden') === 'false') continue;
      const r = child.getBoundingClientRect();
      if (r.width > 0 && r.width <= 28 && r.height > 0 && r.height <= 28) return true;
      if (child.tagName === 'SVG' || child.tagName === 'I') return true; // not laid out in tests/hidden states
    }
    return false;
  }

  function isPopupTrigger(el) {
    const hasPopup = el.getAttribute('aria-haspopup');
    return (
      (hasPopup !== null && hasPopup !== 'false') ||
      el.hasAttribute('aria-expanded') ||
      el.getAttribute('role') === 'combobox'
    );
  }

  function isForbiddenTarget(el) {
    if (isPopupTrigger(el)) return false;
    const name = accessibleName(el);
    return FORBIDDEN_NAMES.some((re) => re.test(name));
  }

  function isDisabled(el) {
    return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  }

  /**
   * The only click primitive. Refuses final publish controls and anything outside the
   * allowed scopes (the current row and overlays opened from it).
   */
  function safeClick(el, { scopes = [], label = 'element', allowModeSelector = false } = {}) {
    if (!el || !el.isConnected) throw new ElementNotFoundError(`${label} is no longer on the page`);
    if (isInExtensionUi(el)) throw new SafetyError(`Refused to click extension UI as ${label}`);
    // allowModeSelector: a row's publish-MODE selector (e.g. "Publish now ⌄") whose only job is to
    // open a menu. Granted by the scheduler only after it has checked the control shows a dropdown
    // affordance and sits inside the current row, and it must be scoped; everything else still refuses.
    const forbidden = isForbiddenTarget(el) && !(allowModeSelector && scopes.length && hasDropdownAffordance(el));
    if (forbidden) throw new SafetyError(`Refused to click "${accessibleName(el)}": final publishing is manual`);
    if (scopes.length && !scopes.some((scope) => scope && scope.contains(el))) {
      throw new SafetyError(`Refused to click ${label}: outside the current row/menu`);
    }
    if (isDisabled(el)) throw new ElementNotFoundError(`${label} is disabled`);

    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    // A full primary-button sequence: some handlers ignore events without button/buttons/detail.
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, detail: 1, button: 0 };
    const pointer = { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 };
    const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Pointer('pointerover', pointer));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new Pointer('pointerdown', { ...pointer, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...opts, buttons: 1 }));
    el.focus?.();
    el.dispatchEvent(new Pointer('pointerup', pointer));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  /** Keyboard activation, for controls that only respond to Enter/Space. */
  function pressKey(el, key = 'Enter') {
    const opts = { key, code: key === ' ' ? 'Space' : key, keyCode: key === 'Enter' ? 13 : 32, bubbles: true, cancelable: true, composed: true };
    el.focus?.();
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /** Set a React-controlled input/textarea value so React notices. */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Escape dispatched on a specific element (an overlay we opened), never at page level. */
  function pressEscape(target) {
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  NS.dom = {
    ROOT_ID,
    UI_ATTR,
    CLICKABLE_SELECTOR,
    normalize,
    isInExtensionUi,
    isVisible,
    textOf,
    accessibleName,
    fieldHints,
    isEditable,
    hasDropdownAffordance,
    isPopupTrigger,
    isForbiddenTarget,
    safeClick,
    pressKey,
    setNativeValue,
    pressEscape
  };
})();
