/*
 * Prompt building and response cleaning — provider-independent.
 * The only place that turns a reel's stable metadata plus the user's business
 * settings into the text sent to a model.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});

  function describeFilename(filename) {
    if (!filename) return '';
    return filename
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/[_\-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function buildUserPrompt(settings, reel) {
    const phones = [settings.phone1, settings.phone2].filter(Boolean).join(', ');
    const lines = [
      `Language: ${settings.language || 'Bangla'}`,
      `Business name: ${settings.businessName}`,
      `Location: ${settings.location}`,
      `Phone: ${phones}`
    ];
    const hint = describeFilename(reel.filename);
    if (hint) lines.push(`Video file name (may hint at the product; ignore it if it is meaningless): ${hint}`);
    if (reel.total > 1) {
      lines.push(`This is reel ${reel.index + 1} of ${reel.total}. Use wording that differs from a generic template.`);
    }
    lines.push('Write the Facebook Reel description now.');
    return lines.join('\n');
  }

  /** Strip wrappers models add despite instructions. */
  function cleanText(text) {
    let out = String(text || '')
      .trim()
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    if (/^["“].*["”]$/s.test(out)) out = out.slice(1, -1).trim();
    return out;
  }

  NS.aiPrompt = { buildUserPrompt, cleanText, describeFilename };
})();
