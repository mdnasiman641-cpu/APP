"""Application-wide constants.

Everything that a maintainer might reasonably want to tweak (model names,
batch sizes, limits) lives here or in :mod:`app.config.settings` so that no
other module hard-codes it.
"""

from __future__ import annotations

import sys
from enum import Enum

APP_NAME = "AI Video File Assistant"
APP_VERSION = "1.0.0"
APP_ORGANIZATION = "AIVideoFileAssistant"
IS_WINDOWS = sys.platform == "win32"

# Windows file systems are case-insensitive; names that differ only by case
# refer to the same file. The planner can be told otherwise (used by tests).
CASE_INSENSITIVE_FS = IS_WINDOWS


class Provider(str, Enum):
    """AI provider identifiers as stored in settings and shown in the UI."""

    GEMINI = "gemini"
    OPENAI = "openai"
    AUTO = "auto"


class ProcessingMode(str, Enum):
    """How a command is processed locally before/instead of calling an AI."""

    AUTO = "auto"  # offline parser for simple commands, AI otherwise
    AI_ONLY = "ai"  # always ask the AI
    OFFLINE_ONLY = "offline"  # never call an AI


class FileKind(str, Enum):
    """Broad file categories used by the filter bar."""

    VIDEO = "video"
    AUDIO = "audio"
    IMAGE = "image"
    DOCUMENT = "document"
    OTHER = "other"


VIDEO_EXTENSIONS = frozenset(
    {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts"}
)
AUDIO_EXTENSIONS = frozenset(
    {".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".opus", ".wma"}
)
IMAGE_EXTENSIONS = frozenset(
    {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tif", ".tiff", ".heic"}
)
DOCUMENT_EXTENSIONS = frozenset(
    {
        ".txt", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
        ".srt", ".vtt", ".ass", ".sub", ".csv", ".md", ".rtf", ".odt",
    }
)  # fmt: skip

# ---------------------------------------------------------------------------
# AI configuration. Model names are *defaults only*; users change them in
# Settings. They are never referenced anywhere else in the code base.
# ---------------------------------------------------------------------------
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
SUGGESTED_GEMINI_MODELS = ("gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro")
SUGGESTED_OPENAI_MODELS = ("gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1")

GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
OPENAI_API_BASE = "https://api.openai.com/v1"

DEFAULT_REQUEST_TIMEOUT_S = 60
DEFAULT_BATCH_SIZE = 50  # filenames per AI request
MAX_BATCH_SIZE = 200
DEFAULT_SAMPLE_SIZE = DEFAULT_BATCH_SIZE
MAX_AI_RESPONSE_CHARS = 4_000_000
MAX_ACTIONS_PER_RESPONSE = 20_000

# ---------------------------------------------------------------------------
# Actions the AI is allowed to return. Anything else is rejected.
# ---------------------------------------------------------------------------
ACTION_RENAME = "rename"
ACTION_MOVE = "move"
ACTION_COPY = "copy"
ACTION_CREATE_FOLDER = "create_folder"
ACTION_DELETE = "delete"
ACTION_ADD_PREFIX = "add_prefix"
ACTION_ADD_SUFFIX = "add_suffix"
ACTION_REMOVE_TEXT = "remove_text"
ACTION_REPLACE_TEXT = "replace_text"
ACTION_NUMBERING = "numbering"
ACTION_SORT = "sort"
ACTION_CHANGE_CASE = "change_case"  # offline "change capitalisation" support

ALLOWED_ACTION_TYPES = (
    ACTION_RENAME,
    ACTION_MOVE,
    ACTION_COPY,
    ACTION_CREATE_FOLDER,
    ACTION_DELETE,
    ACTION_ADD_PREFIX,
    ACTION_ADD_SUFFIX,
    ACTION_REMOVE_TEXT,
    ACTION_REPLACE_TEXT,
    ACTION_NUMBERING,
    ACTION_SORT,
    ACTION_CHANGE_CASE,
)

# Keys that must never appear anywhere in an AI response. The app never runs
# commands, but an answer that tries to is treated as hostile and rejected.
FORBIDDEN_RESPONSE_KEYS = frozenset(
    {"command", "cmd", "shell", "powershell", "script", "exec", "execute", "run", "bash"}
)

# ---------------------------------------------------------------------------
# File-system safety limits
# ---------------------------------------------------------------------------
MAX_NAME_UTF16 = 255  # NTFS component limit (UTF-16 code units)
MAX_NAME_BYTES_POSIX = 255
MAX_WIN_PATH = 259  # MAX_PATH - 1 (without the \\?\ prefix)
MAX_PLAN_ITEMS = 50_000

ILLEGAL_FILENAME_CHARS = '<>:"/\\|?*'
WINDOWS_RESERVED_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)

TEMP_PREFIX = ".tmp_ai_"
TRASH_DIR_NAME = ".ai_video_assistant_trash"
INTERNAL_DIR_PREFIX = ".ai_video_assistant_"

# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------
KEYRING_SERVICE = "AI Video File Assistant"
DATA_DIR_ENV = "AIVFA_DATA_DIR"  # override for tests / portable installs
MAX_HISTORY_ITEMS = 500
MAX_PROMPT_CHARS = 4000
