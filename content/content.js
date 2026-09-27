/*
 * Entry point: page detection, controlled re-detection, panel wiring.
 *
 * Detection triggers (and nothing else):
 *   - SPA navigation (pushState/replaceState/popstate) → re-evaluate page
 *   - body MutationObserver → only for added/removed media/text-field nodes, debounced 800 ms
 *   - a 20 s safety poll, skipped while a batch runs or the tab is hidden
 * While a batch runs the observer only sets a "dirty" flag; one scan runs after the batch.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  if (NS.initialized) return;
  NS.initialized = true;

  const S = NS.state;
  const { log } = NS.logger;
  const { isInExtensionUi } = NS.dom;

  const DETECT_DEBOUNCE_MS = 800;
  const NAV_DEBOUNCE_MS = 500;
  const SAFETY_POLL_MS = 20000;
  const ZERO_CONFIRM_MS = 5000;
  const SIGNAL_SELECTOR = 'video, img, textarea, input, [contenteditable="true"], [role="textbox"]';
  const MAX_NODES_PER_MUTATION_BATCH = 300;

  let panel = null;
  let shownManually = false;
  let dirtyDuringBatch = false;
  let zeroSince = 0;
  const detectRef = {};
  const navRef = {};

  function debounce(timerRef, fn, ms) {
    clearTimeout(timerRef.id);
    timerRef.id = setTimeout(fn, ms);
  }

  // ---------- detection ----------

  function sameRows(a, b) {
    return a.length === b.length && a.every((r, i) => r.id === b[i].id);
  }

  function runDetection({ force = false } = {}) {
    if (S.get().running) {
      dirtyDuringBatch = true;
      return;
    }
    const rows = NS.detector.detectRows();
    const previous = S.get().liveDetectedRows;

    // A React re-render can briefly show zero rows. Only accept zero if it persists.
    if (!force && rows.length === 0 && previous.length > 0) {
      if (!zeroSince) zeroSince = Date.now();
      if (Date.now() - zeroSince < ZERO_CONFIRM_MS) {
        debounce(detectRef, runDetection, ZERO_CONFIRM_MS);
        return;
      }
    }
    zeroSince = 0;
    if (!sameRows(rows, previous) || force) {
      S.setLiveRows(rows);
      log('DETECT', `Rows detected: ${rows.length}`);
      panel?.refreshPreview();
    }
    NS.rowButtons.sync(rows); // re-anchor the per-row buttons to the current editors
  }

  function scheduleDetection() {
    if (!S.get().connected) return;
    debounce(detectRef, runDetection, DETECT_DEBOUNCE_MS);
  }

  function isRelevantMutation(mutations) {
    let inspected = 0;
    for (const m of mutations) {
      for (const list of [m.addedNodes, m.removedNodes]) {
        for (const node of list) {
          if (++inspected > MAX_NODES_PER_MUTATION_BATCH) return true;
          if (node.nodeType !== 1 || isInExtensionUi(node)) continue;
          if (node.matches(SIGNAL_SELECTOR) || node.querySelector(SIGNAL_SELECTOR)) return true;
        }
      }
    }
    return false;
  }

  const observer = new MutationObserver((mutations) => {
    if (S.get().running) {
      dirtyDuringBatch = true; // cheap: no scanning during a batch
      return;
    }
    if (!isRelevantMutation(mutations)) return;
    if (S.get().connected) scheduleDetection();
    else debounce(navRef, evaluatePage, 2000); // bulk UI may render without a URL change
  });

  setInterval(() => {
    if (!S.get().running && !document.hidden && S.get().connected) runDetection();
  }, SAFETY_POLL_MS);

  NS.runner.setOnRunEnd(() => {
    if (dirtyDuringBatch) {
      dirtyDuringBatch = false;
      scheduleDetection();
    }
  });

  // ---------- page / panel ----------

  async function loadScheduleIntoPanel() {
    try {
      panel.setScheduleValues(await NS.bridge.getPublicSettings());
    } catch (err) {
      S.setMessage(err.message);
    }
  }

  function ensurePanel() {
    if (panel) return;
    panel = NS.panel.createPanel({ onAction: handleAction });
    loadScheduleIntoPanel();
  }

  function evaluatePage() {
    const onBulkPage = NS.detector.isBulkReelPage();
    const wasConnected = S.get().connected;
    S.setConnected(onBulkPage);
    if (onBulkPage) {
      ensurePanel();
      panel.setVisible(true);
      NS.rowButtons.setVisible(true);
      if (!wasConnected) log('INIT', 'Bulk Reel page detected');
      scheduleDetection();
    } else if (panel && !shownManually && !S.get().running) {
      panel.setVisible(false);
      NS.rowButtons.setVisible(false);
    }
  }

  function onNavigation() {
    debounce(navRef, evaluatePage, NAV_DEBOUNCE_MS);
  }

  // ---------- actions ----------

  async function saveScheduleFromPanel() {
    const saved = await NS.bridge.saveScheduleSettings(panel.readScheduleInputs());
    panel.setScheduleValues(saved);
  }

  const actions = {
    generateAll: () => NS.runner.generateAll(),

    async applySchedule() {
      if (S.get().running) return S.setMessage('Batch already running.');
      await saveScheduleFromPanel();
      await NS.runner.applySchedule();
    },

    async generateAndSchedule() {
      if (S.get().running) return S.setMessage('Batch already running.');
      await saveScheduleFromPanel();
      await NS.runner.generateAndSchedule();
    },

    pause: () => S.pause(),
    resume: () => S.resume(),

    refreshDetection() {
      if (S.get().running) return S.setMessage('Batch already running.');
      S.setPhase('detecting', 'Detecting reels…');
      runDetection({ force: true });
      S.setPhase('idle', `Detected ${S.get().liveDetectedRows.length} reel(s).`);
    },

    /** Provider/model pool and what is currently in cooldown. Never shows keys. */
    async aiHealth() {
      const { pool } = await NS.bridge.getAiHealth();
      if (!pool.length) {
        S.setMessage('No AI provider is configured. Open Settings to add one.');
        return;
      }
      S.setMessage(`AI pool (in order):\n${pool.map((p) => `${p.order}. ${p.provider} / ${p.model} — ${p.state}`).join('\n')}`);
    },

    debug() {
      const report = NS.detector.debugReport();
      const batch = S.get().batch;
      if (batch && !S.get().running) report.batchRows = batch.rows.map((r) => NS.row.diagnose(r.ref));
      const logs = NS.logger.recent(25).map((e) => `${e.time} [${e.tag}] ${e.message}`);
      // TEMPORARY (1.2.5): where the "Scheduling options" control sits relative to each row. Read-only.
      let schedulingDom;
      try {
        schedulingDom = NS.schedulingDebug.report();
      } catch (err) {
        schedulingDom = `"Scheduling options" DOM diagnostic failed: ${err.message}`;
      }
      panel.showDebug(`${schedulingDom}\n\n${JSON.stringify(report, null, 2)}\n\nRecent log:\n${logs.join('\n')}`);
      log('DETECT', `Debug: ${report.rows.length} row(s), ${report.descriptionCandidates} description candidate(s)`);
      log('DETECT', `Debug: scheduling options mapping: ${NS.schedulingDebug.summarize(schedulingDom) || 'n/a'}`);
    },

    settings: () => NS.bridge.openOptions(),

    async saveSchedule() {
      await saveScheduleFromPanel();
      S.setMessage('Schedule saved.');
    }
  };

  function handleAction(name) {
    const action = actions[name];
    if (!action) return;
    Promise.resolve()
      .then(action)
      .catch((err) => {
        log('ERROR', `${name}: ${err.message}`);
        S.setMessage(err.message);
      });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'AI_STATUS') {
      S.setAiStatus(msg.status);
      return false;
    }
    if (msg?.type === 'PANEL_STATUS') {
      const st = S.get();
      sendResponse({ connected: st.connected, phase: st.phase, running: st.running, counters: S.counters() });
    } else if (msg?.type === 'SHOW_PANEL') {
      shownManually = true;
      ensurePanel();
      panel.setVisible(true);
      runDetection({ force: true });
      sendResponse({ ok: true });
    }
    return false;
  });

  // ---------- start ----------

  S.subscribe(() => NS.rowButtons.refreshEnabled()); // disable row buttons while a batch runs

  window.addEventListener('fbra:locationchange', onNavigation);
  window.addEventListener('popstate', onNavigation);
  observer.observe(document.body, { childList: true, subtree: true });
  log('INIT', 'Content script ready');
  evaluatePage();
})();
