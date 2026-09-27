/*
 * Real keyboard input for the scheduler, through chrome.debugger (Input.dispatchKeyEvent).
 *
 * Facebook's React tabs do not reliably react to script-dispatched clicks, and keyboard
 * events created by a script are "untrusted": the browser never moves focus for a
 * synthetic Tab. Key presses sent through the debugger are trusted, exactly like a user's.
 *
 * Safety:
 *   - only Tab, Enter, Space and the arrow keys can be sent
 *   - Enter/Space (the keys that activate things) are refused unless the focused element is
 *     inside the element the content script marked as the verified "Schedule" tab —
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
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }
  };
  const ACTIVATING = new Set(['Enter', 'Space']);
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
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    const target = { tabId };
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', k.text ? { type: 'keyDown', ...base, text: k.text, unmodifiedText: k.text } : { type: 'rawKeyDown', ...base });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async function release(tabId) {
    if (!attached.has(tabId)) return;
    attached.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  NS.keyboard = { press, attach, release, MARKER };
})();
