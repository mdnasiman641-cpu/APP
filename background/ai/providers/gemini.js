/*
 * Gemini provider. Keeps the existing dynamic model discovery: only models the API
 * itself returns as supporting generateContent are ever offered.
 * The key travels in the x-goog-api-key header, never in the URL.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { request, AiHttpError } = NS.aiHttp;
  const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const MAX_PAGES = 10;

  const headers = (apiKey) => ({ 'x-goog-api-key': apiKey });
  const base = (baseUrl) => baseUrl || DEFAULT_BASE;

  function extractText(data) {
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const text = parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();
    if (!text) {
      const reason = data?.promptFeedback?.blockReason || candidate?.finishReason || 'empty response';
      // No text is this model's problem, so the pool may try another one.
      throw new AiHttpError(`Gemini returned no text (${reason})`, { status: 502 });
    }
    return NS.aiPrompt.cleanText(text);
  }

  async function generate({ apiKey, baseUrl, modelId, systemPrompt, userPrompt, deps = {} }) {
    const model = modelId.startsWith('models/') ? modelId : `models/${modelId}`;
    const data = await request({
      url: `${base(baseUrl)}/${model}:generateContent`,
      method: 'POST',
      headers: headers(apiKey),
      secrets: [apiKey],
      body: {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.9 }
      },
      ...deps
    });
    return extractText(data);
  }

  /** Models the API confirms support generateContent. */
  async function listModels({ apiKey, baseUrl, deps = {} }) {
    const out = [];
    let pageToken = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = new URLSearchParams({ pageSize: '1000' });
      if (pageToken) qs.set('pageToken', pageToken);
      const data = await request({ url: `${base(baseUrl)}/models?${qs}`, headers: headers(apiKey), secrets: [apiKey], ...deps });
      for (const m of data.models || []) {
        if (!Array.isArray(m.supportedGenerationMethods) || !m.supportedGenerationMethods.includes('generateContent')) continue;
        if (typeof m.name !== 'string' || !m.name.startsWith('models/')) continue;
        out.push({ id: m.name, label: m.displayName || m.name.slice(7), confirmed: true });
      }
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  NS.aiProviderGemini = { id: 'gemini', label: 'Gemini API (Old)', generate, listModels, extractText };
})();
