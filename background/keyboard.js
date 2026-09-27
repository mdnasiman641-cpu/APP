/*
 * Real keyboard input for the scheduler, through chrome.debugger (Input.dispatchKeyEvent).
 *
 * Facebook's React tabs do not reliably react to script-dispatched clicks, and keyboard
 * events created by a script are "untrusted": the browser never moves focus for a
 * synthetic Tab. Key presses sent through the debugger are trusted, exactly like a user's.
 *
 * Safety:
 *   - only Tab, Enter, Space, the arrow keys, Ctrl+A and short date/time text can be sent
 *   - Enter/Space (the keys that activate things), Ctrl+A and typed text are refused unless the
 *     focused element is inside the element the content script marked as the verified target
 *     (the "Schedule" tab, or the popover's own date/time input) —
 *     so an activating key can never land on "Publish now", "Update" or the final Publish
 *   - only for the tab the request came from; detached when the scheduling phase ends
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});

  const KEYS = {
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    // Ctrl+A; the explicit editing command makes it select-all on every platform.
    SelectAll: { key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2, commands: ['selectAll'] }
  };
  const ACTIVATING = new Set(['Enter', 'Space', 'SelectAll']); // only on the marked target
  const TYPE_RE = /^[0-9A-Za-z ,:/.-]{1,40}$/; // dates and times only
  const MARKER = 'data-fbra-kbd-target';
  const attached = new Set();

  chrome.debugger.onDetach.addListener((source) => attached.delete(source.tabId));

  async function attach(tabId) {
    if (attached.has(tabId)) return;
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (err) {
      if (!/already attached/i.test(String(err?.message))) {
        throw new Error(`Keyboard control is unavailable in this tab (${err?.message || err}). Close DevTools/other debugging extensions and try again.`);
      }
    }
    attached.add(tabId);
  }

  async function focusIsOnMarkedTarget(tabId) {
    const { result } = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `Boolean(document.activeElement && document.activeElement.closest('[${MARKER}]'))`,
      returnByValue: true
    });
    return result?.value === true;
  }

  async function press(tabId, name) {
    const k = KEYS[name];
    if (!k) throw new Error(`Key "${name}" is not allowed`);
    await attach(tabId);
    if (ACTIVATING.has(name) && !(await focusIsOnMarkedTarget(tabId))) {
      throw new Error(`Refused to press ${name}: keyboard focus is not on the verified Schedule tab`);
    }
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers || 0 };
    const target = { tabId };
    const down = k.text ? { type: 'keyDown', ...base, text: k.text, unmodifiedText: k.text } : { type: 'rawKeyDown', ...base };
    if (k.commands) down.commands = k.commands;
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', down);
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** Type a short date/time string one real key at a time, into the marked field only. */
  async function type(tabId, text) {
    if (!TYPE_RE.test(String(text || ''))) throw new Error('Only short date/time text can be typed');
    await attach(tabId);
    if (!(await focusIsOnMarkedTarget(tabId))) throw new Error('Refused to type: keyboard focus is not on the verified date/time field');
    const target = { tabId };
    for (const ch of text) {
      const upper = ch.toUpperCase();
      const keyCode = /[0-9A-Z]/.test(upper) ? upper.charCodeAt(0) : ch === ' ' ? 32 : 0;
      const code = /[0-9]/.test(ch) ? `Digit${ch}` : /[A-Za-z]/.test(ch) ? `Key${upper}` : ch === ' ' ? 'Space' : '';
      const base = { key: ch, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: ch, unmodifiedText: ch });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }
  }

  async function release(tabId) {
    if (!attached.has(tabId)) return;
    attached.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  NS.keyboard = { press, type, attach, release, MARKER };
})();
