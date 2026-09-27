/*
 * Row identity and reacquisition.
 *
 * Facebook (React) replaces row DOM at will, so a DOM element is never a row's identity.
 * When a batch starts, each row gets a stable descriptor; every Facebook operation then
 * reacquires the CURRENT elements from it.
 *
 * Reacquisition order (strongest signal first):
 *   1. exact filename text        } → the row that shows it, and the description
 *   2. normalised filename        }   field that belongs to that row
 *   3. several rows show the name → original order among them (if the count is unchanged),
 *      else a thumbnail unique to this reel, else the row's own text; else AMBIGUOUS
 *   4. no filename on the page    → unique thumbnail, else original index (count unchanged)
 * Ambiguous rows are never touched: a description must never land on another reel.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { RowMissingError, RowAmbiguousError, PageCrashedError } = NS.errors;
  const { log } = NS.logger;
  const ROW_WAIT_MS = 5000;

  const lastStatus = new WeakMap(); // descriptor → { status, detail } of the latest lookup

  /** Row text without the editor's contents, letters only: survives re-renders and progress numbers. */
  function rowSignature(container, editor) {
    const own = editor?.textContent || '';
    return String(container?.textContent || '')
      .replace(own, '')
      .normalize('NFC')
      .replace(/[^\p{L}\p{M}]/gu, '')
      .toLowerCase()
      .slice(0, 300);
  }

  function describeField(el) {
    if (!el) return 'none';
    const role = el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '';
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    return `${el.tagName.toLowerCase()}${role}${label ? ` "${label.slice(0, 50)}"` : ''}`;
  }

  /** Stable descriptors for a freshly detected set of rows. */
  function createDescriptors(rows) {
    const norm = rows.map((r) => NS.detector.normalizeFilename(r.filename));
    return rows.map((row, i) => {
      const sameName = norm[i] ? rows.filter((_, j) => norm[j] === norm[i]) : [];
      const thumbShared = row.metadata.thumbKey && rows.filter((r) => r.metadata.thumbKey === row.metadata.thumbKey).length > 1;
      return {
        id: row.id,
        index: i, // row order at detection
        total: rows.length,
        filename: row.filename,
        normalizedFilename: norm[i],
        occurrence: sameName.indexOf(row), // order among rows with the same filename
        sameNameCount: sameName.length,
        thumbKey: thumbShared ? '' : row.metadata.thumbKey,
        nearbyText: rowSignature(row.element, row.descriptionElement)
      };
    });
  }

  const found = (container, editor) => ({ status: 'found', container, editor });
  const missing = (detail) => ({ status: 'missing', detail });
  const ambiguous = (detail) => ({ status: 'ambiguous', detail });

  function pickAmongSameName(ref, candidates) {
    if (candidates.length === ref.sameNameCount && candidates[ref.occurrence]) {
      const c = candidates[ref.occurrence];
      return found(c.container, c.editor);
    }
    // The number of reels with this filename changed: order is no longer trustworthy.
    const detected = NS.detector.detectRows();
    const fullRowOf = (c) => detected.find((r) => r.descriptionElement === c.editor)?.element || c.container;
    if (ref.thumbKey) {
      const byThumb = candidates.filter((c) => NS.detector.thumbKeyOf(fullRowOf(c)) === ref.thumbKey);
      if (byThumb.length === 1) return found(byThumb[0].container, byThumb[0].editor);
    }
    if (ref.nearbyText) {
      const byText = candidates.filter((c) => rowSignature(fullRowOf(c), c.editor) === ref.nearbyText);
      if (byText.length === 1) return found(byText[0].container, byText[0].editor);
    }
    return ambiguous(`${candidates.length} reels now show "${ref.filename}" (was ${ref.sameNameCount}) and nothing else tells them apart`);
  }

  /** Rows without any filename on the page: the original detector-based identity. */
  function locateWithoutFilename(ref) {
    const rows = NS.detector.detectRows();
    if (ref.thumbKey) {
      const byThumb = rows.filter((r) => r.metadata.thumbKey === ref.thumbKey);
      if (byThumb.length === 1) return found(byThumb[0].element, byThumb[0].descriptionElement);
      if (byThumb.length > 1) return ambiguous('several rows share its thumbnail');
    }
    if (rows.length === ref.total && !rows.some((r) => r.filename) && rows[ref.index]) {
      return found(rows[ref.index].element, rows[ref.index].descriptionElement);
    }
    return missing(rows.length ? 'no row matches its thumbnail/position' : 'no reel rows on the page');
  }

  function locate(ref) {
    if (!ref.filename) return locateWithoutFilename(ref);
    const { candidates, unresolved } = NS.detector.locateFilenameRows(ref.filename, ref.normalizedFilename);
    if (!candidates.length) {
      return unresolved
        ? ambiguous(`"${ref.filename}" is shown but its description field cannot be told apart from another field`)
        : missing(`"${ref.filename}" with a description field is not on the page`);
    }
    return pickAmongSameName(ref, candidates);
  }

  /**
   * Current DOM for a descriptor, or null.
   * purpose 'description' → filename + editor only (cheap; no thumbnail/controls needed).
   * purpose 'full' (default, used by scheduling) → the detector's full row container
   * (with its controls) that holds this same editor, falling back to the anchored container.
   */
  function resolveRow(ref, { purpose = 'full' } = {}) {
    const result = locate(ref);
    lastStatus.set(ref, result);
    if (result.status !== 'found') return null;

    const base = {
      id: ref.id,
      index: ref.index,
      filename: ref.filename,
      element: result.container,
      descriptionElement: result.editor,
      metadata: { anchored: true }
    };
    if (purpose === 'description') return base;

    const editor = result.editor;
    const full = NS.detector
      .detectRows()
      .find((r) => r.descriptionElement === editor || r.descriptionElement.contains(editor) || editor.contains(r.descriptionElement));
    return full ? { ...full, id: ref.id, index: ref.index, filename: ref.filename, descriptionElement: editor } : base;
  }

  /**
   * Fresh row, waiting up to 5 s (MutationObserver + 100/200/300/500/750/1000 ms polling)
   * for a React re-render to bring it back. Only then is it a failure.
   */
  async function acquireRow(ref, { purpose = 'full' } = {}) {
    const label = `Row ${ref.index + 1} (${ref.filename || 'no filename'})`;
    const now = resolveRow(ref, { purpose });
    if (now) return now;
    if (NS.pageErrors.isPageCrashed()) throw new PageCrashedError(); // nothing to wait for

    log('DETECT', `${label} not found right now (${lastStatus.get(ref)?.detail}); waiting up to 5 s for Facebook to re-render`);
    const started = Date.now();
    const row = await NS.wait.waitForRow(ref, { purpose, timeout: ROW_WAIT_MS });
    if (row) {
      log('DETECT', `${label} found again after ${Date.now() - started} ms`);
      return row;
    }
    if (NS.pageErrors.isPageCrashed()) throw new PageCrashedError();
    const status = lastStatus.get(ref);
    if (status?.status === 'ambiguous') throw new RowAmbiguousError(`${label}: identity ambiguous — ${status.detail}. Not touched.`);
    throw new RowMissingError(`${label} not found after waiting 5 s: ${status?.detail || 'unknown'}`);
  }

  /** For "Debug Facebook": how each batch row resolves right now. */
  function diagnose(ref) {
    const row = resolveRow(ref, { purpose: 'description' });
    const status = lastStatus.get(ref);
    return {
      row: ref.index + 1,
      filename: ref.filename || '(none)',
      status: status?.status,
      detail: status?.detail || '',
      field: describeField(row?.descriptionElement)
    };
  }

  NS.row = { createDescriptors, resolveRow, acquireRow, describeField, diagnose };
})();
