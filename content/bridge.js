/*
 * Messaging to the service worker. The content script never holds the API key.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});

  class BridgeError extends Error {
    constructor({ message, status = 0, permanent = false }) {
      super(message);
      this.name = 'BridgeError';
      this.status = status;
      this.permanent = permanent;
    }
  }

  async function send(type, payload = {}) {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type, ...payload });
    } catch (err) {
      const invalidated = /context invalidated/i.test(String(err?.message));
      throw new BridgeError({
        message: invalidated ? 'The extension was reloaded. Refresh this Facebook tab.' : `Extension messaging failed: ${err?.message || err}`,
        permanent: true
      });
    }
    if (!response) throw new BridgeError({ message: 'No response from the extension background.', permanent: true });
    if (!response.ok) throw new BridgeError(response.error);
    return response.data;
  }

  NS.bridge = {
    BridgeError,
    getPublicSettings: () => send('GET_PUBLIC_SETTINGS'),
    saveScheduleSettings: (values) => send('SAVE_SCHEDULE_SETTINGS', { values }),
    checkGenerationReady: () => send('CHECK_GENERATION_READY'),
    // Resolves to { text, provider, model }; failover happens entirely in the worker.
    generateDescription: (reel) => send('GENERATE_DESCRIPTION', { reel }),
    refreshModels: (provider) => send('REFRESH_MODELS', { provider }),
    getAiHealth: () => send('GET_AI_HEALTH'),
    openOptions: () => send('OPEN_OPTIONS'),
    // Trusted key presses for the scheduler (Tab/arrows move focus; Enter, Ctrl+A and typing only on the marked target).
    attachKeyboard: () => send('KEYBOARD_ATTACH'),
    pressKey: (key) => send('KEY_PRESS', { key }),
    typeText: (text) => send('KEY_TYPE', { text }),
    releaseKeyboard: () => send('KEYBOARD_RELEASE')
  };
})();
