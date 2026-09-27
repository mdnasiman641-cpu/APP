/*
 * Shared chat-completions client for the OpenAI-compatible providers
 * (OpenAI itself and OpenRouter). The body stays minimal — model + messages — because
 * extra parameters such as temperature are rejected outright by some models, and a
 * rejected body is a prompt-level error that must not trigger failover.
 */
(() => {
  const NS = (globalThis.FBRA = globalThis.FBRA || {});
  const { request, AiHttpError } = NS.aiHttp;

  function extractText(data, providerLabel) {
    const choice = data?.choices?.[0];
    const message = choice?.message;
    let text = '';
    if (typeof message?.content === 'string') text = message.content;
    else if (Array.isArray(message?.content)) {
      // Some models answer with content parts instead of a plain string.
      text = message.content
        .map((p) => (typeof p === 'string' ? p : p?.text || ''))
        .join('')
        .trim();
    }
    text = String(text || '').trim();
    if (!text) {
      const reason = choice?.finish_reason || data?.error?.message || 'empty response';
      throw new AiHttpError(`${providerLabel} returned no text (${reason})`, { status: 502 });
    }
    return NS.aiPrompt.cleanText(text);
  }

  async function chatCompletion({ url, apiKey, extraHeaders = {}, modelId, systemPrompt, userPrompt, providerLabel, deps = {} }) {
    const data = await request({
      url,
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders },
      secrets: [apiKey],
      body: {
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      },
      ...deps
    });
    return extractText(data, providerLabel);
  }

  NS.aiChat = { chatCompletion, extractText };
})();
