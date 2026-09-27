/*
 * Single-row generation: the one place that turns a row descriptor into a verified
 * description on the page. Used by the per-row "✨ Generate" button AND by the
 * batch runner's generate phase, so both follow exactly the same steps:
 *
 *   reacquire row → find its editor → Gemini (in the service worker) → reacquire → insert → verify
 *
 * It never schedules, never publishes and never touches another row.
 * `onStage` reports each step so callers can log/label them their own way.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const DESCRIPTION = { purpose: 'description' };

  let busy = false;

  /** Errors carry `step` so the caller can tell which stage failed. */
  function tag(err, step) {
    if (!err.step) err.step = step;
    return err;
  }

  /**
   * @param {object} ref row descriptor (see row.createDescriptors)
   * @param {{total?: number, onStage?: Function, text?: string}} opts
   *   text: insert this instead of calling Gemini (the "Test Insert" button)
   * @returns {Promise<{text: string}>}
   */
  async function generateAndApply(ref, { total = ref.total, onStage = () => {}, text = null } = {}) {
    if (busy) throw tag(new Error('Another row is still being generated.'), 'busy');
    busy = true;
    try {
      onStage('reacquire');
      let row;
      try {
        row = await NS.row.acquireRow(ref, DESCRIPTION);
      } catch (err) {
        throw tag(err, 'reacquire');
      }
      onStage('row-reacquired', row);

      const editor = row.descriptionElement;
      if (!editor) throw tag(new Error('The row has no description field.'), 'editor');
      onStage('editor-found', editor);

      let description = text;
      let used = null;
      if (description === null) {
        onStage('request');
        try {
          const result = await NS.bridge.generateDescription({ filename: ref.filename, index: ref.index, total });
          description = result.text;
          used = { provider: result.provider, model: result.model };
        } catch (err) {
          throw tag(err, 'ai');
        }
        onStage('response', description);
        onStage('model-used', used);
      }

      onStage('insert-start');
      try {
        // applyDescription reacquires the row again (the DOM may have been replaced meanwhile),
        // inserts through editor-handled input paths only, then reads the text back.
        await NS.description.applyDescription(ref, description);
      } catch (err) {
        throw tag(err, err.name === 'VerificationError' ? 'verify' : 'insert');
      }
      onStage('insert-end');
      onStage('verified', description);
      return { text: description, ...(used || {}) };
    } finally {
      busy = false;
    }
  }

  NS.rowGenerate = { generateAndApply, isBusy: () => busy };
})();
