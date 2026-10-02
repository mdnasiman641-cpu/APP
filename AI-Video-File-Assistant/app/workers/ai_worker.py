"""Workers that talk to AI providers."""

from __future__ import annotations

from app.ai.base_provider import ConnectionResult
from app.ai.errors import AIError
from app.ai.ai_router import PROVIDER_CLASSES
from app.workers.base_worker import BaseWorker


class ConnectionTestWorker(BaseWorker):
    """*Test Connection* in Settings: lists models with the given key (no tokens are spent)."""

    def __init__(self, provider_id: str, api_key: str, model: str, timeout: float) -> None:
        super().__init__()
        self.provider_id = provider_id
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def execute(self) -> ConnectionResult:
        cls = PROVIDER_CLASSES[self.provider_id]
        try:
            provider = cls(self.api_key, self.model, self.timeout)
        except AIError as exc:
            return ConnectionResult(False, exc.user_message)
        return provider.test_connection()
