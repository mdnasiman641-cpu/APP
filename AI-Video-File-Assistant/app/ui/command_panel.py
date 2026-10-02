"""The "AI Command" card: provider, processing mode, command text and Generate Preview."""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QKeyEvent
from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QMenu,
    QPlainTextEdit,
    QToolButton,
)

from app.config.constants import MAX_PROMPT_CHARS, ProcessingMode, Provider
from app.database.models import CommandRecord, SavedPrompt
from app.i18n import tr
from app.ui.widgets import Card, IconBinder, make_button
from app.utils.helpers import truncate


class CommandEdit(QPlainTextEdit):
    """Multi-line command box; Ctrl+Enter submits."""

    submitted = Signal()

    def keyPressEvent(self, event: QKeyEvent) -> None:  # noqa: N802
        if event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter) and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self.submitted.emit()
            return
        super().keyPressEvent(event)


class CommandPanel(Card):
    """Where the user writes a natural-language command (English or Bangla)."""

    generate_requested = Signal()
    cancel_requested = Signal()
    saved_prompt_chosen = Signal(object)  # SavedPrompt
    recent_command_chosen = Signal(object)  # CommandRecord
    manage_prompts_requested = Signal()
    save_prompt_requested = Signal()

    def __init__(self, icons: IconBinder) -> None:
        super().__init__("command.title")
        self._icons = icons
        self._busy = False

        row = QHBoxLayout()
        row.setSpacing(8)
        self.provider_combo = QComboBox()
        for provider in Provider:
            self.provider_combo.addItem("", provider.value)
        self.provider_combo.setMinimumWidth(130)
        self._tr.tooltip(self.provider_combo, "command.provider_tip")
        row.addWidget(self.provider_combo)

        self.mode_combo = QComboBox()
        for mode in ProcessingMode:
            self.mode_combo.addItem("", mode.value)
        self.mode_combo.setMinimumWidth(220)
        self._tr.tooltip(self.mode_combo, "command.mode_tip")
        row.addWidget(self.mode_combo)
        row.addStretch(1)

        self.prompts_button = QToolButton()
        self.prompts_button.setObjectName("HeaderButton")
        self.prompts_button.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.prompts_button.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self._icons.bind(self.prompts_button.setIcon, "star", 16)
        self._tr.text(self.prompts_button, "command.saved_prompts")
        self.prompts_menu = QMenu(self)
        self.prompts_button.setMenu(self.prompts_menu)
        row.addWidget(self.prompts_button)

        self.recent_button = QToolButton()
        self.recent_button.setObjectName("HeaderButton")
        self.recent_button.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.recent_button.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self._icons.bind(self.recent_button.setIcon, "history", 16)
        self._tr.text(self.recent_button, "command.recent")
        self.recent_menu = QMenu(self)
        self.recent_button.setMenu(self.recent_menu)
        row.addWidget(self.recent_button)
        self.body.addLayout(row)

        self.edit = CommandEdit()
        self.edit.setMinimumHeight(64)
        self.edit.setMaximumHeight(140)
        self.edit.setTabChangesFocus(True)
        self.edit.submitted.connect(self.generate_requested)
        self.body.addWidget(self.edit)

        actions = QHBoxLayout()
        self.counter = QLabel()
        self.counter.setObjectName("Count")
        actions.addWidget(self.counter)
        actions.addStretch(1)
        self.save_button = make_button("command.save_prompt", self._tr, icon="star", binder=icons, tooltip_key="command.save_prompt_tip")
        self.save_button.clicked.connect(self.save_prompt_requested)
        actions.addWidget(self.save_button)
        self.cancel_button = make_button("common.cancel", self._tr, icon="x", binder=icons)
        self.cancel_button.clicked.connect(self.cancel_requested)
        self.cancel_button.hide()
        actions.addWidget(self.cancel_button)
        self.generate_button = make_button(
            "command.generate", self._tr, icon="zap", binder=icons, icon_color="#ffffff", name="Primary",
            tooltip_key="command.generate_tip",
        )  # fmt: skip
        self.generate_button.clicked.connect(self.generate_requested)
        actions.addWidget(self.generate_button)
        self.body.addLayout(actions)

        self.edit.textChanged.connect(self._update_counter)
        self.retranslate()

    # --------------------------------------------------------------- accessors
    def command(self) -> str:
        return self.edit.toPlainText().strip()[:MAX_PROMPT_CHARS]

    def set_command(self, text: str) -> None:
        self.edit.setPlainText(text)
        self.edit.setFocus()

    def provider(self) -> Provider:
        return Provider(self.provider_combo.currentData())

    def set_provider(self, provider: str) -> None:
        index = self.provider_combo.findData(provider)
        if index >= 0:
            self.provider_combo.setCurrentIndex(index)

    def processing(self) -> ProcessingMode:
        return ProcessingMode(self.mode_combo.currentData())

    def set_busy(self, busy: bool) -> None:
        """While planning: swap Generate for Cancel and lock the inputs."""
        self._busy = busy
        self.generate_button.setVisible(not busy)
        self.cancel_button.setVisible(busy)
        for widget in (self.provider_combo, self.mode_combo, self.edit):
            widget.setEnabled(not busy)

    # ------------------------------------------------------------------ menus
    def set_prompts(self, prompts: list[SavedPrompt], recent: list[CommandRecord]) -> None:
        """Rebuild the Saved Prompts and Recent Commands drop-down menus."""
        self.prompts_menu.clear()
        for prompt in prompts:
            action = self.prompts_menu.addAction(f"⭐ {prompt.name}")
            action.setToolTip(truncate(prompt.prompt, 200))
            action.triggered.connect(lambda _c=False, p=prompt: self.saved_prompt_chosen.emit(p))
        if prompts:
            self.prompts_menu.addSeparator()
        self.prompts_menu.addAction(tr("command.manage")).triggered.connect(self.manage_prompts_requested)

        self.recent_menu.clear()
        for record in recent[:12]:
            label = ("★ " if record.favorite else "") + truncate(record.command.replace("\n", " "), 70)
            action = self.recent_menu.addAction(label)
            action.setToolTip(record.command)
            action.triggered.connect(lambda _c=False, r=record: self.recent_command_chosen.emit(r))
        if not recent:
            empty = self.recent_menu.addAction(tr("command.no_recent"))
            empty.setEnabled(False)
        else:
            self.recent_menu.addSeparator()
        self.recent_menu.addAction(tr("command.manage")).triggered.connect(self.manage_prompts_requested)

    # --------------------------------------------------------------- bookkeeping
    def _update_counter(self) -> None:
        self.counter.setText(f"{len(self.edit.toPlainText())} / {MAX_PROMPT_CHARS}")

    def retranslate(self) -> None:
        super().retranslate()
        labels = {"gemini": "Gemini", "openai": "OpenAI", "auto": tr("settings.provider_auto")}
        for index in range(self.provider_combo.count()):
            self.provider_combo.setItemText(index, labels[str(self.provider_combo.itemData(index))])
        modes = {"auto": tr("command.mode_auto"), "ai": tr("command.mode_ai"), "offline": tr("command.mode_offline")}
        for index in range(self.mode_combo.count()):
            self.mode_combo.setItemText(index, modes[str(self.mode_combo.itemData(index))])
        self.edit.setPlaceholderText(tr("command.placeholder") + "\n\n" + tr("command.example"))
        self._update_counter()

