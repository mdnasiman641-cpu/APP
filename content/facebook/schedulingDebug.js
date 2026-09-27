/*
 * TEMPORARY diagnostic (1.2.5) for "Debug Facebook".
 *
 * Question it answers from the live page: where does Facebook render each visible
 * "Scheduling options" control, relative to the row element scheduler.js searches in?
 * For every such element it reports its exact text/aria-label, tag, role, aria and other
 * attributes, the element that would take a click, its ancestors, and — for every detected
 * row — whether it is INSIDE the row element, a SIBLING of it, at PARENT-LEVEL (a container
 * above the row that still holds only that reel), in a SHARED container of several reels
 * (column/header layouts), or in a PORTAL/popover outside the rows.
 *
 * Read-only: it never clicks, focuses, scrolls or edits anything, and runs only when the
 * user presses "Debug Facebook". It reports structure (tags, roles, attributes, short
 * control labels, positions), never page content. Remove this file and its call in
 * content.js once the scheduler maps each row to its own control.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { isVisible, normalize, accessibleName, textOf, isInExtensionUi } = NS.dom;

  // What the page calls the control, as visible text, aria-label or title. The Bengali
  // forms avoid "য়", which Unicode normalisation may split into two code points.
  const LABEL_RE = /(^|[^a-z])(scheduling( and editing)? options?|schedule options?|publishing options?)($|[^a-z])|সূচির বিকল্প|শিডিউলিং অপশন/;
  // Any scheduling-related name carried in an attribute (reported as found, whatever it says).
  const ATTR_SELECTOR = '[aria-label*="schedul" i], [title*="schedul" i], [aria-label*="সূচি"], [aria-label*="শিডিউল"]';
  const ATTR_NAME_RE = /schedul|সূচি|শিডিউল/i;
  const INTERACTIVE_SELECTOR =
    'button, a[href], input, select, [role="button"], [role="combobox"], [role="menuitem"], [role="tab"], [role="link"], [role="radio"], [role="switch"], [role="checkbox"], [role="option"], [aria-haspopup], [tabindex]';
  // Controls that show a publishing mode ("Publish now ⌄" …): listed so the report also shows
  // what each row itself offers. Listed only — this file never clicks anything.
  const MODE_CONTROL_SELECTOR = 'button, [role="button"], [role="combobox"], [aria-haspopup]';
  const MODE_RE = /^(publish now|post now|share now|publish|scheduled?( |$)|save as draft|draft|এখনই প্রকাশ|প্রকাশ|শিডিউল)/;
  const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [aria-modal="true"]';
  const STABLE_ATTRS = ['role', 'aria-label', 'aria-labelledby', 'data-testid', 'data-pagelet', 'id'];
  const MAX_ELEMENTS = 10;
  const MAX_LABEL_TEXT = 60;
  const ANCESTOR_LEVELS = 6;

  const clip = (value, max = 80) => {
    const s = String(value ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };

  /** One line per element: tag#id[role][aria-label][data-*] .first.three.classes (+n) */
  function describe(el) {
    if (!el) return '(none)';
    if (el === document.body) return 'body';
    let out = el.tagName.toLowerCase();
    if (el.id) out += `#${clip(el.id, 30)}`;
    const role = el.getAttribute('role');
    if (role) out += `[role=${role}]`;
    const label = el.getAttribute('aria-label');
    if (label) out += `[aria-label="${clip(label, 40)}"]`;
    for (const a of el.attributes) if (a.name.startsWith('data-')) out += `[${a.name}="${clip(a.value, 30)}"]`;
    const classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    if (classes.length) out += `.${classes.slice(0, 3).join('.')}${classes.length > 3 ? ` (+${classes.length - 3} classes)` : ''}`;
    return out;
  }

  /** Why an element takes clicks, from its markup alone ('' = nothing says it does). */
  function interactiveKind(el) {
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'INPUT' || (tag === 'A' && el.hasAttribute('href'))) return tag.toLowerCase();
    const role = el.getAttribute('role');
    if (role && /^(button|combobox|menuitem|tab|link|radio|switch|checkbox|option)$/.test(role)) return `role=${role}`;
    const popup = el.getAttribute('aria-haspopup');
    if (popup && popup !== 'false') return `aria-haspopup=${popup}`;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) >= 0) return `tabindex=${tabindex}`;
    return '';
  }

  const ariaOf = (el) =>
    [...el.attributes]
      .filter((a) => a.name.startsWith('aria-'))
      .map((a) => `${a.name}="${clip(a.value, 50)}"`)
      .join(' ') || '(none)';

  function otherAttributesOf(el) {
    const out = [];
    for (const a of el.attributes) {
      if (a.name.startsWith('aria-') || a.name === 'role' || a.name === 'style') continue;
      if (a.name === 'class') {
        const classes = a.value.split(/\s+/).filter(Boolean);
        out.push(`class=(${classes.length}: ${classes.slice(0, 4).join(' ')}${classes.length > 4 ? ' …' : ''})`);
      } else {
        out.push(`${a.name}="${clip(a.value, 40)}"`);
      }
    }
    return out.join(' ') || '(none)';
  }

  function describeControl(el) {
    const flags = ['aria-haspopup', 'aria-expanded']
      .filter((name) => el.hasAttribute(name))
      .map((name) => `${name}=${el.getAttribute(name)}`);
    return `${describe(el)} "${clip(accessibleName(el), 40)}"${flags.length ? ` (${flags.join(', ')})` : ''}`;
  }

  function stableAttributes(el) {
    const present = STABLE_ATTRS.filter((name) => el.hasAttribute(name)).map((name) => `${name}="${clip(el.getAttribute(name), 40)}"`);
    return present.join(' ') || 'none (generated classes only)';
  }

  const reelsIn = (container, rows) => rows.filter((r) => container.contains(r.descriptionElement)).length;

  function levelsUp(from, to) {
    let d = 0;
    for (let n = from; n && n !== to; n = n.parentElement) d++;
    return d;
  }

  function commonAncestor(a, b) {
    const chain = new Set();
    for (let n = a; n; n = n.parentElement) chain.add(n);
    for (let n = b; n; n = n.parentElement) if (chain.has(n)) return n;
    return null;
  }

  /** The child of `ancestor` that leads down to `el`. */
  function branchUnder(ancestor, el) {
    let n = el;
    while (n && n.parentElement !== ancestor) n = n.parentElement;
    return n;
  }

  /** Share of the shorter element's height that the two elements have in common. */
  function verticalOverlap(a, b) {
    const r1 = a.getBoundingClientRect();
    const r2 = b.getBoundingClientRect();
    const base = Math.min(r1.height, r2.height);
    if (base <= 0) return 0;
    return Math.max(0, Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top)) / base;
  }

  function position(el) {
    const r = el.getBoundingClientRect();
    return `x=${Math.round(r.left)} y=${Math.round(r.top)} w=${Math.round(r.width)} h=${Math.round(r.height)}`;
  }

  /**
   * Visible elements the page names "Scheduling options": every scheduling-related
   * aria-label/title, plus short visible texts matching LABEL_RE (a text is skipped when it
   * is just the label of an element already found by its attribute).
   */
  function findSchedulingElements() {
    const found = [];
    let hidden = 0;
    for (const el of document.body.querySelectorAll(ATTR_SELECTOR)) {
      if (isInExtensionUi(el)) continue;
      if (!isVisible(el)) {
        hidden++;
        continue;
      }
      const how = ATTR_NAME_RE.test(el.getAttribute('aria-label') || '') ? 'aria-label' : 'title';
      found.push({ el, how });
    }
    const byAttribute = [...found];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const value = t.nodeValue;
      if (!value || value.length > MAX_LABEL_TEXT || !LABEL_RE.test(normalize(value))) continue;
      const el = t.parentElement;
      if (!el || isInExtensionUi(el) || found.some((f) => f.el === el)) continue;
      if (!isVisible(el)) {
        hidden++;
        continue;
      }
      if (byAttribute.some((f) => f.el.contains(el) && levelsUp(el, f.el) <= 3)) continue;
      found.push({ el, how: 'text' });
    }
    found.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return { found, hidden };
  }

  /**
   * What would take a click for this element, from the markup: the element itself, an
   * interactive ancestor, a control aria-labelledby it, an interactive child, or the
   * interactive elements next to it (never crossing into a container of several reels).
   */
  function clickTargets(el, rows) {
    if (interactiveKind(el)) return [{ how: 'itself', el }];
    let up = el.parentElement;
    for (let d = 1; up && up !== document.body && d <= 6; d++, up = up.parentElement) {
      if (interactiveKind(up)) return [{ how: `interactive ancestor ${d} level(s) up`, el: up }];
    }
    const out = [];
    for (let n = el, d = 0; n && n !== document.body && d < 3; d++, n = n.parentElement) {
      if (!n.id) continue;
      for (const ref of document.querySelectorAll(`[aria-labelledby~="${CSS.escape(n.id)}"]`)) {
        out.push({ how: `aria-labelledby points at it (#${clip(n.id, 20)})`, el: ref });
      }
    }
    if (out.length) return out.slice(0, 3);
    for (const child of el.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (interactiveKind(child) && isVisible(child)) out.push({ how: 'interactive child', el: child });
      if (out.length >= 3) return out;
    }
    if (out.length) return out;
    let scope = el.parentElement;
    for (let d = 1; scope && scope !== document.body && d <= 4; d++, scope = scope.parentElement) {
      if (reelsIn(scope, rows) > 1) break;
      const near = [...scope.querySelectorAll(INTERACTIVE_SELECTOR)].filter((c) => !c.contains(el) && interactiveKind(c) && isVisible(c)).slice(0, 3);
      if (near.length) return near.map((c) => ({ how: `next to it (common ancestor ${d} level(s) up)`, el: c }));
    }
    return [];
  }

  function nearestUsefulAncestor(el) {
    let n = el.parentElement;
    for (let d = 1; n && n !== document.body && d <= 12; d++, n = n.parentElement) {
      if (STABLE_ATTRS.some((name) => n.hasAttribute(name))) return `${describe(n)} (${d} level(s) up)`;
    }
    return 'none within 12 levels (generated classes only)';
  }

  /**
   * How `el` relates to the row element scheduler.js searches in.
   * perReel = the element sits in a container that holds this reel and no other.
   */
  function relation(el, row, rows) {
    const rowEl = row.element;
    const overlay = el.closest(OVERLAY_SELECTOR);
    const alignedText = (aligned) => (aligned ? 'vertically ALIGNED with this row' : 'not aligned with this row');
    if (overlay && !overlay.contains(rowEl)) {
      const aligned = verticalOverlap(rowEl, el) >= 0.5;
      return { kind: 'PORTAL', perReel: false, aligned, up: Infinity, text: `PORTAL/POPOVER — inside ${describe(overlay)}, which does not contain the row; ${alignedText(aligned)}` };
    }
    if (rowEl.contains(el)) {
      return { kind: 'INSIDE', perReel: true, aligned: true, up: 0, lca: rowEl, text: `INSIDE the row element (${levelsUp(el, rowEl)} level(s) below it)` };
    }
    const lca = commonAncestor(rowEl, el);
    if (!lca || lca === document.body || lca === document.documentElement) {
      const aligned = verticalOverlap(rowEl, el) >= 0.5;
      return { kind: 'PORTAL', perReel: false, aligned, up: Infinity, text: `PORTAL — rendered outside the rows; the only common ancestor is <body>; ${alignedText(aligned)}` };
    }
    const reels = reelsIn(lca, rows);
    const up = levelsUp(rowEl, lca);
    const down = levelsUp(el, lca);
    const aligned = verticalOverlap(rowEl, el) >= 0.5;
    const base = { lca, up, down, aligned, reels };
    if (lca === el) {
      return reels > 1
        ? { ...base, kind: 'CONTAINS-ROWS', perReel: false, text: `it CONTAINS ${reels} reels, this row included (${up} level(s) above the row element)` }
        : { ...base, kind: 'WRAPS', perReel: true, text: `it WRAPS the row element (${up} level(s) above it) and holds only this reel` };
    }
    const branch = branchUnder(lca, el);
    const via = branch === el ? 'the element itself' : `${describe(branch)} (the element is ${down - 1} level(s) inside it)`;
    if (reels > 1) {
      return {
        ...base,
        kind: 'SHARED',
        perReel: false,
        text:
          `SHARED CONTAINER — the nearest container holding both is ${describe(lca)}, which holds ${reels} reels ` +
          `(${up} level(s) above the row element; branch: ${via}); ${alignedText(aligned)}`
      };
    }
    if (up === 1) {
      return {
        ...base,
        kind: 'SIBLING',
        perReel: true,
        text: `SIBLING — shares the row element's parent ${describe(lca)} (holds only this reel); sibling branch: ${via}`
      };
    }
    return {
      ...base,
      kind: 'PARENT-LEVEL',
      perReel: true,
      text: `PARENT-LEVEL — ${describe(lca)} holds only this reel and both elements; ${up} level(s) above the row element; branch: ${via}`
    };
  }

  function rowControls(rowEl) {
    const out = [];
    for (const el of rowEl.querySelectorAll(MODE_CONTROL_SELECTOR)) {
      if (!isVisible(el)) continue;
      const name = accessibleName(el);
      if (!name) continue;
      out.push(describeControl(el));
      if (out.length >= 8) break;
    }
    return out;
  }

  function elementLines(o, rows) {
    const el = o.el;
    const kind = interactiveKind(el);
    const targets = clickTargets(el, rows);
    const lines = [
      `#${o.n}  found by ${o.how}`,
      `    text: "${clip(textOf(el, 300), 80)}"   aria-label: ${el.hasAttribute('aria-label') ? `"${clip(el.getAttribute('aria-label'), 80)}"` : '(none)'}` +
        `${el.hasAttribute('title') ? `   title: "${clip(el.getAttribute('title'), 60)}"` : ''}`,
      `    tag: ${el.tagName.toLowerCase()}   role: ${el.getAttribute('role') || '(none)'}   interactive: ${kind ? `yes (${kind})` : 'no'}`,
      `    aria: ${ariaOf(el)}`,
      `    other attributes: ${otherAttributesOf(el)}`,
      `    element that takes the click: ${targets.length ? targets.map((t) => `${t.how} → ${describeControl(t.el)}`).join(' | ') : 'none found nearby'}`,
      `    nearest useful ancestor: ${nearestUsefulAncestor(el)}`,
      '    ancestors:'
    ];
    let n = el.parentElement;
    for (let d = 1; n && d <= ANCESTOR_LEVELS; d++, n = n.parentElement) {
      lines.push(`        ${d}. ${describe(n)}  children=${n.children.length} reels=${reelsIn(n, rows)}`);
      if (n === document.body) break;
    }
    const overlay = el.closest(OVERLAY_SELECTOR);
    lines.push(`    inside overlay/dialog: ${overlay ? describe(overlay) : 'no'}   position: ${position(el)}`);
    return lines;
  }

  function rowLines(row, i, rows, occs, rels) {
    const lines = [
      `Row ${i + 1}  "${clip(row.filename || '(no filename)', 60)}"`,
      `    row element (what scheduler.js searches): ${describe(row.element)}`,
      `        depth below <body>: ${levelsUp(row.element, document.body)}   position: ${position(row.element)}` +
        `   detector matched: thumbnail + controls [${row.metadata.controls.join(', ') || 'none'}]${row.metadata.partial ? ' (partial: filename only)' : ''}`
    ];
    const controls = rowControls(row.element);
    lines.push(`    controls inside the row element (${controls.length}):`);
    for (const c of controls) lines.push(`        ${c}`);
    lines.push('    containers above the row element:');
    let anc = row.element.parentElement;
    for (let d = 1; anc && anc !== document.body && d <= 5; d++, anc = anc.parentElement) {
      const container = anc;
      const inside = occs.filter((o) => container.contains(o.el)).map((o) => `#${o.n}`);
      lines.push(`        +${d} ${describe(container)}  children=${container.children.length} reels=${reelsIn(container, rows)} scheduling-options=${inside.join(' ') || 'none'}`);
    }
    // Few elements: every relation. Many: the ones that can belong to this row, and a count.
    const shown = rels.length <= 4 ? rels : rels.filter((x) => x.rel.perReel || x.rel.aligned);
    for (const { o, rel } of shown) lines.push(`    relation to #${o.n}: ${rel.text}`);
    if (shown.length < rels.length) lines.push(`    (${rels.length - shown.length} other element(s): outside this reel's containers and not aligned with it)`);
    const own = rels.filter((x) => x.rel.perReel).sort((a, b) => a.rel.up - b.rel.up);
    if (own.length) {
      const best = own[0];
      const where = best.rel.kind === 'INSIDE' ? 'the row element itself' : `${describe(best.rel.lca)} (${best.rel.up} level(s) above the row element)`;
      lines.push(`    closest container holding this reel and a Scheduling options element: ${where} → #${best.o.n}; stable attributes: ${stableAttributes(best.rel.lca)}`);
    } else {
      lines.push('    closest container holding this reel and a Scheduling options element: none (no container that holds only this reel contains one)');
    }
    return lines;
  }

  function modeControlLines(rows, occs) {
    const found = [];
    for (const el of document.body.querySelectorAll(MODE_CONTROL_SELECTOR)) {
      if (found.length >= MAX_ELEMENTS) break;
      if (isInExtensionUi(el) || !isVisible(el)) continue;
      if (occs.some((o) => o.el === el || o.el.contains(el) || el.contains(o.el))) continue;
      if (!el.hasAttribute('aria-label') && el.textContent.length > 80) continue;
      if (MODE_RE.test(accessibleName(el))) found.push(el);
    }
    return found.map((el, k) => {
      const rels = rows.map((row, i) => ({ i, rel: relation(el, row, rows) }));
      const owner = rels.find((x) => x.rel.perReel);
      const where = owner
        ? `Row ${owner.i + 1}: ${owner.rel.kind}`
        : rels.length
          ? `no single row: ${rels[0].rel.kind === 'PORTAL' ? 'portal/overlay' : `shared container of ${rels[0].rel.reels ?? '?'} reels`}`
          : 'no rows detected';
      return `    m${k + 1} ${describeControl(el)} → ${where}; ${nearestLabel(el, occs, rows)}`;
    });
  }

  /** The "Scheduling options" element closest to a control, without leaving one reel's container. */
  function nearestLabel(el, occs, rows) {
    let best = null;
    for (const o of occs) {
      const lca = commonAncestor(el, o.el);
      if (!lca || lca === document.body || reelsIn(lca, rows) > 1) continue;
      const up = levelsUp(el, lca);
      if (!best || up < best.up) best = { o, lca, up };
    }
    return best
      ? `nearest "Scheduling options" element: #${best.o.n} (common ancestor ${describe(best.lca)}, ${best.up} level(s) above this control)`
      : 'no "Scheduling options" element in the same reel container';
  }

  /** Mapping verdict for the whole page, from the relations only. */
  function verdict(rows, occs, mapping) {
    if (!occs.length) return 'NO visible element is labelled "Scheduling options" (text, aria-label or title) on this page.';
    if (!rows.length) return 'No reel rows are detected, so nothing can be mapped.';
    const distinct = (list) => new Set(list).size === list.length;
    if (mapping.every((m) => m.own.length === 1) && distinct(mapping.map((m) => m.own[0].o))) {
      const kinds = [...new Set(mapping.map((m) => m.own[0].rel.kind))].join('/');
      return `ONE-TO-ONE through each row's own container — every row has exactly one "Scheduling options" element in a container holding only that reel (${kinds}).`;
    }
    if (mapping.every((m) => m.own.length === 0 && m.aligned.length === 1) && distinct(mapping.map((m) => m.aligned[0].o))) {
      const order = mapping.map((m) => m.aligned[0].o.n);
      const inOrder = order.every((n, k) => k === 0 || n > order[k - 1]);
      return (
        'ONE-TO-ONE BY POSITION ONLY — the elements are in a container shared by several reels (column layout); ' +
        `each is vertically aligned with exactly one row. DOM order matches row order: ${inOrder ? 'yes' : 'no'}.`
      );
    }
    if (occs.length === 1 && rows.length > 1) {
      return `ONE element for ${rows.length} rows — it is page/list level (for example a column header or a control for all reels), not a per-row control.`;
    }
    return 'NO one-to-one mapping can be read from the DOM — see the relations below.';
  }

  /** @returns {string} the report section for the Debug output */
  function report() {
    const rows = NS.detector.detectRows();
    const { found, hidden } = findSchedulingElements();
    const all = found.map((f, k) => ({ ...f, n: k + 1 }));
    const occs = all.slice(0, MAX_ELEMENTS);
    const relsByRow = rows.map((row) => occs.map((o) => ({ o, rel: relation(o.el, row, rows) })));
    const mapping = relsByRow.map((rels) => ({
      own: rels.filter((x) => x.rel.perReel).sort((a, b) => a.rel.up - b.rel.up),
      aligned: rels.filter((x) => !x.rel.perReel && x.rel.aligned)
    }));
    const overlays = [...document.body.querySelectorAll(OVERLAY_SELECTOR)].filter((el) => !isInExtensionUi(el) && isVisible(el));

    const lines = [
      '=== "Scheduling options" DOM diagnostic (temporary; read-only — nothing is clicked) ===',
      `rows detected: ${rows.length}   "Scheduling options" elements: ${all.length} visible, ${hidden} hidden` +
        ` (interactive themselves: ${all.filter((o) => interactiveKind(o.el)).length}; with a clickable element: ${all.filter((o) => clickTargets(o.el, rows).length).length})`,
      `open overlays/dialogs: ${overlays.length}${overlays.length ? ` (${overlays.slice(0, 3).map(describe).join(' | ')})` : ''}`,
      '',
      'Summary'
    ];
    rows.forEach((row, i) => {
      const m = mapping[i];
      const name = `Row ${i + 1} "${clip(row.filename || '(no filename)', 40)}"`;
      if (m.own.length === 1) lines.push(`    ${name} → #${m.own[0].o.n}  ${m.own[0].rel.kind}`);
      else if (m.own.length > 1) lines.push(`    ${name} → several in its own container: ${m.own.map((x) => `#${x.o.n} ${x.rel.kind}`).join(', ')}`);
      else if (m.aligned.length) lines.push(`    ${name} → none in its own container; vertically aligned: ${m.aligned.map((x) => `#${x.o.n} ${x.rel.kind}`).join(', ')}`);
      else lines.push(`    ${name} → none`);
    });
    lines.push(`    mapping: ${verdict(rows, occs, mapping)}`);
    if (all.length > occs.length) lines.push(`    (${all.length - occs.length} more element(s) not detailed)`);

    lines.push('', '"Scheduling options" elements (document order)');
    for (const o of occs) lines.push(...elementLines(o, rows));
    if (!occs.length) lines.push('    none');

    lines.push('', 'Rows');
    rows.forEach((row, i) => lines.push(...rowLines(row, i, rows, occs, relsByRow[i])));
    if (!rows.length) lines.push('    none detected');

    const modes = modeControlLines(rows, occs);
    lines.push('', 'Publishing-mode controls on the page (listed only — never clicked)', ...(modes.length ? modes : ['    none']));
    return lines.join('\n');
  }

  /** One-line summary for the log. */
  function summarize(text) {
    const m = /mapping: (.*)/.exec(text);
    return m ? m[1].slice(0, 160) : '';
  }

  NS.schedulingDebug = { report, summarize };
})();
