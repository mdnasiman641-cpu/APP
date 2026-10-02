"""Google Gemini provider (REST ``generateContent``).

The API key travels in the ``x-goog-api-key`` header - never in the URL - so it
cannot leak through logs or proxies that record request lines.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from app.ai.base_provider import AIProvider, AIRequest, AIResponse
from app.ai.errors import AIError, ErrorKind
from app.ai.http_client import request_json
from app.config.constants import GEMINI_API_BASE, Provider
from app.utils.logger import get_logger

log = get_logger("ai.gemini")


class GeminiProvider(AIProvider):
    """Calls the Gemini API; the model name is supplied by configuration."""

    id = Provider.GEMINI.value
    display_name = "Gemini"

    def _headers(self) -> dict[str, str]:
        return {"x-goog-api-key": self._api_key}

    def generate(self, request: AIRequest) -> AIResponse:
        url = f"{GEMINI_API_BASE}/models/{quote(self.model, safe='/')}:generateContent"
        payload: dict[str, Any] = {
            "systemInstruction": {"parts": [{"text": request.system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": request.user_prompt}]}],
            "generationConfig": {"responseMimeType": "application/json"},
        }
        log.info("Gemini request (model=%s, %d chars)", self.model, len(request.user_prompt))
        data = request_json(self.id, "POST", url, headers=self._headers(), payload=payload, timeout=self.timeout)
        return self._parse(data)

    def _parse(self, data: dict[str, Any]) -> AIResponse:
        candidates = data.get("candidates") or []
        if not candidates:
            block = (data.get("promptFeedback") or {}).get("blockReason")
            if block:
                raise AIError(ErrorKind.BLOCKED, self.id, f"Request was blocked by Gemini ({block}).")
            raise AIError(ErrorKind.INVALID_RESPONSE, self.id, "Gemini returned no answer.")
        candidate = candidates[0]
        parts = (candidate.get("content") or {}).get("parts") or []
        text = "".join(str(p.get("text", "")) for p in parts if isinstance(p, dict) and not p.get("thought"))
        finish = str(candidate.get("finishReason", ""))
        if not text.strip():
            if finish in {"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION"}:
                raise AIError(ErrorKind.BLOCKED, self.id, f"Gemini declined to answer ({finish}).")
            raise AIError(ErrorKind.INVALID_RESPONSE, self.id, "Gemini returned an empty answer.")
        usage = data.get("usageMetadata") or {}
        return AIResponse(
            text=text,
            provider=self.id,
            model=self.model,
            truncated=finish == "MAX_TOKENS",
            usage={
                "input_tokens": int(usage.get("promptTokenCount", 0) or 0),
                "output_tokens": int(usage.get("candidatesTokenCount", 0) or 0),
            },
        )

    def list_models(self) -> list[str]:
        url = f"{GEMINI_API_BASE}/models?pageSize=200"
        data = request_json(self.id, "GET", url, headers=self._headers(), timeout=min(self.timeout, 30))
        names: list[str] = []
        for item in data.get("models") or []:
            if not isinstance(item, dict):
                continue
            methods = item.get("supportedGenerationMethods") or []
            if methods and "generateContent" not in methods:
                continue
            name = str(item.get("name", "")).removeprefix("models/")
            if name:
                names.append(name)
        return sorted(names)
