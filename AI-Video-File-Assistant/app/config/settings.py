"""Typed application settings persisted in SQLite.

``AppSettings`` is a plain dataclass; :class:`SettingsManager` loads/saves it and
owns the encrypted API keys. The set of valid values for choice fields is kept
here so the UI and the rest of the app share one definition.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, fields, replace
from typing import TYPE_CHECKING, Any

from app.config.constants import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_GEMINI_MODEL,
    DEFAULT_OPENAI_MODEL,
    DEFAULT_REQUEST_TIMEOUT_S,
    DEFAULT_SAMPLE_SIZE,
    MAX_BATCH_SIZE,
    Provider,
)

if TYPE_CHECKING:
    from app.database.database import Database
    from app.utils.security import SecretStore

THEMES = ("system", "dark", "light")
LANGUAGES = ("en", "bn")
LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")
FALLBACK_MODES = ("automatic", "ask", "off")
DUPLICATE_POLICIES = ("flag", "number")
DELETE_MODES = ("trash", "permanent")

SECRET_GEMINI = "gemini_api_key"
SECRET_OPENAI = "openai_api_key"


@dataclass(slots=True)
class AppSettings:
    """All user-configurable options with their defaults."""

    # --- AI
    gemini_model: str = DEFAULT_GEMINI_MODEL
    openai_model: str = DEFAULT_OPENAI_MODEL
    default_provider: str = Provider.GEMINI.value
    auto_preferred_provider: str = Provider.GEMINI.value
    fallback_mode: str = "automatic"
    request_timeout_s: int = DEFAULT_REQUEST_TIMEOUT_S
    batch_size: int = DEFAULT_BATCH_SIZE
    sample_size: int = DEFAULT_SAMPLE_SIZE
    use_offline_parser: bool = True
    send_metadata_to_ai: bool = False
    # --- File operations
    ask_before_apply: bool = True
    create_history: bool = True
    prevent_overwrite: bool = True
    include_subfolders: bool = False
    auto_apply: bool = False
    duplicate_policy: str = "flag"
    delete_mode: str = "trash"
    # --- Appearance / general
    theme: str = "system"
    language: str = "en"
    reopen_last_folder: bool = False
    last_folder: str = ""
    log_level: str = "INFO"
    read_metadata: bool = True
    ffmpeg_dir: str = ""
    default_file_filter: str = "video"
    # --- UI state
    window_geometry: str = ""

    def normalised(self) -> AppSettings:
        """Return a copy with every field coerced into its valid range."""
        out = replace(self)
        out.default_provider = _choice(out.default_provider, [p.value for p in Provider], Provider.GEMINI.value)
        out.auto_preferred_provider = _choice(
            out.auto_preferred_provider, [Provider.GEMINI.value, Provider.OPENAI.value], Provider.GEMINI.value
        )
        out.fallback_mode = _choice(out.fallback_mode, FALLBACK_MODES, "automatic")
        out.duplicate_policy = _choice(out.duplicate_policy, DUPLICATE_POLICIES, "flag")
        out.delete_mode = _choice(out.delete_mode, DELETE_MODES, "trash")
        out.theme = _choice(out.theme, THEMES, "system")
        out.language = _choice(out.language, LANGUAGES, "en")
        out.log_level = _choice(str(out.log_level).upper(), LOG_LEVELS, "INFO")
        out.batch_size = max(1, min(int(out.batch_size), MAX_BATCH_SIZE))
        out.sample_size = max(1, min(int(out.sample_size), MAX_BATCH_SIZE))
        out.request_timeout_s = max(5, min(int(out.request_timeout_s), 600))
        out.gemini_model = out.gemini_model.strip() or DEFAULT_GEMINI_MODEL
        out.openai_model = out.openai_model.strip() or DEFAULT_OPENAI_MODEL
        return out

    def model_for(self, provider: str) -> str:
        """The configured model name for ``provider``."""
        return self.gemini_model if provider == Provider.GEMINI.value else self.openai_model


def _choice(value: str, allowed: tuple[str, ...] | list[str], default: str) -> str:
    return value if value in allowed else default


def _decode(raw: str, default: Any) -> Any:
    """Convert a stored string back into the type of ``default``."""
    if isinstance(default, bool):
        return raw.lower() in {"1", "true", "yes", "on"}
    if isinstance(default, int):
        try:
            return int(raw)
        except ValueError:
            return default
    return raw


def _encode(value: Any) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    return str(value)


class SettingsManager:
    """Loads and saves :class:`AppSettings`; also fronts the encrypted API-key store."""

    def __init__(self, db: Database, secrets: SecretStore) -> None:
        self._db = db
        self._secrets = secrets
        self._cache: AppSettings | None = None

    # ------------------------------------------------------------- settings
    def load(self) -> AppSettings:
        """Return the current settings (cached; call :meth:`reload` to re-read)."""
        if self._cache is None:
            stored = self._db.all_settings()
            defaults = AppSettings()
            values: dict[str, Any] = {}
            for f in fields(AppSettings):
                default = getattr(defaults, f.name)
                key = f"pref.{f.name}"
                values[f.name] = _decode(stored[key], default) if key in stored else default
            self._cache = AppSettings(**values).normalised()
        return replace(self._cache)

    def reload(self) -> AppSettings:
        self._cache = None
        return self.load()

    def save(self, settings: AppSettings) -> AppSettings:
        """Validate and persist ``settings``; returns the normalised copy."""
        clean = settings.normalised()
        with self._db.transaction() as conn:
            for f in fields(AppSettings):
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES(?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (f"pref.{f.name}", _encode(getattr(clean, f.name))),
                )
        self._cache = clean
        return replace(clean)

    def update(self, **changes: Any) -> AppSettings:
        """Convenience: change a few fields and save."""
        return self.save(replace(self.load(), **changes))

    # ------------------------------------------------------------- API keys
    def api_key(self, provider: str) -> str | None:
        return self._secrets.get(self._secret_name(provider))

    def has_api_key(self, provider: str) -> bool:
        return self._secrets.has(self._secret_name(provider))

    def set_api_key(self, provider: str, key: str) -> None:
        self._secrets.set(self._secret_name(provider), key)

    def remove_api_key(self, provider: str) -> None:
        self._secrets.delete(self._secret_name(provider))

    def masked_api_key(self, provider: str) -> str:
        return self._secrets.masked(self._secret_name(provider))

    @staticmethod
    def _secret_name(provider: str) -> str:
        if provider == Provider.GEMINI.value:
            return SECRET_GEMINI
        if provider == Provider.OPENAI.value:
            return SECRET_OPENAI
        raise ValueError(f"Unknown provider: {provider}")

    # --------------------------------------------------------------- export
    def export_json(self) -> str:
        """Settings (without secrets) as JSON - handy for support requests."""
        data = {f.name: getattr(self.load(), f.name) for f in fields(AppSettings)}
        data.pop("window_geometry", None)
        return json.dumps(data, indent=2, ensure_ascii=False)
