/*
 * OpenRouter provider (OpenAI-compatible chat completions).
 * Model discovery is supported: /models reports each model's modalities, so only
 * models the API confirms can output text are offered.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const DEFAULT_BASE = 'https://openrouter.ai/api/v1';
  const LABEL = 'OpenRouter';

  // Identifies this extension to OpenRouter; contains no user data.
  const EXTRA_HEADERS = { 'X-Title': 'Facebook Bulk Reel Assistant' };

  function generate({ apiKey, baseUrl, modelId, systemPrompt, userPrompt, deps = {} }) {
    return NS.aiChat.chatCompletion({
      url: `${baseUrl || DEFAULT_BASE}/chat/completions`,
      apiKey,
      extraHeaders: EXTRA_HEADERS,
      modelId,
      systemPrompt,
      userPrompt,
      providerLabel: LABEL,
      deps
    });
  }

  function outputsText(model) {
    const arch = model?.architecture || {};
    if (Array.isArray(arch.output_modalities)) return arch.output_modalities.includes('text');
    if (typeof arch.modality === 'string') return /->\s*text/.test(arch.modality) || arch.modality.endsWith('text');
    return false; // not confirmed by the API: do not offer it
  }

  async function listModels({ apiKey, baseUrl, deps = {} }) {
    const data = await NS.aiHttp.request({
      url: `${baseUrl || DEFAULT_BASE}/models`,
      headers: { Authorization: `Bearer ${apiKey}` },
      secrets: [apiKey],
      ...deps
    });
    const out = (data?.data || [])
      .filter((m) => typeof m?.id === 'string' && outputsText(m))
      .map((m) => ({ id: m.id, label: m.name || m.id, confirmed: true }));
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  NS.aiProviderOpenRouter = { id: 'openrouter', label: 'OpenRouter API', generate, listModels };
})();
