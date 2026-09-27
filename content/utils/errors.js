/*
 * Error types that drive row-level recovery decisions.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});

  class FbraError extends Error {
    constructor(message) {
      super(message);
      this.name = this.constructor.name;
    }
  }
  /** The row could not be found again after waiting. */
  class RowMissingError extends FbraError {}
  /** Several reels match the row's identity; touching any of them could hit the wrong reel. */
  class RowAmbiguousError extends FbraError {}
  /** Facebook displayed its own "having trouble" error. Retry once. */
  class FacebookTransientError extends FbraError {}
  /** A control/menu/field we need is not there. */
  class ElementNotFoundError extends FbraError {}
  /** We wrote something but could not read it back. `changed`: the field was modified anyway. */
  class VerificationError extends FbraError {
    constructor(message, { changed = true } = {}) {
      super(message);
      this.changed = changed;
    }
  }
  /** Facebook replaced the whole page with its error screen. The batch must stop. */
  class PageCrashedError extends FbraError {
    constructor() {
      super(
        'Facebook\'s page crashed ("We\'re having trouble completing your request."). The batch was stopped. Reload the page, check your uploads, then run Generate All again.'
      );
    }
  }
  /** A click was refused by the publish-safety guard. Never retried. */
  class SafetyError extends FbraError {}

  NS.errors = { FbraError, RowMissingError, RowAmbiguousError, FacebookTransientError, ElementNotFoundError, VerificationError, PageCrashedError, SafetyError };
})();
