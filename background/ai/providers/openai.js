/*
 * OpenAI provider (chat completions).
 *
 * Model discovery: /v1/models lists the models the key can reach but does NOT state
 * which of them accept chat completions. Models that are clearly not text generators
 * (embeddings, audio, image, moderation) are filtered out, and the rest are offered as
 * unconfirmed — the UI says so. A model that turns out not to accept chat completions
 * fails as MODEL_UNAVAILABLE at generation time, so the pool simply moves on.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const DEFAULT_BASE = 'https://api.openai.com/v1';
  const LABEL = 'OpenAI';

  const NOT_TEXT_RE = /embedding|whisper|tts|audio|speech|dall-?e|image|moderation|transcribe|realtime|search|rerank|clip|guard/i;

  function generate({ apiKey, baseUrl, modelId, systemPrompt, userPrompt, deps = {} }) {
    return NS.aiChat.chatCompletion({
      url: `${baseUrl || DEFAULT_BASE}/chat/completions`,
      apiKey,
      modelId,
      systemPrompt,
      userPrompt,
      providerLabel: LABEL,
      deps
    });
  }

  async function listModels({ apiKey, baseUrl, deps = {} }) {
    const data = await NS.aiHttp.request({
      url: `${baseUrl || DEFAULT_BASE}/models`,
      headers: { Authorization: `Bearer ${apiKey}` },
      secrets: [apiKey],
      ...deps
    });
    const out = (data?.data || [])
      .filter((m) => typeof m?.id === 'string' && !NOT_TEXT_RE.test(m.id))
      .map((m) => ({ id: m.id, label: m.id, confirmed: false }));
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  NS.aiProviderOpenAI = { id: 'openai', label: 'OpenAI API', generate, listModels };
})();
