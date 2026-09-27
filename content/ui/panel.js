/*
 * Floating status panel inside a Shadow DOM (open, so it can be driven by
 * accessibility tools and end-to-end tests; it never contains secrets).
 * The host is attached to <html>, not <body>, so panel updates never reach the
 * MutationObserver that watches Facebook's <body>. Nothing secret is ever rendered.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { ROOT_ID } = NS.dom;

  const PHASE_LABELS = {
    idle: 'Idle',
    detecting: 'Detecting',
    generating: 'Generating',
    applying: 'Applying',
    scheduling: 'Scheduling',
    completed: 'Completed'
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel { position: fixed; right: 16px; bottom: 16px; width: 330px; max-height: calc(100vh - 32px); overflow: auto;
      z-index: 2147483000; background: #fff; color: #1c1e21; border: 1px solid #dadde1; border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Bengali", sans-serif; }
    .panel.min .body { display: none; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eceef1; position: sticky; top: 0; background: inherit; }
    header h1 { font-size: 13px; font-weight: 650; margin: 0; flex: 1; }
    .pill { font-size: 10px; font-weight: 700; letter-spacing: .04em; padding: 2px 7px; border-radius: 999px; background: #eceef1; color: #65676b; }
    .pill.on { background: #e3f4e8; color: #1a7f37; }
    .icon { border: 0; background: transparent; cursor: pointer; font-size: 16px; color: #65676b; padding: 0 4px; }
    .body { padding: 12px; display: grid; gap: 10px; }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .stat { background: #f5f6f7; border-radius: 8px; padding: 6px; text-align: center; }
    .stat b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
    .stat span { font-size: 10.5px; color: #65676b; }
    .stat.err b { color: #c62828; }
    .phase { display: flex; justify-content: space-between; font-size: 12px; color: #444950; }
    .phase .paused { color: #b26a00; font-weight: 600; }
    .ai { font-size: 11.5px; color: #65676b; word-break: break-word; }
    .ai b { color: #1c1e21; font-weight: 600; }
    .ai.switching b { color: #b26a00; }
    .bar { height: 6px; background: #eceef1; border-radius: 999px; overflow: hidden; }
    .bar i { display: block; height: 100%; width: 0; background: #0866ff; transition: width .25s; }
    .msg { font-size: 12px; color: #444950; min-height: 16px; word-break: break-word; white-space: pre-wrap; }
    .actions { display: grid; gap: 6px; }
    .row2 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    button.btn { font: inherit; font-size: 12px; font-weight: 600; border-radius: 8px; padding: 7px 8px; cursor: pointer;
      border: 1px solid #dadde1; background: #fff; color: #1c1e21; }
    button.btn.primary { background: #0866ff; border-color: #0866ff; color: #fff; }
    button.btn:disabled { opacity: .45; cursor: default; }
    details { border-top: 1px solid #eceef1; padding-top: 8px; }
    summary { cursor: pointer; font-weight: 600; font-size: 12px; }
    .sched { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
    .sched label { display: grid; gap: 2px; font-size: 11px; color: #65676b; }
    .sched label.check { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; color: #1c1e21; font-size: 12px; }
    .sched input { font: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid #dadde1; border-radius: 6px; width: 100%; }
    .sched input[type="checkbox"] { width: auto; margin: 0; }
    .sched .full { grid-column: 1 / -1; }
    .hint { font-size: 11px; color: #65676b; }
    ul.rows { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; }
    ul.rows li { font-size: 11.5px; padding: 5px 7px; background: #f5f6f7; border-radius: 6px; }
    ul.rows li.manual { background: #fdecea; }
    ul.rows .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
    ul.rows .err { color: #c62828; display: block; }
    ul.rows .desc { display: block; margin-top: 4px; padding: 4px 6px; background: #fff; border-radius: 4px; white-space: pre-wrap; user-select: text; }
    button.btn.copy { margin-top: 8px; width: 100%; }
    pre { margin: 8px 0 0; max-height: 220px; overflow: auto; background: #f5f6f7; border-radius: 6px; padding: 8px; font-size: 10.5px; white-space: pre-wrap; word-break: break-word; }
    .safety { font-size: 11px; color: #65676b; }
  `;

  const HTML = `
    <div class="panel">
      <header>
        <h1>Bulk Reel Assistant</h1>
        <span class="pill" data-ref="pill">NOT CONNECTED</span>
        <button class="icon" data-action="toggle" title="Minimise">–</button>
      </header>
      <div class="body">
        <div class="stats">
          <div class="stat"><b data-ref="detected">0</b><span>Detected</span></div>
          <div class="stat"><b data-ref="applied">0</b><span>Descriptions</span></div>
          <div class="stat"><b data-ref="scheduled">0</b><span>Scheduled</span></div>
          <div class="stat err"><b data-ref="errors">0</b><span>Errors</span></div>
        </div>
        <div class="phase"><span>Phase: <b data-ref="phase">Idle</b></span><span class="paused" data-ref="paused" hidden>Paused</span></div>
        <div class="ai" data-ref="aiRow" hidden>AI: <b data-ref="ai"></b></div>
        <div class="bar"><i data-ref="bar"></i></div>
        <div class="msg" data-ref="message"></div>
        <div class="actions">
          <button class="btn primary" data-action="generateAll" data-run>Generate All</button>
          <button class="btn primary" data-action="applySchedule" data-run>Apply Schedule</button>
          <button class="btn primary" data-action="generateAndSchedule" data-run>Generate + Schedule All</button>
          <div class="row2">
            <button class="btn" data-action="pause">Pause</button>
            <button class="btn" data-action="resume">Resume</button>
            <button class="btn" data-action="refreshDetection" data-run>Refresh Detection</button>
            <button class="btn" data-action="aiHealth">AI Status</button>
            <button class="btn" data-action="debug">Debug Facebook</button>
            <button class="btn" data-action="settings">Settings</button>
          </div>
        </div>
        <details data-ref="schedDetails">
          <summary>Schedule</summary>
          <div class="sched">
            <label class="check"><input type="checkbox" data-sched="scheduleEnabled"> Enable scheduling</label>
            <label>Date<input type="date" data-sched="scheduleDate"></label>
            <label>Start time<input type="time" data-sched="scheduleStartTime"></label>
            <label class="full">Interval (minutes)<input type="number" min="1" max="1440" step="1" data-sched="scheduleIntervalMinutes"></label>
            <div class="hint full" data-ref="schedPreview"></div>
            <button class="btn full" data-action="saveSchedule">Save schedule</button>
          </div>
        </details>
        <details data-ref="rowsDetails">
          <summary>Rows</summary>
          <ul class="rows" data-ref="rows"></ul>
        </details>
        <details data-ref="debugDetails">
          <summary>Debug</summary>
          <button class="btn copy" data-action="copyDebug">Copy debug output</button>
          <pre data-ref="debug">Click "Debug Facebook".</pre>
        </details>
        <div class="safety">Final Publish is always manual. The assistant never clicks it.</div>
      </div>
    </div>`;

  function createPanel({ onAction }) {
    const host = document.createElement('div');
    host.id = ROOT_ID;
    host.setAttribute(NS.dom.UI_ATTR, '');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style>${HTML}`;
    document.documentElement.appendChild(host);

    const $ = (ref) => shadow.querySelector(`[data-ref="${ref}"]`);
    const panelEl = shadow.querySelector('.panel');
    const schedInputs = [...shadow.querySelectorAll('[data-sched]')];

    shadow.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action;
      if (action === 'toggle') {
        panelEl.classList.toggle('min');
        btn.textContent = panelEl.classList.contains('min') ? '+' : '–';
        return;
      }
      if (action === 'copyDebug') {
        copyDebug(btn);
        return;
      }
      onAction(action);
    });

    /** Copy the Debug text so it can be pasted into a message (clipboard API, else a selection copy). */
    async function copyDebug(btn) {
      const text = $('debug').textContent;
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.cssText = 'position:fixed;left:-9999px;opacity:0';
        shadow.append(area);
        area.select();
        try {
          ok = document.execCommand('copy');
        } catch {
          ok = false;
        }
        area.remove();
      }
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed — select the text below';
      setTimeout(() => (btn.textContent = 'Copy debug output'), 2500);
    }
    shadow.addEventListener('input', (e) => {
      if (e.target.dataset.sched) updatePreview();
    });

    function readScheduleInputs() {
      const values = {};
      for (const input of schedInputs) {
        const key = input.dataset.sched;
        values[key] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
      }
      return values;
    }

    function updatePreview() {
      const v = readScheduleInputs();
      const count = Math.max(1, NS.state.counters().detected);
      const plan = NS.schedule.buildSchedule({ date: v.scheduleDate, startTime: v.scheduleStartTime, intervalMinutes: v.scheduleIntervalMinutes, count });
      const preview = $('schedPreview');
      if (!v.scheduleEnabled) preview.textContent = 'Scheduling is off.';
      else if (!plan.ok) preview.textContent = `⚠ ${plan.error}`;
      else {
        const last = plan.slots[plan.slots.length - 1];
        preview.textContent = `${count} reel(s): ${plan.slots[0].dateISO} ${plan.slots[0].time24} → ${last.dateISO} ${last.time24}`;
      }
    }

    function setScheduleValues(settings) {
      for (const input of schedInputs) {
        const val = settings[input.dataset.sched];
        if (input.type === 'checkbox') input.checked = Boolean(val);
        else input.value = val ?? '';
      }
      updatePreview();
    }

    function renderRows(state) {
      const list = $('rows');
      list.replaceChildren();
      for (const r of state.batch?.rows || []) {
        const li = document.createElement('li');
        if (r.manual) li.className = 'manual';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = `${r.ref.index + 1}. ${r.ref.filename || 'Reel'}`;
        const status = document.createElement('span');
        status.textContent = [
          r.usedModel ? `✓ ${r.usedProvider}/${r.usedModel}` : '',
          r.applied ? '✓ description' : r.generated ? '… generated, not applied' : '○ no description',
          r.scheduled ? `✓ ${r.scheduledFor}` : r.scheduleSkipped ? '⊘ schedule skipped (no verified description)' : '○ not scheduled',
          r.manual ? '⚠ Manual Action Required' : ''
        ].filter(Boolean).join(' · ');
        li.append(name, status);
        if (r.generated && !r.applied) {
          // Keep the text available so the user can paste it by hand.
          const desc = document.createElement('span');
          desc.className = 'desc';
          desc.textContent = r.description;
          li.append(desc);
        }
        for (const msg of Object.values(r.errors)) {
          const err = document.createElement('span');
          err.className = 'err';
          err.textContent = msg;
          li.append(err);
        }
        list.append(li);
      }
    }

    let pending = false;
    let lastBatchVersion = null;
    function render() {
      pending = false;
      const state = NS.state.get();
      const c = NS.state.counters();
      $('pill').textContent = state.connected ? 'CONNECTED' : 'NOT CONNECTED';
      $('pill').classList.toggle('on', state.connected);
      $('detected').textContent = c.detected;
      $('applied').textContent = c.applied;
      $('scheduled').textContent = c.scheduled;
      $('errors').textContent = c.errors;
      $('phase').textContent = PHASE_LABELS[state.phase] || state.phase;
      $('paused').hidden = !state.paused;
      $('message').textContent = state.message;
      $('aiRow').hidden = !state.ai.text;
      $('ai').textContent = state.ai.text;
      shadow.querySelector('.ai').classList.toggle('switching', state.ai.state === 'switching' || state.ai.state === 'waiting');
      const { done, total } = state.progress;
      $('bar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
      for (const btn of shadow.querySelectorAll('[data-run]')) btn.disabled = state.running;
      shadow.querySelector('[data-action="pause"]').disabled = !state.running || state.paused;
      shadow.querySelector('[data-action="resume"]').disabled = !state.paused;
      const version = JSON.stringify(
        state.batch?.rows.map((r) => [r.generated, r.applied, r.scheduled, r.scheduleSkipped, r.manual, r.errors, r.usedModel]) || null
      );
      if (version !== lastBatchVersion) {
        lastBatchVersion = version;
        renderRows(state);
      }
    }

    function scheduleRender() {
      if (pending) return;
      pending = true;
      setTimeout(render, 50);
    }

    NS.state.subscribe(scheduleRender);
    render();

    return {
      setScheduleValues,
      readScheduleInputs,
      refreshPreview: updatePreview,
      showDebug(text) {
        $('debug').textContent = text;
        $('debugDetails').open = true;
      },
      setVisible(visible) {
        host.style.display = visible ? '' : 'none';
      }
    };
  }

  NS.panel = { createPanel };
})();
