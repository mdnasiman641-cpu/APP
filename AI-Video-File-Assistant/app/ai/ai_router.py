"""Chooses the AI provider and handles fallback.

Modes: *Gemini*, *OpenAI* or *Auto*. Only Auto may switch providers, and every
switch is recorded and reported - the app never silently changes provider.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from app.ai.base_provider import AIProvider, AIRequest, AIResponse
from app.ai.errors import AIError, ErrorKind, provider_name
from app.ai.gemini_provider import GeminiProvider
from app.ai.openai_provider import OpenAIProvider
from app.config.constants import Provider
from app.config.settings import SettingsManager
from app.i18n import tr
from app.utils.logger import get_logger

log = get_logger("ai.router")

ProviderFactory = Callable[[str], AIProvider | None]
FallbackConfirm = Callable[[str, AIError, str], bool]
PROVIDER_CLASSES: dict[str, type[AIProvider]] = {
    Provider.GEMINI.value: GeminiProvider,
    Provider.OPENAI.value: OpenAIProvider,
}


@dataclass(slots=True)
class Attempt:
    """One provider call made while serving a request."""

    provider: str
    error: AIError | None = None
    skipped_reason: str = ""

    @property
    def ok(self) -> bool:
        return self.error is None and not self.skipped_reason


@dataclass(slots=True)
class RouteResult:
    """A successful answer together with how it was obtained."""

    response: AIResponse
    attempts: list[Attempt] = field(default_factory=list)

    @property
    def provider_used(self) -> str:
        return self.response.provider

    @property
    def fell_back(self) -> bool:
        return any(not a.ok for a in self.attempts)

    @property
    def status_text(self) -> str:
        """``Gemini ✓`` / ``Gemini failed → OpenAI fallback ✓`` / ``Gemini has no key → OpenAI ✓``."""
        used = provider_name(self.provider_used)
        failed = [provider_name(a.provider) for a in self.attempts if a.error is not None]
        skipped = [provider_name(a.provider) for a in self.attempts if a.skipped_reason]
        if failed:
            return tr("ai.status.fallback", failed=", ".join(failed), used=used)
        if skipped:
            return tr("ai.status.skipped", skipped=", ".join(skipped), used=used)
        return tr("ai.status.ok", provider=used)


class AllProvidersFailed(Exception):
    """Raised when no provider produced an answer; carries every attempt."""

    def __init__(self, attempts: list[Attempt]) -> None:
        self.attempts = attempts
        self.errors = [a.error for a in attempts if a.error is not None]
        self.last_error: AIError | None = self.errors[-1] if self.errors else None
        super().__init__(self.user_message)

    @property
    def user_message(self) -> str:
        if not self.errors:
            skipped = [provider_name(a.provider) for a in self.attempts]
            return tr("ai.no_keys", providers=", ".join(skipped) or "-")
        return "\n".join(e.user_message for e in self.errors)

    @property
    def kind(self) -> ErrorKind:
        return self.last_error.kind if self.last_error else ErrorKind.NO_KEY


class AIRouter:
    """Routes a request to Gemini, OpenAI or both (Auto)."""

    def __init__(
        self,
        factory: ProviderFactory,
        *,
        preferred: str = Provider.GEMINI.value,
        fallback_mode: str = "automatic",
    ) -> None:
        self._factory = factory
        self.preferred = preferred if preferred in PROVIDER_CLASSES else Provider.GEMINI.value
        self.fallback_mode = fallback_mode

    def order(self, mode: Provider | str) -> list[str]:
        """Providers to try, in order, for ``mode``."""
        mode_value = mode.value if isinstance(mode, Provider) else str(mode)
        if mode_value in PROVIDER_CLASSES:
            return [mode_value]
        other = Provider.OPENAI.value if self.preferred == Provider.GEMINI.value else Provider.GEMINI.value
        return [self.preferred, other]

    def generate(
        self,
        request: AIRequest,
        mode: Provider | str,
        *,
        confirm_fallback: FallbackConfirm | None = None,
    ) -> RouteResult:
        """Send ``request``; in Auto mode fall back to the other provider when allowed."""
        order = self.order(mode)
        auto = len(order) > 1
        attempts: list[Attempt] = []
        for position, provider_id in enumerate(order):
            provider = self._factory(provider_id)
            if provider is None:
                attempts.append(Attempt(provider_id, skipped_reason="no_key"))
                log.info("%s skipped: no API key configured", provider_id)
                if not auto:
                    raise AllProvidersFailed(attempts)
                continue
            try:
                response = provider.generate(request)
            except AIError as exc:
                log.warning("%s failed (%s): %s", provider_id, exc.kind.value, exc.detail)
                attempts.append(Attempt(provider_id, error=exc))
                remaining = order[position + 1 :]
                can_fall_back = auto and bool(remaining) and exc.allows_fallback and self.fallback_mode != "off"
                if not can_fall_back:
                    raise AllProvidersFailed(attempts) from None
                if self.fallback_mode == "ask" and not (
                    confirm_fallback is not None and confirm_fallback(provider_id, exc, remaining[0])
                ):
                    raise AllProvidersFailed(attempts) from None
                log.info("Falling back from %s to %s", provider_id, remaining[0])
                continue
            attempts.append(Attempt(provider_id))
            result = RouteResult(response, attempts)
            log.info("AI provider used: %s%s", provider_id, " (after fallback)" if result.fell_back else "")
            return result
        raise AllProvidersFailed(attempts)


def make_provider_factory(settings: SettingsManager) -> ProviderFactory:
    """Build providers from the *current* settings and stored keys each time they are needed."""

    def factory(provider_id: str) -> AIProvider | None:
        cls = PROVIDER_CLASSES.get(provider_id)
        key = settings.api_key(provider_id)
        if cls is None or not key:
            return None
        current = settings.load()
        return cls(key, current.model_for(provider_id), current.request_timeout_s)

    return factory


def make_router(settings: SettingsManager) -> AIRouter:
    """Router configured from saved settings."""
    current = settings.load()
    return AIRouter(
        make_provider_factory(settings),
        preferred=current.auto_preferred_provider,
        fallback_mode=current.fallback_mode,
    )
