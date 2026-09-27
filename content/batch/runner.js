/*
 * Batch orchestration. Three independent entry points:
 *   generateAll          detect → freeze → GENERATE all (concurrent) → APPLY all (sequential)
 *   applySchedule        current batch, or a fresh snapshot → schedule → verify per row
 *   generateAndSchedule  the whole generate+apply phase, THEN the whole schedule phase
 *
 * Gemini generation and Facebook DOM work are kept apart: descriptions are fetched with a
 * small concurrency pool while nothing is touched on the page, then inserted one row at a
 * time. A failing row never stops the batch (only a bad key/model or a page crash does).
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const S = NS.state;
  const { log } = NS.logger;
  const { FacebookTransientError, PageCrashedError } = NS.errors;
  const { waitFor, settle } = NS.wait;

  let onRunEnd = () => {};

  class UserFacingError extends Error {}

  const NO_ELIGIBLE_ROWS = 'Every reel\'s description failed, so there is nothing safe to schedule. Fix those rows first.';

  /**
   * Retry once after Facebook's own error. `explicitOnly`: react only to an error the operation
   * itself detected, so a stale toast already on the page is not blamed for a different failure.
   */
  async function withFacebookRecovery(label, op, { explicitOnly = false } = {}) {
    try {
      return await op();
    } catch (err) {
      const facebookError = err instanceof FacebookTransientError || (!explicitOnly && NS.pageErrors.findErrorContainer());
      if (!facebookError) throw err;
      log('ERROR', `${label}: Facebook error, pausing clicks until it recovers, then retrying once`);
      await NS.pageErrors.waitForRecovery();
      await S.checkpoint();
      return await op(); // second failure propagates → row marked Manual Action Required
    }
  }

  async function detectForBatch() {
    S.setPhase('detecting', 'Detecting reels…');
    let rows = NS.detector.detectRows();
    if (!rows.length) {
      // A React re-render can briefly empty the list; give it a moment.
      rows = (await waitFor(() => {
        const r = NS.detector.detectRows();
        return r.length ? r : null;
      }, { timeout: 3000, minInterval: 500 })) || [];
    }
    log('DETECT', `Rows detected: ${rows.length}`);
    if (!rows.length) throw new UserFacingError('No reels detected. Upload videos first, then click Refresh Detection.');
    S.setLiveRows(rows);
    return rows;
  }

  function validateSchedule(settings, count) {
    if (!settings.scheduleEnabled) throw new UserFacingError('Scheduling is disabled. Enable it in the panel or Settings.');
    const plan = NS.schedule.buildSchedule({
      date: settings.scheduleDate,
      startTime: settings.scheduleStartTime,
      intervalMinutes: settings.scheduleIntervalMinutes,
      count
    });
    if (!plan.ok) throw new UserFacingError(`Schedule not valid: ${plan.error}`);
    return plan.slots;
  }

  async function ensureAiReady() {
    try {
      const { pool, first } = await NS.bridge.checkGenerationReady();
      log('GENERATE', `AI pool ready: ${pool} model(s), first ${first.provider}/${first.model}`);
    } catch (err) {
      throw new UserFacingError(err.message);
    }
  }

  /** Run `task` over indices with at most `limit` in flight; never throws. */
  async function pool(indices, limit, task) {
    const queue = [...indices];
    const width = Math.max(1, Math.min(Number(limit) || 1, queue.length));
    const workers = Array.from({ length: width }, async () => {
      while (queue.length) {
        await S.checkpoint(); // Pause takes effect before the next request
        const i = queue.shift();
        await task(i);
      }
    });
    await Promise.all(workers);
  }

  /**
   * PHASE A — Gemini only. No Facebook DOM is read or written here, so network latency
   * never overlaps row reacquisition. Up to `concurrency` requests run at once.
   */
  async function generateDescriptions(batch, concurrency, progressOffset, progressTotal) {
    const total = batch.total;
    const indices = batch.rows.map((_, i) => i).filter((i) => !batch.rows[i].generated);
    let done = 0;
    let permanent = null;

    S.setPhase('generating', `Generating descriptions: 0/${indices.length} completed`);
    log('GENERATE', `Requesting ${indices.length} description(s), ${concurrency} at a time`);

    await pool(indices, concurrency, async (i) => {
      if (permanent) return; // bad key/model: stop starting new requests
      const { ref } = batch.rows[i];
      S.updateRow(i, { generationAttempted: true });
      try {
        log('GENERATE', `row=${i + 1} AI request started`);
        const res = await NS.bridge.generateDescription({ filename: ref.filename, index: ref.index, total });
        log('GENERATE', `row=${i + 1} response received length=${res.text.length} provider=${res.provider} model=${res.model}`);
        S.updateRow(i, { description: res.text, generated: true, usedProvider: res.provider, usedModel: res.model });
        S.setRowError(i, 'generate', '');
      } catch (err) {
        S.setRowError(i, 'generate', err.message);
        log('ERROR', `Row ${i + 1} generation: ${err.message}`);
        if (err.permanent) permanent = err;
      } finally {
        done++;
        S.setProgress(progressOffset + done, progressTotal);
        S.setMessage(`Generating descriptions: ${done}/${indices.length} completed`);
      }
    });

    const generated = batch.rows.filter((r) => r.generated).length;
    log('GENERATE', `Generation phase complete: ${generated}/${total} description(s) ready`);
    if (permanent && !generated) throw new UserFacingError(`Generation stopped: ${permanent.message}`);
    if (permanent) log('ERROR', `Gemini configuration error: ${permanent.message}`);
    if (!generated) throw new UserFacingError('No descriptions were generated. Check the AI providers in Settings and the log, then try again.');
  }

  /**
   * PHASE B — Facebook only. Inserts the already-generated text one row at a time,
   * reacquiring each row first and verifying afterwards.
   */
  async function applyDescriptions(batch, progressOffset, progressTotal) {
    const pending = batch.rows.map((_, i) => i).filter((i) => batch.rows[i].generated && !batch.rows[i].applied);
    let done = 0;
    S.setPhase('applying', `Applying ${pending.length} description(s)…`);

    for (const i of pending) {
      const row = batch.rows[i];
      S.setCurrentIndex(i);
      await S.checkpoint();
      S.setMessage(`Applying descriptions: ${done}/${pending.length} applied`);
      log('APPLY', `Starting row ${i + 1}`);

      const onStage = (stage, value) => {
        if (stage === 'row-reacquired') log('APPLY', `Row ${i + 1} reacquired`);
        else if (stage === 'editor-found') log('APPLY', `Description field found: ${NS.row.describeField(value)}`);
      };

      try {
        // Same single-row pipeline the per-row button uses; `text` means no new Gemini call.
        await withFacebookRecovery(`Row ${i + 1}`, () => NS.rowGenerate.generateAndApply(row.ref, { text: row.description, onStage }), {
          explicitOnly: true
        });
        S.updateRow(i, { applied: true });
        S.setRowError(i, 'apply', '');
      } catch (err) {
        if (err instanceof PageCrashedError) throw new UserFacingError(err.message); // stop touching the page
        S.updateRow(i, { applied: false });
        S.setRowError(i, 'apply', err.message);
        log('ERROR', `Row ${i + 1} ${err.step || 'apply'}: ${err.message} → Manual Action Required`);
      } finally {
        done++;
        S.setProgress(progressOffset + done, progressTotal);
      }
    }
    S.setMessage(`Applying descriptions: ${done}/${pending.length} applied`);
    S.setProgress(progressOffset + pending.length, progressTotal);
  }

  async function generatePhase(batch, concurrency, progressOffset, progressTotal) {
    await generateDescriptions(batch, concurrency, progressOffset, progressTotal);
    await applyDescriptions(batch, progressOffset + batch.total, progressTotal);
  }

  /**
   * A row may be scheduled unless its description was ATTEMPTED and failed.
   * Rows that were never generated (schedule-only use, or a caption typed by hand) are
   * eligible; a row whose Gemini/insert step failed is skipped so a half-finished reel is
   * never scheduled.
   */
  function eligibleForScheduling(row) {
    if (!row.generationAttempted) return true;
    return row.generated === true && row.applied === true;
  }

  const STAGE_LOG = {
    reacquired: (n, v) => `row=${n} reacquired=${v}`,
    'already-scheduled': (n) => `row=${n} already scheduled`,
    'control-found': (n, v) => `row=${n} scheduling control found=${v}`,
    'current-mode': (n, v) => `row=${n} currentMode="${v}"`,
    'control-clicked': (n, v) => `row=${n} scheduling control clicked=${v}`,
    'popover-visible': (n, v) => `row=${n} popover visible=${v}`,
    'current-tab': (n, v) => `row=${n} current tab="${v}"`,
    'schedule-tab-found': (n, v) => `row=${n} schedule tab found=${v}`,
    'tab-initial-selected': (n, v) => `row=${n} schedule tab initial selected=${Boolean(v)}`,
    'schedule-active': (n, v) => `row=${n} schedule active=${v}`,
    'popover-opened': (n) => `popover opened (row=${n})`,
    navigating: (n) => `navigating to Schedule tab (row=${n})`,
    'tab-focused': (n, v) => `Schedule tab focused (row=${n}, ${v})`,
    'key-pressed': (n, v) => `${v === 'Enter' ? 'Enter' : v} pressed (row=${n})`,
    'schedule-mode-verified': (n) => `schedule mode verified (row=${n})`,
    'datetime-set': (n, v) => `date/time set (row=${n}: ${v})`,
    update: (n) => `Update clicked (row=${n})`,
    'row-verified': (n) => `row verified (row=${n})`,
    'fields-visible': (n, v) => `row=${n} date/time fields visible=${v}`,
    'date-field-found': (n, v) => `row=${n} date field found=${v}`,
    'time-field-found': (n, v) => `row=${n} time field found=${v}`,
    'date-set': (n, v) => `row=${n} date set=${v}`,
    'time-set': (n, v) => `row=${n} time set=${v}`,
    'values-verified': (n, v) => `row=${n} values verified=${v}`,
    'update-clicked': (n, v) => `row=${n} update clicked=${v}`,
    verified: (n, v) => `row=${n} scheduled=${v}`,
    complete: (n, v) => `row=${n} complete=${v}`
  };

  /**
   * Validates the schedule for the eligible rows only (before any click), then schedules them.
   * Eligible rows get consecutive slots; ineligible rows are skipped without touching Facebook.
   * A row counts as scheduled only after the scheduler verified it on the page.
   */
  async function schedulePhase(batch, settings, progressOffset, progressTotal) {
    const total = batch.total;
    const eligible = batch.rows.filter(eligibleForScheduling).length;
    log('SCHEDULE', `enabled=${Boolean(settings.scheduleEnabled)}`);
    log('SCHEDULE', `configuredDate=${settings.scheduleDate} configuredTime=${settings.scheduleStartTime} intervalMinutes=${settings.scheduleIntervalMinutes}`);
    log('SCHEDULE', `detectedRows=${total} eligibleRows=${eligible}`);
    if (!eligible) throw new UserFacingError(NO_ELIGIBLE_ROWS);
    const slots = validateSchedule(settings, eligible);
    log('SCHEDULE', `plan: ${slots.map((sl) => `${sl.dateISO} ${sl.time24}`).join(', ')}`);

    // Real keyboard input (Tab/Enter) for the Schedule tab; attached before any popover opens
    // so the browser's "debugging" bar cannot close a popover by resizing the page.
    try {
      await NS.bridge.attachKeyboard();
      await settle(400);
    } catch (err) {
      log('SCHEDULE', `[ERROR] keyboard control unavailable: ${err.message}`);
    }
    try {
      await scheduleRows(batch, slots, eligible, progressOffset, progressTotal);
    } finally {
      NS.bridge.releaseKeyboard().catch(() => {});
    }
    S.setProgress(progressOffset + total, progressTotal);

    // Nothing scheduled: surface the actual per-row reasons instead of a silent 0.
    if (!batch.rows.some((r) => r.scheduled)) {
      const reasons = batch.rows
        .map((r, i) => (r.errors.schedule ? `Row ${i + 1}: ${r.errors.schedule}` : r.scheduleSkipped ? `Row ${i + 1}: description failed` : ''))
        .filter(Boolean);
      throw new UserFacingError(`Schedule failed:\n${reasons.join('\n') || 'no eligible rows'}`);
    }
  }

  /** Strictly one row at a time: the next row is not touched until this one is finished. */
  async function scheduleRows(batch, slots, eligible, progressOffset, progressTotal) {
    const total = batch.total;
    let slotIndex = 0;
    for (let i = 0; i < total; i++) {
      const row = batch.rows[i];
      S.setCurrentIndex(i);
      S.setProgress(progressOffset + i, progressTotal);

      if (!eligibleForScheduling(row)) {
        S.updateRow(i, { scheduled: false, scheduleSkipped: true });
        log('SCHEDULE', `Row ${i + 1} skipped because description was not successfully generated/applied.`);
        continue;
      }

      const slot = slots[slotIndex++];
      await S.checkpoint();
      S.setPhase('scheduling', `Scheduling ${slotIndex} of ${eligible} → ${slot.dateISO} ${slot.time24}`);
      log('SCHEDULE', `row=${i + 1} start`);
      const onStage = (stage, value) => {
        const line = STAGE_LOG[stage];
        if (line) log('SCHEDULE', line(i + 1, value));
      };
      try {
        await withFacebookRecovery(`Row ${i + 1} schedule`, () => NS.scheduler.scheduleRow(row.ref, slot, { onStage }));
        S.updateRow(i, { scheduled: true, scheduleSkipped: false, scheduledFor: `${slot.dateISO} ${slot.time24}` });
        S.setRowError(i, 'schedule', '');
      } catch (err) {
        S.updateRow(i, { scheduled: false });
        S.setRowError(i, 'schedule', `${err.step || 'schedule'}: ${err.message}`);
        if (err instanceof PageCrashedError) throw new UserFacingError(err.message);
        log('SCHEDULE', `[ERROR] row=${i + 1} step=${err.step || 'schedule'} message=${err.message}`);
      }
      if (i < total - 1) log('SCHEDULE', 'next row');
    }
  }

  function finishMessage() {
    const c = S.counters();
    const manual = S.get().batch.rows.filter((r) => r.manual).length;
    const base = `Done. Descriptions ${c.applied}/${c.detected}, scheduled ${c.scheduled}/${c.detected}.`;
    return `${base}${manual ? ` ${manual} row(s) need manual action.` : ''} Review, then click Publish yourself.`;
  }

  /** Shared wrapper: duplicate protection, error surfacing, guaranteed cleanup. */
  async function run(name, body) {
    if (!S.tryBeginRun()) {
      S.setMessage('Batch already running.');
      return;
    }
    log('INIT', `${name} started`);
    try {
      await body();
      S.setPhase('completed', finishMessage());
    } catch (err) {
      const message = err instanceof UserFacingError ? err.message : `Unexpected error: ${err.message}`;
      log('ERROR', message);
      S.setPhase('idle', message);
    } finally {
      S.endRun();
      onRunEnd();
    }
  }

  const Runner = {
    setOnRunEnd(fn) {
      onRunEnd = fn;
    },

    generateAll: () =>
      run('Generate All', async () => {
        const settings = await NS.bridge.getPublicSettings();
        await ensureAiReady();
        const batch = S.startBatch(NS.row.createDescriptors(await detectForBatch()));
        await generatePhase(batch, settings.aiConcurrency, 0, batch.total * 2);
      }),

    applySchedule: () =>
      run('Apply Schedule', async () => {
        log('SCHEDULE', 'button clicked');
        const settings = await NS.bridge.getPublicSettings();
        // Use the batch from Generate All when there is one; otherwise schedule what is on the
        // page now (reels whose captions were written by hand, or need none).
        let batch = S.get().batch;
        if (!batch || !batch.total) {
          batch = S.startBatch(NS.row.createDescriptors(await detectForBatch()));
          log('SCHEDULE', 'no existing batch: scheduling the reels detected now');
        }
        await schedulePhase(batch, settings, 0, batch.total);
      }),

    generateAndSchedule: () =>
      run('Generate + Schedule All', async () => {
        const settings = await NS.bridge.getPublicSettings();
        await ensureAiReady();
        const rows = await detectForBatch();
        validateSchedule(settings, rows.length); // fail fast before any work
        const batch = S.startBatch(NS.row.createDescriptors(rows));
        await generatePhase(batch, settings.aiConcurrency, 0, batch.total * 3);
        // Time has passed during generation: schedulePhase revalidates for the eligible rows.
        await schedulePhase(batch, await NS.bridge.getPublicSettings(), batch.total * 2, batch.total * 3);
      })
  };

  NS.runner = Runner;
})();
