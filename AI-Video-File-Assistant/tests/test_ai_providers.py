"""Gemini / OpenAI providers against a real local HTTP server, plus the router's fallback logic."""

from __future__ import annotations

import json

import pytest

from app.ai import gemini_provider, openai_provider
from app.ai.ai_router import AIRouter, AllProvidersFailed, make_provider_factory
from app.ai.base_provider import AIProvider, AIRequest, AIResponse
from app.ai.errors import AIError, ErrorKind
from app.ai.gemini_provider import GeminiProvider
from app.ai.openai_provider import OpenAIProvider
from app.config.constants import Provider
from tests.fake_ai_server import FakeAIServer, gemini_ok, openai_ok

REQUEST = AIRequest(system_prompt="SYSTEM JSON", user_prompt="USER {…}")
SECRET = "AIzaSySECRETKEY1234567890abcdefghijklm"


@pytest.fixture
def server(monkeypatch):
    with FakeAIServer() as srv:
        monkeypatch.setattr(gemini_provider, "GEMINI_API_BASE", srv.base)
        monkeypatch.setattr(openai_provider, "OPENAI_API_BASE", srv.base)
        yield srv


# ----------------------------------------------------------------- Gemini
def test_gemini_success_sends_key_in_header_not_url(server):
    server.queue(200, gemini_ok('{"actions": []}'))
    result = GeminiProvider(SECRET, "my-model", 5).generate(REQUEST)
    assert json.loads(result.text) == {"actions": []}
    assert result.provider == "gemini" and result.model == "my-model" and not result.truncated
    sent = server.requests[0]
    assert sent["path"] == "/models/my-model:generateContent"
    assert SECRET not in sent["path"]  # never in the URL
    assert sent["headers"]["x-goog-api-key"] == SECRET
    body = json.loads(sent["body"])
    assert body["systemInstruction"]["parts"][0]["text"] == "SYSTEM JSON"
    assert body["contents"][0]["parts"][0]["text"] == "USER {…}"
    assert body["generationConfig"]["responseMimeType"] == "application/json"


def test_gemini_model_comes_from_config_only(server):
    server.queue(200, gemini_ok("{}"))
    GeminiProvider("k", "gemini-future-9", 5).generate(REQUEST)
    assert "gemini-future-9" in server.requests[0]["path"]


def test_gemini_skips_thought_parts_and_flags_truncation(server):
    server.queue(200, {"candidates": [{"content": {"parts": [{"text": "thinking", "thought": True}, {"text": '{"actions":'}]}, "finishReason": "MAX_TOKENS"}]})
    result = GeminiProvider("k", "m", 5).generate(REQUEST)
    assert result.text == '{"actions":' and result.truncated


def test_gemini_blocked_prompt(server):
    server.queue(200, {"promptFeedback": {"blockReason": "SAFETY"}})
    with pytest.raises(AIError) as err:
        GeminiProvider("k", "m", 5).generate(REQUEST)
    assert err.value.kind == ErrorKind.BLOCKED


def test_gemini_invalid_key_is_auth_error(server):
    server.queue(400, {"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT"}})
    with pytest.raises(AIError) as err:
        GeminiProvider("bad", "m", 5).generate(REQUEST)
    assert err.value.kind == ErrorKind.AUTH
    assert "Gemini request failed." in err.value.user_message and "Authentication" in err.value.user_message


def test_gemini_list_models_filters_to_generate_content(server):
    server.queue(200, {"models": [
        {"name": "models/gemini-a", "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/embed", "supportedGenerationMethods": ["embedContent"]},
    ]})
    assert GeminiProvider("k", "gemini-a", 5).list_models() == ["gemini-a"]


# ----------------------------------------------------------------- OpenAI
def test_openai_success_and_request_shape(server):
    server.queue(200, openai_ok('{"actions": []}'))
    result = OpenAIProvider("sk-test-1234567890abcdef", "my-gpt", 5).generate(REQUEST)
    assert json.loads(result.text) == {"actions": []} and result.provider == "openai"
    sent = server.requests[0]
    assert sent["path"] == "/chat/completions"
    assert sent["headers"]["authorization"] == "Bearer sk-test-1234567890abcdef"
    body = json.loads(sent["body"])
    assert body["model"] == "my-gpt"
    assert body["response_format"] == {"type": "json_object"}
    assert [m["role"] for m in body["messages"]] == ["system", "user"]


def test_openai_refusal_and_empty(server):
    server.queue(200, {"choices": [{"message": {"content": None, "refusal": "no"}, "finish_reason": "stop"}]})
    with pytest.raises(AIError) as err:
        OpenAIProvider("k", "m", 5).generate(REQUEST)
    assert err.value.kind == ErrorKind.BLOCKED
    server.queue(200, {"choices": []})
    with pytest.raises(AIError) as err2:
        OpenAIProvider("k", "m", 5).generate(REQUEST)
    assert err2.value.kind == ErrorKind.INVALID_RESPONSE


def test_openai_list_models_keeps_chat_models(server):
    server.queue(200, {"data": [{"id": "gpt-4o-mini"}, {"id": "text-embedding-3-small"}, {"id": "whisper-1"}, {"id": "o3-mini"}, {"id": "gpt-4o-audio-preview"}]})
    assert OpenAIProvider("k", "gpt-4o-mini", 5).list_models() == ["gpt-4o-mini", "o3-mini"]


# ------------------------------------------------------- failure handling
@pytest.mark.parametrize(
    ("status", "body", "kind"),
    [
        (401, {"error": {"message": "Incorrect API key provided"}}, ErrorKind.AUTH),
        (403, {"error": {"message": "forbidden"}}, ErrorKind.AUTH),
        (429, {"error": {"message": "Rate limit reached"}}, ErrorKind.RATE_LIMIT),
        (404, {"error": {"message": "The model `x` does not exist"}}, ErrorKind.MODEL_NOT_FOUND),
        (500, {"error": {"message": "boom"}}, ErrorKind.SERVER),
        (503, {"error": {"message": "overloaded"}}, ErrorKind.SERVER),
        (400, {"error": {"message": "bad param"}}, ErrorKind.BAD_REQUEST),
    ],
)
def test_http_errors_map_to_friendly_kinds(server, status, body, kind):
    server.queue(status, body)
    with pytest.raises(AIError) as err:
        OpenAIProvider("k", "m", 5).generate(REQUEST)
    assert err.value.kind == kind
    assert err.value.user_message  # always something to show the user


def test_timeout_is_reported(server):
    server.queue(200, openai_ok("{}"), delay=1.5)
    with pytest.raises(AIError) as err:
        OpenAIProvider("k", "m", timeout=0.3).generate(REQUEST)
    assert err.value.kind == ErrorKind.TIMEOUT


def test_network_unreachable(monkeypatch):
    monkeypatch.setattr(openai_provider, "OPENAI_API_BASE", "http://127.0.0.1:1")  # nothing listens
    with pytest.raises(AIError) as err:
        OpenAIProvider("k", "m", 3).generate(REQUEST)
    assert err.value.kind == ErrorKind.NETWORK


def test_non_json_body_is_invalid_response(server):
    server.queue(200, b"<html>captive portal</html>")
    with pytest.raises(AIError) as err:
        GeminiProvider("k", "m", 5).generate(REQUEST)
    assert err.value.kind == ErrorKind.INVALID_RESPONSE


def test_missing_key_is_rejected_up_front():
    with pytest.raises(AIError) as err:
        GeminiProvider("", "m")
    assert err.value.kind == ErrorKind.NO_KEY


def test_error_details_never_leak_the_key(server):
    server.queue(400, {"error": {"message": f"bad key {SECRET}"}})
    from app.utils.security import register_secret

    register_secret(SECRET)
    with pytest.raises(AIError) as err:
        GeminiProvider(SECRET, "m", 5).generate(REQUEST)
    assert SECRET not in str(err.value) and SECRET not in err.value.user_message


def test_test_connection_reports_ok_and_failure(server):
    server.queue(200, {"data": [{"id": "gpt-4o-mini"}]})
    ok = OpenAIProvider("k", "gpt-4o-mini", 5).test_connection()
    assert ok.ok and ok.models == ["gpt-4o-mini"]
    server.queue(200, {"data": [{"id": "gpt-4o-mini"}]})
    missing = OpenAIProvider("k", "nope", 5).test_connection()
    assert missing.ok and "nope" in missing.message
    server.queue(401, {"error": {"message": "Incorrect API key"}})
    bad = OpenAIProvider("k", "m", 5).test_connection()
    assert not bad.ok and "Authentication" in bad.message


# ----------------------------------------------------------------- router
class FakeProvider(AIProvider):
    def __init__(self, pid: str, *, fail: ErrorKind | None = None, text: str = '{"actions":[]}') -> None:
        self.id = pid
        self.display_name = pid
        self._fail, self._text = fail, text
        self.calls = 0
        self.model = "m"

    def __init_subclass__(cls) -> None:  # pragma: no cover
        super().__init_subclass__()

    def generate(self, request):
        self.calls += 1
        if self._fail:
            raise AIError(self._fail, self.id, "simulated")
        return AIResponse(self._text, self.id, "m")

    def list_models(self):
        return []


def router_with(providers: dict, **kw) -> AIRouter:
    return AIRouter(lambda pid: providers.get(pid), **kw)


def test_explicit_provider_never_falls_back():
    g, o = FakeProvider("gemini", fail=ErrorKind.NETWORK), FakeProvider("openai")
    r = router_with({"gemini": g, "openai": o})
    with pytest.raises(AllProvidersFailed) as err:
        r.generate(REQUEST, Provider.GEMINI)
    assert o.calls == 0 and err.value.kind == ErrorKind.NETWORK
    assert "Gemini request failed." in err.value.user_message


def test_auto_uses_preferred_provider_and_reports_it():
    g, o = FakeProvider("gemini"), FakeProvider("openai")
    result = router_with({"gemini": g, "openai": o}).generate(REQUEST, Provider.AUTO)
    assert result.provider_used == "gemini" and not result.fell_back and o.calls == 0
    assert result.status_text == "Gemini ✓"


def test_auto_preferred_can_be_openai():
    g, o = FakeProvider("gemini"), FakeProvider("openai")
    result = router_with({"gemini": g, "openai": o}, preferred="openai").generate(REQUEST, Provider.AUTO)
    assert result.provider_used == "openai"


def test_auto_falls_back_and_says_so():
    g, o = FakeProvider("gemini", fail=ErrorKind.RATE_LIMIT), FakeProvider("openai")
    result = router_with({"gemini": g, "openai": o}).generate(REQUEST, Provider.AUTO)
    assert result.provider_used == "openai" and result.fell_back
    assert result.status_text == "Gemini failed → OpenAI fallback ✓"
    assert [a.provider for a in result.attempts] == ["gemini", "openai"]


def test_auto_with_fallback_disabled_fails():
    g, o = FakeProvider("gemini", fail=ErrorKind.TIMEOUT), FakeProvider("openai")
    with pytest.raises(AllProvidersFailed):
        router_with({"gemini": g, "openai": o}, fallback_mode="off").generate(REQUEST, Provider.AUTO)
    assert o.calls == 0


def test_auto_ask_mode_requires_confirmation():
    g, o = FakeProvider("gemini", fail=ErrorKind.NETWORK), FakeProvider("openai")
    r = router_with({"gemini": g, "openai": o}, fallback_mode="ask")
    asked = []
    result = r.generate(REQUEST, Provider.AUTO, confirm_fallback=lambda f, e, n: asked.append((f, n)) or True)
    assert asked == [("gemini", "openai")] and result.provider_used == "openai"
    with pytest.raises(AllProvidersFailed):
        r.generate(REQUEST, Provider.AUTO, confirm_fallback=lambda f, e, n: False)
    with pytest.raises(AllProvidersFailed):
        r.generate(REQUEST, Provider.AUTO)  # no confirm callback => never silently switch


def test_auto_skips_provider_without_key_and_reports_it():
    o = FakeProvider("openai")
    result = router_with({"openai": o}).generate(REQUEST, Provider.AUTO)
    assert result.provider_used == "openai"
    assert result.status_text == "Gemini has no API key → OpenAI ✓"


def test_both_fail_lists_both_errors():
    g, o = FakeProvider("gemini", fail=ErrorKind.AUTH), FakeProvider("openai", fail=ErrorKind.NETWORK)
    with pytest.raises(AllProvidersFailed) as err:
        router_with({"gemini": g, "openai": o}).generate(REQUEST, Provider.AUTO)
    assert "Gemini request failed." in err.value.user_message and "OpenAI request failed." in err.value.user_message


def test_no_keys_at_all_gives_actionable_message():
    with pytest.raises(AllProvidersFailed) as err:
        router_with({}).generate(REQUEST, Provider.AUTO)
    assert "API key" in err.value.user_message and err.value.kind == ErrorKind.NO_KEY


def test_factory_builds_providers_from_current_settings(tmp_path):
    from app.context import AppContext

    ctx = AppContext.create(tmp_path / "d")
    factory = make_provider_factory(ctx.settings)
    assert factory("gemini") is None
    ctx.settings.set_api_key("gemini", "AIzaSyKEY-1234567890-abcdefghijklmn")
    ctx.settings.update(gemini_model="custom-model", request_timeout_s=33)
    provider = factory("gemini")
    assert isinstance(provider, GeminiProvider) and provider.model == "custom-model" and provider.timeout == 33
