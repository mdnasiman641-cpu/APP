"""Settings dialog: AI keys & models, file operations, appearance and general options."""

from __future__ import annotations

from dataclasses import replace

from PySide6.QtCore import QThreadPool, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QTabWidget,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from app.ai.base_provider import ConnectionResult
from app.config.constants import (
    MAX_BATCH_SIZE,
    SUGGESTED_GEMINI_MODELS,
    SUGGESTED_OPENAI_MODELS,
    Provider,
)
from app.config.settings import AppSettings, SettingsManager
from app.context import AppContext
from app.i18n import LANGUAGE_NAMES, tr
from app.ui.icons import get_icon
from app.ui.widgets import Retranslator
from app.utils.logger import get_log_dir
from app.workers.ai_worker import ConnectionTestWorker
from app.workers.base_worker import BaseWorker


class ApiKeyRow(QWidget):
    """Key entry for one provider: masked status, hidden-by-default input, Show/Hide, Test, Remove."""

    changed = Signal()

    def __init__(self, provider_id: str, settings: SettingsManager, model_combo: QComboBox, icon_color: str) -> None:
        super().__init__()
        self.provider_id = provider_id
        self._settings = settings
        self._model_combo = model_combo
        self._tr = Retranslator()
        self._workers: set[BaseWorker] = set()

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)
        self.status = QLabel()
        self.status.setObjectName("Muted")
        layout.addWidget(self.status)

        row = QHBoxLayout()
        self.input = QLineEdit()
        self.input.setEchoMode(QLineEdit.EchoMode.Password)
        self.input.setAcceptDrops(False)
        self._tr.placeholder(self.input, "settings.key_placeholder")
        self.input.textChanged.connect(self._on_text_changed)
        row.addWidget(self.input, 1)
        self.toggle = QToolButton()
        self.toggle.setCheckable(True)
        self.toggle.setIcon(get_icon("eye", icon_color, 16))
        self._tr.tooltip(self.toggle, "settings.show_hide")
        self.toggle.toggled.connect(self._on_toggle)
        row.addWidget(self.toggle)
        layout.addLayout(row)

        buttons = QHBoxLayout()
        self.test_button = QPushButton()
        self.test_button.setIcon(get_icon("wifi", icon_color, 16))
        self._tr.text(self.test_button, "settings.test_connection")
        self.test_button.clicked.connect(self._on_test)
        self.remove_button = QPushButton()
        self.remove_button.setIcon(get_icon("trash", icon_color, 16))
        self._tr.text(self.remove_button, "settings.remove_key")
        self.remove_button.clicked.connect(self._on_remove)
        buttons.addWidget(self.test_button)
        buttons.addWidget(self.remove_button)
        buttons.addStretch(1)
        layout.addLayout(buttons)
        self.result = QLabel()
        self.result.setWordWrap(True)
        layout.addWidget(self.result)
        self.refresh_status()

    # -- public ------------------------------------------------------------
    def pending_key(self) -> str:
        """A newly typed key waiting to be saved (empty if the field is untouched)."""
        return self.input.text().strip()

    def refresh_status(self) -> None:
        masked = self._settings.masked_api_key(self.provider_id)
        self.status.setText(tr("settings.key_saved", masked=masked) if masked else tr("settings.key_none"))
        self.remove_button.setEnabled(bool(masked))
        self._update_test_enabled()

    def retranslate(self) -> None:
        self._tr.retranslate()
        self.refresh_status()

    # -- slots -------------------------------------------------------------
    def _on_text_changed(self, _text: str) -> None:
        self._update_test_enabled()
        self.changed.emit()

    def _update_test_enabled(self) -> None:
        self.test_button.setEnabled(bool(self.pending_key()) or self._settings.has_api_key(self.provider_id))

    def _on_toggle(self, shown: bool) -> None:
        self.input.setEchoMode(QLineEdit.EchoMode.Normal if shown else QLineEdit.EchoMode.Password)

    def _on_remove(self) -> None:
        answer = QMessageBox.question(self, tr("app.title"), tr("settings.remove_key_confirm"))
        if answer == QMessageBox.StandardButton.Yes:
            self._settings.remove_api_key(self.provider_id)
            self.input.clear()
            self.result.clear()
            self.refresh_status()
            self.changed.emit()

    def _on_test(self) -> None:
        key = self.pending_key() or self._settings.api_key(self.provider_id) or ""
        if not key:
            return
        current = self._settings.load()
        worker = ConnectionTestWorker(
            self.provider_id, key, self._model_combo.currentText().strip() or current.model_for(self.provider_id),
            current.request_timeout_s,
        )  # fmt: skip
        self._workers.add(worker)
        self.test_button.setEnabled(False)
        self._set_result(tr("settings.testing"), "Muted")
        worker.signals.result.connect(self._on_test_result)
        worker.signals.error.connect(lambda msg, _e: self._set_result(msg, "Danger"))
        worker.signals.finished.connect(lambda: self._test_finished(worker))
        QThreadPool.globalInstance().start(worker)

    def _on_test_result(self, result: object) -> None:
        assert isinstance(result, ConnectionResult)
        self._set_result(("✓ " if result.ok else "✗ ") + result.message, "Success" if result.ok else "Danger")
        if result.ok and result.models:
            current = self._model_combo.currentText()
            self._model_combo.clear()
            self._model_combo.addItems(result.models)
            self._model_combo.setCurrentText(current)

    def _test_finished(self, worker: BaseWorker) -> None:
        self._workers.discard(worker)
        self._update_test_enabled()

    def _set_result(self, text: str, style: str) -> None:
        self.result.setObjectName(style)
        self.result.setText(text)
        self.result.style().unpolish(self.result)
        self.result.style().polish(self.result)


class SettingsDialog(QDialog):
    """Edits :class:`AppSettings`; API keys are saved straight to the encrypted store on *Save*."""

    saved = Signal()

    def __init__(self, ctx: AppContext, parent: QWidget | None = None, icon_color: str = "#98a0b3") -> None:
        super().__init__(parent)
        self.ctx = ctx
        self._icon_color = icon_color
        self._tr = Retranslator()
        self._tr.title(self, "settings.title")
        self.setMinimumWidth(640)
        self.setModal(True)
        self.original = ctx.settings.load()

        root = QVBoxLayout(self)
        root.setContentsMargins(16, 16, 16, 12)
        self.tabs = QTabWidget()
        root.addWidget(self.tabs, 1)
        self.tabs.addTab(self._build_ai_tab(), "")
        self.tabs.addTab(self._build_files_tab(), "")
        self.tabs.addTab(self._build_appearance_tab(), "")
        self.tabs.addTab(self._build_general_tab(), "")
        self.buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        self.buttons.accepted.connect(self.save)
        self.buttons.rejected.connect(self.reject)
        root.addWidget(self.buttons)
        self._load(self.original)
        self.retranslate()

    # ------------------------------------------------------------------ tabs
    def _label(self, key: str) -> QLabel:
        label = QLabel()
        self._tr.text(label, key)
        return label

    def _check(self, key: str, tip_key: str | None = None) -> QCheckBox:
        box = QCheckBox()
        self._tr.text(box, key)
        if tip_key:
            self._tr.tooltip(box, tip_key)
        return box

    def _group(self, key: str) -> tuple[QGroupBox, QFormLayout]:
        group = QGroupBox()
        self._tr.bind(group.setTitle, key)
        form = QFormLayout(group)
        form.setSpacing(10)
        form.setLabelAlignment(form.labelAlignment())
        return group, form

    def _model_combo(self, suggestions: tuple[str, ...]) -> QComboBox:
        combo = QComboBox()
        combo.setEditable(True)
        combo.addItems(list(suggestions))
        return combo

    def _build_ai_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setSpacing(12)

        gemini_group, gemini_form = self._group("settings.gemini")
        self.gemini_model = self._model_combo(SUGGESTED_GEMINI_MODELS)
        self.gemini_key = ApiKeyRow(Provider.GEMINI.value, self.ctx.settings, self.gemini_model, self._icon_color)
        gemini_form.addRow(self._label("settings.api_key"), self.gemini_key)
        gemini_form.addRow(self._label("settings.model"), self.gemini_model)
        layout.addWidget(gemini_group)

        openai_group, openai_form = self._group("settings.openai")
        self.openai_model = self._model_combo(SUGGESTED_OPENAI_MODELS)
        self.openai_key = ApiKeyRow(Provider.OPENAI.value, self.ctx.settings, self.openai_model, self._icon_color)
        openai_form.addRow(self._label("settings.api_key"), self.openai_key)
        openai_form.addRow(self._label("settings.model"), self.openai_model)
        layout.addWidget(openai_group)

        behaviour, form = self._group("settings.ai_behaviour")
        self.default_provider = QComboBox()
        for provider in Provider:
            self.default_provider.addItem("", provider.value)
        self.auto_preferred = QComboBox()
        self.auto_preferred.addItem("Gemini", Provider.GEMINI.value)
        self.auto_preferred.addItem("OpenAI", Provider.OPENAI.value)
        self.fallback_mode = QComboBox()
        for mode in ("automatic", "ask", "off"):
            self.fallback_mode.addItem("", mode)
        self.use_offline = self._check("settings.use_offline", "settings.use_offline_tip")
        self.batch_size = QSpinBox()
        self.batch_size.setRange(1, MAX_BATCH_SIZE)
        self.batch_size.setToolTip(tr("settings.batch_size_tip"))
        self.timeout = QSpinBox()
        self.timeout.setRange(5, 600)
        self.timeout.setSuffix(" s")
        self.send_metadata = self._check("settings.send_metadata", "settings.send_metadata_tip")
        form.addRow(self._label("settings.default_provider"), self.default_provider)
        form.addRow(self._label("settings.auto_preferred"), self.auto_preferred)
        form.addRow(self._label("settings.fallback"), self.fallback_mode)
        form.addRow(self._label("settings.batch_size"), self.batch_size)
        form.addRow(self._label("settings.timeout"), self.timeout)
        form.addRow("", self.use_offline)
        form.addRow("", self.send_metadata)
        layout.addWidget(behaviour)
        layout.addStretch(1)
        return page

    def _build_files_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        group, form = self._group("settings.file_ops")
        self.ask_before = self._check("settings.ask_before", "settings.ask_before_tip")
        self.create_history = self._check("settings.create_history", "settings.create_history_tip")
        self.prevent_overwrite = self._check("settings.prevent_overwrite", "settings.prevent_overwrite_tip")
        self.include_subfolders = self._check("settings.include_subfolders", "settings.include_subfolders_tip")
        self.auto_apply = self._check("settings.auto_apply", "settings.auto_apply_tip")
        self.auto_apply.toggled.connect(self._on_auto_apply_toggled)
        self.duplicate_policy = QComboBox()
        for policy in ("flag", "number"):
            self.duplicate_policy.addItem("", policy)
        self.delete_mode = QComboBox()
        for mode in ("trash", "permanent"):
            self.delete_mode.addItem("", mode)
        form.addRow("", self.ask_before)
        form.addRow("", self.create_history)
        form.addRow("", self.prevent_overwrite)
        form.addRow("", self.include_subfolders)
        form.addRow("", self.auto_apply)
        form.addRow(self._label("settings.duplicate_policy"), self.duplicate_policy)
        form.addRow(self._label("settings.delete_mode"), self.delete_mode)
        layout.addWidget(group)
        note = QLabel()
        note.setObjectName("Hint")
        note.setWordWrap(True)
        self._tr.text(note, "settings.file_ops_note")
        layout.addWidget(note)
        layout.addStretch(1)
        return page

    def _build_appearance_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        group, form = self._group("settings.appearance")
        self.theme = QComboBox()
        for theme in ("system", "dark", "light"):
            self.theme.addItem("", theme)
        form.addRow(self._label("settings.theme"), self.theme)
        layout.addWidget(group)
        layout.addStretch(1)
        return page

    def _build_general_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        group, form = self._group("settings.general")
        self.reopen_last = self._check("settings.reopen_last")
        self.language = QComboBox()
        for code, name in LANGUAGE_NAMES.items():
            self.language.addItem(name, code)
        self.default_filter = QComboBox()
        for value in ("video", "all"):
            self.default_filter.addItem("", value)
        self.read_metadata = self._check("settings.read_metadata", "settings.read_metadata_tip")
        form.addRow("", self.reopen_last)
        form.addRow(self._label("settings.language"), self.language)
        form.addRow(self._label("settings.default_filter"), self.default_filter)
        form.addRow("", self.read_metadata)
        layout.addWidget(group)

        logs, log_form = self._group("settings.logging")
        self.log_level = QComboBox()
        for level in ("DEBUG", "INFO", "WARNING", "ERROR"):
            self.log_level.addItem(level, level)
        open_logs = QPushButton()
        self._tr.text(open_logs, "settings.open_logs")
        open_logs.clicked.connect(lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(str(get_log_dir()))))
        note = QLabel()
        note.setObjectName("Hint")
        note.setWordWrap(True)
        self._tr.text(note, "settings.log_note")
        log_form.addRow(self._label("settings.log_level"), self.log_level)
        log_form.addRow("", open_logs)
        log_form.addRow("", note)
        layout.addWidget(logs)
        layout.addStretch(1)
        return page

    # ------------------------------------------------------------- load / save
    def _load(self, s: AppSettings) -> None:
        self.gemini_model.setCurrentText(s.gemini_model)
        self.openai_model.setCurrentText(s.openai_model)
        _select(self.default_provider, s.default_provider)
        _select(self.auto_preferred, s.auto_preferred_provider)
        _select(self.fallback_mode, s.fallback_mode)
        self.use_offline.setChecked(s.use_offline_parser)
        self.batch_size.setValue(s.batch_size)
        self.timeout.setValue(s.request_timeout_s)
        self.send_metadata.setChecked(s.send_metadata_to_ai)
        self.ask_before.setChecked(s.ask_before_apply)
        self.create_history.setChecked(s.create_history)
        self.prevent_overwrite.setChecked(s.prevent_overwrite)
        self.include_subfolders.setChecked(s.include_subfolders)
        self.auto_apply.blockSignals(True)
        self.auto_apply.setChecked(s.auto_apply)
        self.auto_apply.blockSignals(False)
        _select(self.duplicate_policy, s.duplicate_policy)
        _select(self.delete_mode, s.delete_mode)
        _select(self.theme, s.theme)
        self.reopen_last.setChecked(s.reopen_last_folder)
        _select(self.language, s.language)
        _select(self.default_filter, s.default_file_filter)
        self.read_metadata.setChecked(s.read_metadata)
        _select(self.log_level, s.log_level)

    def collect(self) -> AppSettings:
        """Read the form into a new :class:`AppSettings` (not yet saved)."""
        return replace(
            self.original,
            gemini_model=self.gemini_model.currentText().strip(),
            openai_model=self.openai_model.currentText().strip(),
            default_provider=self.default_provider.currentData(),
            auto_preferred_provider=self.auto_preferred.currentData(),
            fallback_mode=self.fallback_mode.currentData(),
            use_offline_parser=self.use_offline.isChecked(),
            batch_size=self.batch_size.value(),
            request_timeout_s=self.timeout.value(),
            send_metadata_to_ai=self.send_metadata.isChecked(),
            ask_before_apply=self.ask_before.isChecked(),
            create_history=self.create_history.isChecked(),
            prevent_overwrite=self.prevent_overwrite.isChecked(),
            include_subfolders=self.include_subfolders.isChecked(),
            auto_apply=self.auto_apply.isChecked(),
            duplicate_policy=self.duplicate_policy.currentData(),
            delete_mode=self.delete_mode.currentData(),
            theme=self.theme.currentData(),
            reopen_last_folder=self.reopen_last.isChecked(),
            language=self.language.currentData(),
            default_file_filter=self.default_filter.currentData(),
            read_metadata=self.read_metadata.isChecked(),
            log_level=self.log_level.currentData(),
        )

    def save(self) -> None:
        """Persist settings and any newly entered API keys, then close."""
        for row in (self.gemini_key, self.openai_key):
            key = row.pending_key()
            if key:
                self.ctx.settings.set_api_key(row.provider_id, key)
                row.input.clear()
        self.ctx.settings.save(self.collect())
        self.saved.emit()
        self.accept()

    def _on_auto_apply_toggled(self, checked: bool) -> None:
        if not checked:
            return
        answer = QMessageBox.warning(
            self, tr("app.title"), tr("settings.auto_apply_warning"),
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No, QMessageBox.StandardButton.No,
        )  # fmt: skip
        if answer != QMessageBox.StandardButton.Yes:
            self.auto_apply.blockSignals(True)
            self.auto_apply.setChecked(False)
            self.auto_apply.blockSignals(False)

    # ------------------------------------------------------------ translations
    def retranslate(self) -> None:
        self._tr.retranslate()
        titles = ("settings.tab_ai", "settings.tab_files", "settings.tab_appearance", "settings.tab_general")
        for index, key in enumerate(titles):
            self.tabs.setTabText(index, tr(key))
        _relabel(self.default_provider, {"gemini": "Gemini", "openai": "OpenAI", "auto": tr("settings.provider_auto")})
        _relabel(self.fallback_mode, {m: tr(f"settings.fallback_{m}") for m in ("automatic", "ask", "off")})
        _relabel(self.duplicate_policy, {p: tr(f"settings.duplicates_{p}") for p in ("flag", "number")})
        _relabel(self.delete_mode, {m: tr(f"settings.delete_{m}") for m in ("trash", "permanent")})
        _relabel(self.theme, {t: tr(f"settings.theme_{t}") for t in ("system", "dark", "light")})
        _relabel(self.default_filter, {"video": tr("filter.video"), "all": tr("filter.all")})
        self.batch_size.setToolTip(tr("settings.batch_size_tip"))
        self.gemini_key.retranslate()
        self.openai_key.retranslate()
        self.buttons.button(QDialogButtonBox.StandardButton.Save).setText(tr("settings.save"))
        self.buttons.button(QDialogButtonBox.StandardButton.Cancel).setText(tr("common.cancel"))


def _select(combo: QComboBox, data: object) -> None:
    index = combo.findData(data)
    if index >= 0:
        combo.setCurrentIndex(index)


def _relabel(combo: QComboBox, labels: dict[str, str]) -> None:
    for index in range(combo.count()):
        combo.setItemText(index, labels.get(str(combo.itemData(index)), combo.itemText(index)))
