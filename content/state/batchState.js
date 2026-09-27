/*
 * Centralised state.
 *
 * liveDetectedRows  – latest detection result; changes with Facebook re-renders.
 * batch.rows        – activeBatchRows; a snapshot taken when a batch starts.
 *                     Detection never writes to it, so a transient "0 rows" re-render
 *                     cannot reset Detected/Generated/Applied/Scheduled.
 *
 * Counters are derived from per-row records, so they cannot drift from reality.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});

  const PHASES = ['idle', 'detecting', 'generating', 'applying', 'scheduling', 'completed'];

  const state = {
    connected: false,
    liveDetectedRows: [],
    running: false,
    paused: false,
    phase: 'idle',
    message: '',
    ai: { text: '', state: 'idle' }, // provider/model names only, never a key
    progress: { done: 0, total: 0 },
    batch: null
  };

  const listeners = new Set();
  let resumeGate = null;
  let releaseGate = null;
  let batchSeq = 0;

  function emit() {
    for (const fn of listeners) fn(state);
  }

  const BatchState = {
    PHASES,
    get: () => state,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    setConnected(connected) {
      if (state.connected === connected) return;
      state.connected = connected;
      emit();
    },

    setLiveRows(rows) {
      state.liveDetectedRows = rows;
      emit();
    },

    setPhase(phase, message) {
      state.phase = phase;
      if (message !== undefined) state.message = message;
      emit();
    },

    setMessage(message) {
      state.message = message;
      emit();
    },

    /** Live AI provider/model status pushed from the service worker. */
    setAiStatus(status) {
      state.ai = { text: status.text || '', state: status.state || 'idle', provider: status.provider, model: status.model };
      emit();
    },

    setProgress(done, total) {
      state.progress = { done, total };
      emit();
    },

    /** Freeze a new batch from stable row descriptors (see row.createDescriptors). */
    startBatch(descriptors) {
      const total = descriptors.length;
      state.batch = {
        id: ++batchSeq,
        total,
        currentIndex: 0,
        rows: descriptors.map((ref) => ({
          ref,
          description: '',
          usedProvider: '', // which provider/model actually produced the text
          usedModel: '',
          generationAttempted: false, // Generate All ran for this row (so a failure must block scheduling)
          generated: false,
          applied: false,
          scheduled: false,
          scheduledFor: '',
          scheduleSkipped: false, // not scheduled because the description was not generated/applied
          errors: {}, // { generate?, apply?, schedule? } -> message
          manual: false // a Facebook action failed; the user must finish this row by hand
        }))
      };
      emit();
      return state.batch;
    },

    updateRow(index, patch) {
      const row = state.batch?.rows[index];
      if (!row) return;
      Object.assign(row, patch);
      emit();
    },

    /** Set or clear (message = '') the error for one step of one row. */
    setRowError(index, step, message) {
      const row = state.batch?.rows[index];
      if (!row) return;
      row.errors = { ...row.errors, [step]: message };
      if (!message) delete row.errors[step];
      row.manual = Boolean(row.errors.apply || row.errors.schedule);
      emit();
    },

    setCurrentIndex(index) {
      if (state.batch) state.batch.currentIndex = index;
      emit();
    },

    counters() {
      const rows = state.batch?.rows || [];
      const live = state.liveDetectedRows.length;
      const batchTotal = state.batch?.total || 0;
      return {
        // While running, or when a re-render briefly shows zero rows, keep the frozen count.
        detected: state.running ? batchTotal : live > 0 ? live : batchTotal,
        generated: rows.filter((r) => r.generated).length,
        applied: rows.filter((r) => r.applied).length,
        scheduled: rows.filter((r) => r.scheduled).length,
        errors: rows.filter((r) => Object.values(r.errors).some(Boolean)).length
      };
    },

    /** Duplicate-run protection. Returns false if a batch is already running. */
    tryBeginRun() {
      if (state.running) return false;
      state.running = true;
      state.paused = false;
      emit();
      return true;
    },

    endRun() {
      state.running = false;
      state.paused = false;
      releaseGate?.();
      resumeGate = releaseGate = null;
      emit();
    },

    pause() {
      if (!state.running || state.paused) return;
      state.paused = true;
      resumeGate = new Promise((resolve) => (releaseGate = resolve));
      emit();
    },

    resume() {
      if (!state.paused) return;
      state.paused = false;
      releaseGate?.();
      resumeGate = releaseGate = null;
      emit();
    },

    /** Awaited before every Gemini request and every Facebook action. No polling. */
    async checkpoint() {
      while (state.paused && resumeGate) await resumeGate;
    }
  };

  NS.state = BatchState;
})();
