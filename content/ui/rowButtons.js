/*
 * Per-row "✨ Generate" / "Test Insert" buttons.
 *
 * The buttons are NOT inserted into Facebook's DOM. They live in one fixed-position
 * overlay (Shadow DOM, attached to <html>) and are positioned over the top-right corner
 * of each description editor. Adding nodes inside React-managed containers is a known
 * way to make React crash on its next update ("We're having trouble completing your
 * request."), so the extension never modifies Facebook's element tree.
 *
 * Positions update on scroll/resize and when the editor itself resizes — no polling.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { log } = NS.logger;
  const { UI_ATTR, isVisible } = NS.dom;

  const DONE_MS = 2500;
  const ERROR_MS = 6000;
  const MIN_EDITOR_PX = 60;

  const CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147482000; }
    .group { position: fixed; display: flex; gap: 4px; pointer-events: auto;
      font: 600 11px/1 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Bengali", sans-serif; }
    button { font: inherit; border-radius: 6px; padding: 4px 7px; cursor: pointer; white-space: nowrap;
      border: 1px solid #0866ff; background: #0866ff; color: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
    button.ghost { background: rgba(255,255,255,.95); color: #444950; border-color: #cfd2d6; }
    button:disabled { opacity: .6; cursor: default; }
    button.done { background: #1a7f37; border-color: #1a7f37; }
    button.error { background: #c62828; border-color: #c62828; }
  `;

  let host = null;
  let shadow = null;
  let layer = null;
  let resizeObserver = null;
  let frame = 0;
  const groups = new Map(); // row id -> { ref, editor, el, generateBtn, testBtn, state }

  function ensureLayer() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'fb-bulk-reel-assistant-row-buttons';
    host.setAttribute(UI_ATTR, '');
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style><div class="layer"></div>`;
    layer = shadow.querySelector('.layer');
    document.documentElement.appendChild(host);

    addEventListener('scroll', schedulePosition, { passive: true, capture: true });
    addEventListener('resize', schedulePosition, { passive: true });
    resizeObserver = new ResizeObserver(schedulePosition);
  }

  function schedulePosition() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      position();
    });
  }

  function position() {
    for (const group of groups.values()) {
      const { editor, el } = group;
      if (!editor.isConnected || !isVisible(editor)) {
        el.style.display = 'none';
        continue;
      }
      const r = editor.getBoundingClientRect();
      if (r.width < MIN_EDITOR_PX || r.bottom < 0 || r.top > innerHeight) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = 'flex';
      // Top-right corner of the editor, inside it, so Facebook's own input stays usable.
      el.style.left = `${Math.max(4, r.right - el.offsetWidth - 6)}px`;
      el.style.top = `${r.top + 5}px`;
    }
  }

  function setState(group, state, { label, title = '' } = {}) {
    group.state = state;
    const btn = group.generateBtn;
    btn.className = state === 'done' ? 'done' : state === 'error' ? 'error' : '';
    btn.textContent = label;
    btn.title = title;
    const busy = state === 'generating' || state === 'inserting';
    btn.disabled = busy || NS.state.get().running;
    group.testBtn.disabled = busy || NS.state.get().running;
  }

  const idle = (group) => setState(group, 'idle', { label: '✨ Generate' });

  function flashThenIdle(group, state, label, title, ms) {
    setState(group, state, { label, title });
    clearTimeout(group.timer);
    group.timer = setTimeout(() => idle(group), ms);
  }

  const STAGE_LOG = {
    'row-reacquired': (n) => `row reacquired=true row=${n}`,
    'editor-found': (n) => `editor found=true row=${n}`,
    request: () => 'AI request started',
    'insert-start': (n) => `applying description row=${n}`,
    'insert-end': () => 'insertion END',
    verified: () => 'verification=true'
  };

  async function runRow(group, { test = false } = {}) {
    if (NS.state.get().running) {
      NS.state.setMessage('A batch is running — wait for it to finish.');
      return;
    }
    const rowNo = group.ref.index + 1;
    log('ROW-GENERATE', `row=${rowNo} started${test ? ' (test insert)' : ''}`);
    setState(group, 'generating', { label: test ? '⏳ Inserting…' : '⏳ Generating...' });

    try {
      const result = await NS.rowGenerate.generateAndApply(group.ref, {
        text: test ? 'Test description' : null,
        onStage(stage, value) {
          if (stage === 'response') {
            log('ROW-GENERATE', `AI response received length=${String(value).length}`);
            setState(group, 'inserting', { label: '⏳ Inserting…' });
            return;
          }
          if (stage === 'model-used') {
            log('ROW-GENERATE', `generated using provider=${value.provider} model=${value.model}`);
            return;
          }
          if (stage === 'insert-start') log('ROW-GENERATE', 'insertion START — waiting for React update');
          const line = STAGE_LOG[stage];
          if (line) log('ROW-GENERATE', line(rowNo));
        }
      });
      log('ROW-GENERATE', `completed row=${rowNo}`);
      const via = result?.provider ? ` using ${result.provider}/${result.model}` : '';
      NS.state.setMessage(`Row ${rowNo}: description inserted and verified${via}.`);
      flashThenIdle(group, 'done', '✓ Generated', '', DONE_MS);
    } catch (err) {
      const step = err.step || 'unknown';
      log('ROW-GENERATE', `ERROR step=${step} message=${err.message}`);
      if (step === 'verify') log('ROW-GENERATE', 'verification=false');
      NS.state.setMessage(`Row ${rowNo} failed (${step}): ${err.message}`);
      flashThenIdle(group, 'error', '⚠ Failed', `${step}: ${err.message}`, ERROR_MS);
    }
  }

  function createGroup(ref, editor) {
    const el = document.createElement('div');
    el.className = 'group';
    const generateBtn = document.createElement('button');
    const testBtn = document.createElement('button');
    testBtn.className = 'ghost';
    testBtn.textContent = 'Test Insert';
    testBtn.title = 'Insert fixed text without calling Gemini (debugging)';
    el.append(testBtn, generateBtn);
    layer.appendChild(el);

    const group = { ref, editor, el, generateBtn, testBtn, state: 'idle', timer: 0 };
    generateBtn.addEventListener('click', () => runRow(group));
    testBtn.addEventListener('click', () => runRow(group, { test: true }));
    idle(group);
    resizeObserver.observe(editor);
    return group;
  }

  /** Rebuild the buttons for the currently detected rows. Called when detection changes. */
  function sync(rows) {
    if (!rows.length && !groups.size) return;
    ensureLayer();
    const refs = NS.row.createDescriptors(rows);
    const seen = new Set();

    rows.forEach((row, i) => {
      const ref = refs[i];
      const key = `${ref.id}#${ref.index}`;
      seen.add(key);
      const existing = groups.get(key);
      if (existing) {
        existing.ref = ref;
        if (existing.editor !== row.descriptionElement) {
          resizeObserver.unobserve(existing.editor);
          existing.editor = row.descriptionElement;
          resizeObserver.observe(existing.editor);
        }
        if (existing.state === 'idle') idle(existing); // refresh disabled state
        return;
      }
      groups.set(key, createGroup(ref, row.descriptionElement));
    });

    for (const [key, group] of groups) {
      if (seen.has(key)) continue;
      if (group.state === 'generating' || group.state === 'inserting') continue; // keep a running one
      clearTimeout(group.timer);
      resizeObserver.unobserve(group.editor);
      group.el.remove();
      groups.delete(key);
    }
    position();
  }

  function setVisible(visible) {
    if (host) host.style.display = visible ? '' : 'none';
  }

  /** Reflect batch running/idle on the buttons. */
  function refreshEnabled() {
    for (const group of groups.values()) if (group.state === 'idle') idle(group);
  }

  NS.rowButtons = { sync, setVisible, refreshEnabled, count: () => groups.size };
})();
