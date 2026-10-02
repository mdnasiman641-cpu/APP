"""Provider abstraction: every AI backend implements :class:`AIProvider`."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from app.ai.errors import AIError, ErrorKind
from app.i18n import tr


@dataclass(frozen=True, slots=True)
class AIRequest:
    """What we ask a model: a fixed system prompt and one user message."""

    system_prompt: str
    user_prompt: str


@dataclass(slots=True)
class AIResponse:
    """Raw model output plus bookkeeping."""

    text: str
    provider: str
    model: str
    truncated: bool = False  # the model hit its output limit
    usage: dict[str, int] = field(default_factory=dict)


@dataclass(slots=True)
class ConnectionResult:
    """Result of *Test Connection* in Settings."""

    ok: bool
    message: str
    models: list[str] = field(default_factory=list)


class AIProvider(ABC):
    """A configured connection to one AI vendor."""

    id: str = ""
    display_name: str = ""

    def __init__(self, api_key: str, model: str, timeout: float = 60) -> None:
        if not api_key:
            raise AIError(ErrorKind.NO_KEY, self.id)
        self._api_key = api_key
        self.model = model
        self.timeout = timeout

    @abstractmethod
    def generate(self, request: AIRequest) -> AIResponse:
        """Send ``request`` and return the model's JSON answer (raises :class:`AIError`)."""

    @abstractmethod
    def list_models(self) -> list[str]:
        """Model ids available to this key. Also serves as a cheap credential check."""

    def test_connection(self) -> ConnectionResult:
        """Verify the key (and that the configured model exists) without spending tokens."""
        try:
            models = self.list_models()
        except AIError as exc:
            return ConnectionResult(False, exc.user_message)
        if models and self.model not in models:
            return ConnectionResult(True, tr("ai.test.model_missing", model=self.model, count=len(models)), models)
        return ConnectionResult(True, tr("ai.test.ok", model=self.model, count=len(models)), models)
