/*
 * Pure schedule builder. No DOM, no Chrome APIs.
 * Used by the content script (before touching Facebook) and the options page (preview).
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});

  const MIN_LEAD_MINUTES = 10; // Facebook rejects schedule times too close to "now".
  const MAX_INTERVAL_MINUTES = 1440;

  const pad = (n) => String(n).padStart(2, '0');

  function toDateISO(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function toTime24(d) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function parseStart(dateStr, timeStr) {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    const tm = /^(\d{2}):(\d{2})$/.exec(timeStr || '');
    if (!dm) return { error: 'Schedule date is missing or invalid (expected YYYY-MM-DD).' };
    if (!tm) return { error: 'Start time is missing or invalid (expected HH:MM).' };
    const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
    const [h, mi] = [Number(tm[1]), Number(tm[2])];
    if (h > 23 || mi > 59) return { error: 'Start time is invalid.' };
    const date = new Date(y, mo - 1, d, h, mi, 0, 0);
    // Reject rollovers such as 2026-02-31.
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
      return { error: 'Schedule date does not exist.' };
    }
    return { date };
  }

  /**
   * Build and validate the complete schedule for `count` reels.
   * Slot i = start + i * interval (absolute minutes, so midnight crossing is natural).
   * @returns {{ok: true, slots: Array} | {ok: false, error: string}}
   */
  function buildSchedule({ date, startTime, intervalMinutes, count, now = new Date() }) {
    if (!Number.isInteger(count) || count < 1) return { ok: false, error: 'No reels to schedule.' };
    const interval = Number(intervalMinutes);
    if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL_MINUTES) {
      return { ok: false, error: `Interval must be a whole number between 1 and ${MAX_INTERVAL_MINUTES} minutes.` };
    }
    const start = parseStart(date, startTime);
    if (start.error) return { ok: false, error: start.error };

    const earliest = now.getTime() + MIN_LEAD_MINUTES * 60000;
    if (start.date.getTime() < earliest) {
      return {
        ok: false,
        error: `Start time ${toDateISO(start.date)} ${toTime24(start.date)} is in the past or less than ${MIN_LEAD_MINUTES} minutes from now.`
      };
    }

    const slots = [];
    for (let i = 0; i < count; i++) {
      const d = new Date(start.date.getTime() + i * interval * 60000);
      slots.push({ index: i, date: d, dateISO: toDateISO(d), time24: toTime24(d) });
    }
    return { ok: true, slots };
  }

  NS.schedule = { buildSchedule, toDateISO, toTime24, MIN_LEAD_MINUTES };
})();
