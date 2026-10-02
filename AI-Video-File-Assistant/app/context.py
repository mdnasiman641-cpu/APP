"""Application context: the shared services every window needs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.config.settings import SettingsManager
from app.database.database import Database
from app.i18n import tr
from app.utils.helpers import get_app_data_dir
from app.utils.security import SecretStore, default_backend

DEFAULT_PROMPTS = (
    ("prompt.default.blue_bloods", "prompt.default.blue_bloods.text"),
    ("prompt.default.clean", "prompt.default.clean.text"),
    ("prompt.default.numbering", "prompt.default.numbering.text"),
    ("prompt.default.quality", "prompt.default.quality.text"),
    ("prompt.default.youtube", "prompt.default.youtube.text"),
)


@dataclass(slots=True)
class AppContext:
    """Database + settings + secrets, created once at start-up."""

    data_dir: Path
    db: Database
    settings: SettingsManager

    @classmethod
    def create(cls, data_dir: Path | None = None) -> AppContext:
        data_dir = data_dir or get_app_data_dir()
        data_dir.mkdir(parents=True, exist_ok=True)
        db = Database(data_dir / "app.db")
        secrets = SecretStore(db, default_backend(data_dir))
        ctx = cls(data_dir=data_dir, db=db, settings=SettingsManager(db, secrets))
        ctx.seed_default_prompts()
        interrupted = db.mark_interrupted_operations()
        if interrupted:
            from app.utils.logger import get_logger

            get_logger("app").warning("%d operation(s) were interrupted by a previous crash", interrupted)
        return ctx

    def seed_default_prompts(self) -> None:
        """Create the built-in saved prompts the first time the app runs."""
        if self.db.get_raw("seeded_prompts") == "1":
            return
        if self.db.count_saved_prompts() == 0:
            for name_key, text_key in DEFAULT_PROMPTS:
                self.db.add_saved_prompt(tr(name_key), tr(text_key), "auto")
        self.db.set_raw("seeded_prompts", "1")
