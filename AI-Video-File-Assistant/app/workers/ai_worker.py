"""Workers that talk to AI providers."""

from __future__ import annotations

import threading

from PySide6.QtCore import Signal

from app.ai.ai_router import PROVIDER_CLASSES, AIRouter
from app.ai.base_provider import ConnectionResult
from app.ai.errors import AIError, provider_name
from app.ai.pipeline import PipelineCancelled, PipelineError, PipelineRequest, PipelineResult, run_pipeline
from app.workers.base_worker import BaseWorker, CancelledError, WorkerSignals


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


class PlanSignals(WorkerSignals):
    """Adds the "ask before falling back" question to the standard signals."""

    fallback_requested = Signal(str, str, str)  # failed provider name, reason, next provider name


class PlanWorker(BaseWorker):
    """Turns a command into a plan (offline parse or AI) without blocking the UI."""

    signals_class = PlanSignals

    def __init__(self, request: PipelineRequest, router: AIRouter) -> None:
        super().__init__()
        self.request = request
        self.router = router
        self._answer = False
        self._answered = threading.Event()

    def execute(self) -> PipelineResult:
        try:
            return run_pipeline(
                self.request, self.router, cancel=self.cancel_event, progress=self.emit_progress,
                confirm_fallback=self._ask_fallback,
            )  # fmt: skip
        except PipelineCancelled:
            raise CancelledError from None

    # -- fallback question -----------------------------------------------
    def _ask_fallback(self, failed: str, error: AIError, next_provider: str) -> bool:
        self._answered.clear()
        self.signals.fallback_requested.emit(provider_name(failed), error.user_message, provider_name(next_provider))  # type: ignore[attr-defined]
        self._answered.wait(timeout=300)
        return self._answer and not self.cancel_event.is_set()

    def answer_fallback(self, accept: bool) -> None:
        """Called from the UI thread with the user's decision."""
        self._answer = accept
        self._answered.set()

    def cancel(self) -> None:
        super().cancel()
        self._answered.set()  # unblock a pending question

    def friendly_error(self, exc: BaseException) -> str:
        if isinstance(exc, PipelineError):
            return exc.message
        return super().friendly_error(exc)
