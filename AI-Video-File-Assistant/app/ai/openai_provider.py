"""OpenAI provider (Chat Completions with JSON mode)."""

from __future__ import annotations

import re
from typing import Any

from app.ai.base_provider import AIProvider, AIRequest, AIResponse
from app.ai.errors import AIError, ErrorKind
from app.ai.http_client import request_json
from app.config.constants import OPENAI_API_BASE, Provider
from app.utils.logger import get_logger

log = get_logger("ai.openai")

_CHAT_MODEL = re.compile(r"^(gpt-|chatgpt-|o\d)")
_NOT_CHAT = re.compile(r"(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|whisper|dall)")


class OpenAIProvider(AIProvider):
    """Calls the OpenAI API; the model name is supplied by configuration."""

    id = Provider.OPENAI.value
    display_name = "OpenAI"

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}"}

    def generate(self, request: AIRequest) -> AIResponse:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": request.system_prompt},
                {"role": "user", "content": request.user_prompt},
            ],
            "response_format": {"type": "json_object"},
        }
        log.info("OpenAI request (model=%s, %d chars)", self.model, len(request.user_prompt))
        data = request_json(
            self.id, "POST", f"{OPENAI_API_BASE}/chat/completions",
            headers=self._headers(), payload=payload, timeout=self.timeout,
        )  # fmt: skip
        return self._parse(data)

    def _parse(self, data: dict[str, Any]) -> AIResponse:
        choices = data.get("choices") or []
        if not choices or not isinstance(choices[0], dict):
            raise AIError(ErrorKind.INVALID_RESPONSE, self.id, "OpenAI returned no answer.")
        choice = choices[0]
        message = choice.get("message") or {}
        if message.get("refusal"):
            raise AIError(ErrorKind.BLOCKED, self.id, f"OpenAI declined: {message['refusal']}")
        text = str(message.get("content") or "")
        if not text.strip():
            raise AIError(ErrorKind.INVALID_RESPONSE, self.id, "OpenAI returned an empty answer.")
        usage = data.get("usage") or {}
        return AIResponse(
            text=text,
            provider=self.id,
            model=self.model,
            truncated=choice.get("finish_reason") == "length",
            usage={
                "input_tokens": int(usage.get("prompt_tokens", 0) or 0),
                "output_tokens": int(usage.get("completion_tokens", 0) or 0),
            },
        )

    def list_models(self) -> list[str]:
        data = request_json(
            self.id, "GET", f"{OPENAI_API_BASE}/models", headers=self._headers(), timeout=min(self.timeout, 30)
        )
        ids = [str(m.get("id", "")) for m in data.get("data") or [] if isinstance(m, dict)]
        return sorted(i for i in ids if _CHAT_MODEL.match(i) and not _NOT_CHAT.search(i))
