/*
 * Semantic Reel-row detection.
 *
 * One pass per call:
 *   1. collect description-field candidates once (single querySelectorAll)
 *   2. collect row signals once (media, controls, filename/copyright text)
 *   3. build an ancestor index by walking UP from each signal (no per-ancestor queries)
 *   4. for each field, the row is the LOWEST ancestor that contains the field, a
 *      thumbnail and a publish/schedule control, and no other description field.
 * The lowest match keeps page-level buttons (the final Publish) out of the row.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { isVisible, normalize, accessibleName, fieldHints, textOf, isInExtensionUi, isEditable } = NS.dom;

  const FIELD_SELECTOR = 'textarea, input[type="text"], input:not([type]), [contenteditable="true"], [contenteditable=""], [role="textbox"]';
  const MEDIA_SELECTOR = 'video, img, [role="img"], canvas, [style*="background-image"]';
  const CONTROL_SELECTOR = 'button, [role="button"], [role="combobox"], [aria-haspopup]';

  // Includes Facebook's current editor label: "Write into the dialogue box to include text with your post."
  const DESC_HINT = /description|caption|describe|write something|say something|what's on your mind|tell viewers|write into the dialog(ue)? box|include text with your post|বিবরণ|ক্যাপশন|কিছু লিখুন/;
  const EXCLUDE_HINT = /search|comment|reply|message|title|tag people|location|link|url|date|time|email|password|খুঁজুন/;
  const FILENAME_RE = /[^\s\\/:*?"<>|]{1,180}\.(mp4|mov|m4v|webm|avi|mkv|3gp|wmv|flv)\b/i;
  const FILENAME_END_RE = /\.(mp4|mov|m4v|webm|avi|mkv|3gp|wmv|flv)$/i;
  const COPYRIGHT_RE = /copyright|কপিরাইট/i;
  const PAGE_HINT_RE = /bulk upload|upload reels|bulk reels|create reels|বাল্ক আপলোড/;

  const CONTROL_TYPES = [
    ['schedule', /schedul|publish later|^later$|সময়সূচি|শিডিউল/],
    ['publish', /publish|post now|share now|প্রকাশ/],
    ['more', /more options|^more$|actions|আরও/],
    ['delete', /delete|remove|মুছুন|সরান/]
  ];
  const MAX_DEPTH = 25;
  const MIN_THUMB_PX = 40;

  function directHints(el) {
    return normalize(
      [el.getAttribute('placeholder'), el.getAttribute('aria-placeholder'), el.getAttribute('aria-label'), el.getAttribute('title')]
        .filter(Boolean)
        .join(' ')
    );
  }

  /** Every visible editable field that could hold a description (single querySelectorAll). */
  function collectEditables(root) {
    const out = [];
    for (const el of root.querySelectorAll(FIELD_SELECTOR)) {
      if (isInExtensionUi(el) || !isVisible(el)) continue;
      if (el.getAttribute('contenteditable') === 'false' || el.readOnly || el.disabled) continue;
      const direct = directHints(el);
      if (EXCLUDE_HINT.test(direct)) continue;
      const hints = direct + ' | ' + fieldHints(el);
      const multiline = el.tagName === 'TEXTAREA' || isEditable(el) || el.getAttribute('role') === 'textbox';
      const hinted = DESC_HINT.test(hints);
      if (hinted || multiline) out.push({ el, hints, hinted, multiline });
    }
    return innermostOnly(out);
  }

  const innermostOnly = (list) => list.filter((c) => !list.some((o) => o !== c && c.el.contains(o.el)));

  /** Step 1: description-like fields, innermost only. */
  function collectFields(root) {
    const all = collectEditables(root);
    const strong = all.filter((f) => f.hinted);
    // Weak (unlabelled) editors are used only when nothing is labelled as a description.
    return strong.length ? strong : all;
  }

  /** The filename shown in a text node: the whole node if it is just a filename, else the match. */
  function extractFilename(value) {
    const trimmed = value.trim();
    if (trimmed.length <= 180 && FILENAME_END_RE.test(trimmed) && !/[\\/:*?"<>|\n]/.test(trimmed)) return trimmed;
    const m = FILENAME_RE.exec(value);
    return m ? m[0] : '';
  }

  /** Normalise for comparison: Unicode NFC, invisible chars, whitespace, case, surrounding punctuation. */
  function normalizeFilename(name) {
    return String(name || '')
      .normalize('NFC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[\s"'“”‘’«»()[\]<>,;:!?-]+|[\s"'“”‘’«»()[\]<>,;:!?-]+$/g, '')
      .toLowerCase();
  }

  const insideEditor = (textNode) => Boolean(textNode.parentElement?.closest('[contenteditable="true"], [contenteditable=""], textarea'));

  /** All filename text on the page in one TreeWalker pass (text typed into editors is ignored). */
  function collectFilenameNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const value = t.nodeValue;
      if (!value || value.length > 300 || !FILENAME_RE.test(value)) continue;
      if (isInExtensionUi(t) || insideEditor(t)) continue;
      const raw = extractFilename(value);
      if (raw) out.push({ node: t, raw, norm: normalizeFilename(raw) });
    }
    return out;
  }

  function classifyControl(el) {
    const name = accessibleName(el);
    if (!name) return null;
    for (const [type, re] of CONTROL_TYPES) if (re.test(name)) return type;
    return null;
  }

  function isThumbnail(el) {
    if (el.tagName === 'VIDEO') return true;
    const r = el.getBoundingClientRect();
    return r.width >= MIN_THUMB_PX && r.height >= MIN_THUMB_PX;
  }

  /** Steps 2+3: signals and ancestor index. */
  function buildIndex(root, fields) {
    const index = new Map();
    const bump = (start, apply) => {
      let node = start;
      for (let d = 0; node && node !== root.parentElement && d < MAX_DEPTH + 5; d++, node = node.parentElement) {
        let info = index.get(node);
        if (!info) {
          info = { desc: 0, media: 0, controls: new Set(), psCount: 0, filenames: [], copyright: false };
          index.set(node, info);
        }
        apply(info);
      }
    };

    for (const f of fields) bump(f.el.parentElement, (i) => i.desc++);

    for (const el of root.querySelectorAll(MEDIA_SELECTOR)) {
      if (!isInExtensionUi(el) && isThumbnail(el)) bump(el.parentElement, (i) => i.media++);
    }

    for (const el of root.querySelectorAll(CONTROL_SELECTOR)) {
      if (isInExtensionUi(el) || !isVisible(el)) continue;
      const type = classifyControl(el);
      if (!type) continue;
      const ps = type === 'publish' || type === 'schedule';
      bump(el.parentElement, (i) => {
        i.controls.add(type);
        if (ps) i.psCount++;
      });
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const value = t.nodeValue;
      if (!value || value.length > 300) continue;
      const hasFile = FILENAME_RE.test(value);
      const copyright = COPYRIGHT_RE.test(value);
      if (!hasFile && !copyright) continue;
      if (isInExtensionUi(t) || insideEditor(t)) continue;
      const filename = hasFile ? extractFilename(value) : '';
      bump(t.parentElement, (i) => {
        if (filename) i.filenames.push(filename);
        if (copyright) i.copyright = true;
      });
    }
    return index;
  }

  /** Step 4: lowest qualifying ancestor. */
  function findRowContainer(fieldEl, index, root) {
    let fallback = null;
    let withAnyControl = null;
    let node = fieldEl.parentElement;
    for (let depth = 0; node && node !== root && depth < MAX_DEPTH; depth++, node = node.parentElement) {
      const info = index.get(node);
      if (!info || info.desc > 1) break; // reached a container of several rows
      if (info.media > 0 && info.psCount > 0) return { node, info, partial: false };
      if (!withAnyControl && info.media > 0 && info.controls.size > 0) withAnyControl = { node, info, partial: false };
      if (!fallback && info.media > 0 && info.filenames.length) fallback = { node, info, partial: true };
    }
    return withAnyControl || fallback;
  }

  function thumbKeyOf(rowEl) {
    const media = rowEl.querySelector('video, img');
    const src = media?.getAttribute('poster') || media?.getAttribute('src') || '';
    return src.slice(-120);
  }

  /**
   * @returns {{rows: Array, stats: object}}
   */
  function scan() {
    const root = document.body;
    if (!root) return { rows: [], stats: { fields: 0 } };
    const fields = collectFields(root);
    const index = buildIndex(root, fields);
    const seenContainers = new Set();
    const occurrences = new Map();
    const rows = [];

    for (const field of fields) {
      const found = findRowContainer(field.el, index, root);
      if (!found || seenContainers.has(found.node)) continue;
      seenContainers.add(found.node);

      const filename = found.info.filenames[0] || '';
      const occurrence = filename ? occurrences.get(filename) || 0 : 0;
      if (filename) occurrences.set(filename, occurrence + 1);
      const thumbKey = thumbKeyOf(found.node);
      const i = rows.length;
      rows.push({
        id: filename ? `f:${filename}#${occurrence}` : thumbKey ? `t:${thumbKey}` : `i:${i}`,
        index: i,
        element: found.node,
        filename,
        descriptionElement: field.el,
        metadata: {
          occurrence,
          thumbKey,
          controls: [...found.info.controls],
          hasCopyrightInfo: found.info.copyright,
          partial: found.partial,
          fieldHint: field.hints.slice(0, 80)
        }
      });
    }
    return { rows, stats: { fields: fields.length, indexedAncestors: index.size } };
  }

  function detectRows() {
    return scan().rows;
  }

  /** The field a row should be written to, or null when it cannot be told apart. */
  function pickDescriptionField(fields) {
    if (fields.length === 1) return fields[0];
    const hinted = fields.filter((f) => f.hinted);
    return hinted.length === 1 ? hinted[0] : null;
  }

  const documentOrder = (a, b) => (a.editor.compareDocumentPosition(b.editor) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

  /**
   * Targeted reacquisition: find the rows that show `filename` and the description field
   * that belongs to each. Needs only the filename text and an editor — no thumbnail,
   * no publish/schedule controls, no page-wide "which field is the description" vote.
   *
   * From each filename text node we climb to the LOWEST ancestor that contains an editable
   * field, and stop if an ancestor also shows a different reel's filename (another row).
   * Cost per call: one querySelectorAll for fields + one text walk; no per-ancestor queries.
   *
   * @returns {{candidates: Array<{container: Element, editor: Element}>, unresolved: number}}
   *   candidates in document order (one per distinct editor); `unresolved` counts rows
   *   showing the filename whose description field could not be told apart.
   */
  function locateFilenameRows(filename, normalizedFilename) {
    const root = document.body;
    if (!root) return { candidates: [], unresolved: 0 };
    const names = collectFilenameNodes(root);
    let targets = names.filter((n) => n.raw === filename);
    if (!targets.length) targets = names.filter((n) => n.norm === normalizedFilename);
    if (!targets.length) return { candidates: [], unresolved: 0 };

    const fields = collectEditables(root);
    const index = new Map();
    const climb = (start, apply) => {
      for (let n = start, d = 0; n && n !== root.parentElement && d < MAX_DEPTH + 5; d++, n = n.parentElement) {
        let info = index.get(n);
        if (!info) index.set(n, (info = { fields: [], names: new Set() }));
        apply(info);
      }
    };
    for (const f of fields) climb(f.el.parentElement, (i) => i.fields.push(f));
    for (const n of names) climb(n.node.parentElement, (i) => i.names.add(n.norm));

    const byEditor = new Map();
    let unresolved = 0;
    for (const target of targets) {
      for (let n = target.node.parentElement, d = 0; n && n !== root && d < MAX_DEPTH; d++, n = n.parentElement) {
        const info = index.get(n);
        if (!info || [...info.names].some((name) => name !== target.norm)) break; // reached another reel
        if (!info.fields.length) continue;
        const field = pickDescriptionField(info.fields);
        if (!field) {
          unresolved++;
          break;
        }
        const existing = byEditor.get(field.el);
        // Same editor reached from several filename texts: keep the tightest container.
        if (!existing || existing.container.contains(n)) byEditor.set(field.el, { container: n, editor: field.el });
        break;
      }
    }
    return { candidates: [...byEditor.values()].sort(documentOrder), unresolved };
  }

  function isBulkReelPage() {
    const path = (location.pathname + location.search).toLowerCase();
    if (/bulk|reels?_?composer|reel/.test(path)) return true;
    for (const h of document.querySelectorAll('h1, h2, [role="heading"]')) {
      if (PAGE_HINT_RE.test(normalize(textOf(h, 120)))) return true;
    }
    return false;
  }

  /** Summary for "Debug Facebook". No DOM dumps, no page text beyond labels. */
  function debugReport() {
    const { rows, stats } = scan();
    return {
      url: location.origin + location.pathname,
      bulkReelPage: isBulkReelPage(),
      descriptionCandidates: stats.fields,
      rows: rows.map((r) => ({
        id: r.id,
        filename: r.filename || '(none)',
        field: `${r.descriptionElement.tagName.toLowerCase()}${r.descriptionElement.getAttribute('role') ? `[role=${r.descriptionElement.getAttribute('role')}]` : ''}`,
        fieldHint: r.metadata.fieldHint,
        controls: r.metadata.controls,
        copyrightInfo: r.metadata.hasCopyrightInfo,
        partialMatch: r.metadata.partial
      })),
      openOverlays: document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]').length
    };
  }

  NS.detector = { detectRows, locateFilenameRows, normalizeFilename, thumbKeyOf, isBulkReelPage, debugReport };
})();
