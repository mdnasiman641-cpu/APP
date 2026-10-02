"""From a natural-language command to a validated plan.

1. *Offline first*: simple commands are recognised locally and cost nothing.
2. Otherwise the AI is asked **once per batch**. If its answer to the first batch
   consists of rule actions, those are applied to *all* selected files locally and
   no further requests are made; only per-file (explicit) answers need follow-up
   batches.
3. The answer is parsed strictly, then turned into a plan by the planner.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from app.ai.ai_router import AIRouter, AllProvidersFailed, FallbackConfirm
from app.ai.base_provider import AIRequest
from app.ai.errors import ErrorKind
from app.ai.prompt_builder import BatchInfo, build_request, split_batches
from app.ai.response_parser import ResponseError, parse_response
from app.ai.schemas import Action, ParsedResponse, RejectedAction
from app.config.constants import ProcessingMode, Provider
from app.config.settings import AppSettings
from app.files.local_commands import parse_local_command
from app.files.plan import Plan
from app.files.planner import Planner, PlannerOptions
from app.files.scanner import FileEntry
from app.i18n import tr
from app.utils.logger import get_logger

log = get_logger("pipeline")
ProgressFn = Callable[[int, int, str], None]

_RETRY_NOTE = (
    "\n\nYour previous reply could not be used ({reason}). Reply again with ONLY the JSON object "
    'described in the instructions: {{"actions": [...], "summary": "..."}}.'
)


class PipelineError(Exception):
    """A user-presentable failure while turning a command into a plan."""

    def __init__(self, message: str, *, kind: ErrorKind | None = None, unsafe: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.kind = kind
        self.unsafe = unsafe


class PipelineCancelled(Exception):
    """The user cancelled while the pipeline was waiting on the AI."""


@dataclass(slots=True)
class PipelineRequest:
    """Everything needed to plan one command."""

    command: str
    files: list[FileEntry]
    workspace: Path
    mode: Provider
    processing: ProcessingMode
    settings: AppSettings


@dataclass(slots=True)
class PipelineResult:
    """A ready-to-preview plan plus how it was produced."""

    plan: Plan
    source: str  # "offline" | "ai"
    provider_text: str
    provider_used: str  # "gemini" | "openai" | "offline"
    ai_requests: int = 0
    summary: str = ""
    warnings: list[str] = field(default_factory=list)


def planner_options(settings: AppSettings) -> PlannerOptions:
    """Planner switches derived from the File Operations settings."""
    return PlannerOptions(
        prevent_overwrite=settings.prevent_overwrite,
        duplicate_policy=settings.duplicate_policy,
        delete_mode=settings.delete_mode,
    )


def run_pipeline(
    request: PipelineRequest,
    router: AIRouter,
    *,
    cancel: threading.Event | None = None,
    progress: ProgressFn | None = None,
    confirm_fallback: FallbackConfirm | None = None,
) -> PipelineResult:
    """Plan ``request.command`` for ``request.files`` (offline when possible, otherwise via the AI)."""
    cancel = cancel or threading.Event()
    command = request.command.strip()
    if not command:
        raise PipelineError(tr("pipeline.no_command"))
    if not request.files:
        raise PipelineError(tr("pipeline.no_files"))

    use_local = request.processing == ProcessingMode.OFFLINE_ONLY or (
        request.processing == ProcessingMode.AUTO and request.settings.use_offline_parser
    )
    local = parse_local_command(command) if use_local else None
    warnings: list[str] = []
    if local is not None:
        parsed = ParsedResponse(actions=list(local.actions), summary=local.description)
        source, provider_text, provider_used, requests = "offline", tr("pipeline.offline_used"), "offline", 0
        log.info("Command handled offline (%d actions, %d files)", len(parsed.actions), len(request.files))
    elif request.processing == ProcessingMode.OFFLINE_ONLY:
        raise PipelineError(tr("pipeline.offline_cannot"))
    else:
        parsed, provider_text, provider_used, requests = _ask_ai(request, command, router, cancel, progress, confirm_fallback)
        source = "ai"

    warnings.extend(parsed.warnings)
    plan = Planner(request.workspace, request.files, planner_options(request.settings)).build(
        parsed.actions, parsed.rejected, summary=parsed.summary
    )
    log.info("Pipeline done: source=%s provider=%s requests=%d ops=%d", source, provider_used, requests, len(plan.ops))
    return PipelineResult(
        plan=plan, source=source, provider_text=provider_text, provider_used=provider_used,
        ai_requests=requests, summary=parsed.summary, warnings=warnings,
    )  # fmt: skip


def _ask_ai(
    request: PipelineRequest,
    command: str,
    router: AIRouter,
    cancel: threading.Event,
    progress: ProgressFn | None,
    confirm_fallback: FallbackConfirm | None,
) -> tuple[ParsedResponse, str, str, int]:
    files = request.files
    batches = split_batches(files, request.settings.batch_size)
    actions: list[Action] = []
    rejected: list[RejectedAction] = []
    warnings: list[str] = []
    summaries: list[str] = []
    texts: list[str] = []
    used: list[str] = []
    requests = 0
    explicit_only = False
    first_item = 1
    for index, batch in enumerate(batches, start=1):
        if cancel.is_set():
            raise PipelineCancelled
        info = BatchInfo(index, len(batches), first_item, first_item + len(batch) - 1)
        first_item += len(batch)
        if progress is not None:
            progress(index - 1, len(batches), tr("pipeline.asking", index=index, count=len(batches)))
        ai_request = build_request(
            command, batch, info,
            folder_name=request.workspace.name or "folder",
            total_selected=len(files),
            explicit_only=explicit_only,
            include_metadata=request.settings.send_metadata_to_ai,
        )  # fmt: skip
        parsed, route_text, provider, count = _request_once(ai_request, request.mode, router, confirm_fallback, cancel)
        requests += count
        if route_text not in texts:
            texts.append(route_text)
        if provider not in used:
            used.append(provider)
        if explicit_only:
            kept = [a for a in parsed.actions if not a.is_rule]
            if len(kept) != len(parsed.actions):
                warnings.append(tr("pipeline.ignored_rules", index=index))
            parsed.actions = kept
        actions.extend(parsed.actions)
        rejected.extend(parsed.rejected)
        warnings.extend(parsed.warnings)
        if parsed.summary:
            summaries.append(parsed.summary)
        if len(batches) == 1 or (index == 1 and (not parsed.actions or any(a.is_rule for a in parsed.actions))):
            break  # rules (or nothing to do) cover every file - no further requests needed
        explicit_only = True
    if progress is not None:
        progress(len(batches), len(batches), tr("pipeline.planning"))
    merged = ParsedResponse(actions=actions, summary=summaries[0] if summaries else "", rejected=rejected, warnings=warnings)
    return merged, " · ".join(texts), "+".join(used), requests


def _request_once(
    ai_request: AIRequest,
    mode: Provider,
    router: AIRouter,
    confirm_fallback: FallbackConfirm | None,
    cancel: threading.Event,
) -> tuple[ParsedResponse, str, str, int]:
    """One batch: call the router, parse; retry once (same request + reminder) if the JSON is unusable."""
    count = 0
    current = ai_request
    for attempt in (1, 2):
        try:
            route = router.generate(current, mode, confirm_fallback=confirm_fallback)
        except AllProvidersFailed as exc:
            raise PipelineError(exc.user_message, kind=exc.kind) from exc
        count += 1
        if cancel.is_set():
            raise PipelineCancelled
        try:
            parsed = parse_response(route.response.text)
        except ResponseError as exc:
            if exc.unsafe:
                log.warning("Unsafe AI answer rejected: %s", exc)
                raise PipelineError(tr("pipeline.unsafe", detail=str(exc)), unsafe=True) from exc
            if route.response.truncated:
                raise PipelineError(tr("pipeline.truncated")) from exc
            if attempt == 2:
                raise PipelineError(tr("pipeline.invalid_json", detail=str(exc)), kind=ErrorKind.INVALID_RESPONSE) from exc
            log.warning("Unusable AI answer (%s); retrying once", exc)
            current = AIRequest(ai_request.system_prompt, ai_request.user_prompt + _RETRY_NOTE.format(reason=exc))
            continue
        return parsed, route.status_text, route.provider_used, count
    raise AssertionError("unreachable")  # pragma: no cover
