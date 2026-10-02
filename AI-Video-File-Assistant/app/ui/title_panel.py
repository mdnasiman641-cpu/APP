"""The collapsible "Title Generator" section of the AI Command card (settings, search options, presets)."""

from __future__ import annotations

from typing import Any

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFormLayout,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from app.ai.title_config import (
    CAPACITIES,
    CATEGORIES,
    MAX_RESULTS,
    QUERY_MODES,
    SOURCES,
    STYLES,
    TITLE_MODES,
    TONES,
    VARIATIONS,
    TitleConfig,
    load_preset,
    save_preset,
)
from app.i18n import tr
from app.ui.widgets import Retranslator, confirm_destructive


class TitlePanel(QWidget):
    """Edits a :class:`TitleConfig`. ``changed`` fires on every edit (the main window auto-saves it)."""

    changed = Signal()

    def __init__(self, db: Any) -> None:
        super().__init__()
        self.db = db
        self._tr = Retranslator()
        self._loading = False
        self._combos: dict[str, tuple[QComboBox, str]] = {}
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(6)

        header = QHBoxLayout()
        self.toggle = QToolButton()
        self.toggle.setCheckable(True)
        self.toggle.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.toggle.setArrowType(Qt.ArrowType.RightArrow)
        self.toggle.setObjectName("HeaderButton")
        self._tr.text(self.toggle, "tg.title")
        self.toggle.toggled.connect(self.set_expanded)
        self.enabled = QCheckBox()
        self._tr.text(self.enabled, "tg.enabled")
        self._tr.tooltip(self.enabled, "tg.enabled_tip")
        self.enabled.toggled.connect(self._emit)
        header.addWidget(self.toggle)
        header.addWidget(self.enabled)
        header.addStretch(1)
        outer.addLayout(header)

        self.body = QWidget()
        body = QVBoxLayout(self.body)
        body.setContentsMargins(4, 0, 4, 4)
        body.setSpacing(8)
        body.addLayout(self._build_main())
        body.addWidget(self._build_search())
        body.addLayout(self._build_presets())
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.scroll.setWidget(self.body)
        self.scroll.setMinimumHeight(220)
        self.scroll.setMaximumHeight(340)
        self.scroll.hide()
        outer.addWidget(self.scroll)
        self.retranslate()
        self.set_config(TitleConfig())
        self.refresh_presets()

    # ================================================================ build
    def _combo(self, name: str, values: tuple[Any, ...], key_prefix: str) -> QComboBox:
        combo = QComboBox()
        for value in values:
            combo.addItem("", value)
        combo.currentIndexChanged.connect(self._on_changed)
        self._combos[name] = (combo, key_prefix)
        return combo

    def _line(self, placeholder_key: str = "") -> QLineEdit:
        edit = QLineEdit()
        edit.setMaxLength(300)
        if placeholder_key:
            self._tr.placeholder(edit, placeholder_key)
        edit.textChanged.connect(self._on_changed)
        return edit

    def _check(self, key: str, tip: str | None = None) -> QCheckBox:
        box = QCheckBox()
        self._tr.text(box, key)
        if tip:
            self._tr.tooltip(box, tip)
        box.toggled.connect(self._on_changed)
        return box

    def _label(self, key: str) -> QLabel:
        label = QLabel()
        self._tr.text(label, key)
        return label

    def _build_main(self) -> QGridLayout:
        grid = QGridLayout()
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(6)
        self.mode = self._combo("mode", TITLE_MODES, "tg.mode.")
        self.source = self._combo("source", SOURCES, "tg.source.")
        self.category = self._combo("category", CATEGORIES, "tg.category.")
        self.custom_category = self._line("tg.custom_category_ph")
        self.topic = self._line("tg.topic_ph")
        self.keywords = self._line("tg.keywords_ph")
        self.style = self._combo("style", STYLES, "tg.style.")
        self.custom_style = self._line("tg.custom_style_ph")
        self.tone = self._combo("tone", TONES, "tg.tone.")
        self.custom_tone = self._line("tg.custom_tone_ph")
        self.capacity = self._combo("capacity", tuple(CAPACITIES), "tg.capacity.")
        self.min_words = QSpinBox()
        self.max_words = QSpinBox()
        for spin in (self.min_words, self.max_words):
            spin.setRange(1, 40)
            spin.valueChanged.connect(self._on_changed)
        self.use_prefix = self._check("tg.series_prefix")
        self.prefix = self._line("tg.prefix_ph")
        self.prefix_counts = self._check("tg.prefix_counts", "tg.prefix_counts_tip")
        self.variation = self._combo("variation", VARIATIONS, "tg.variation.")
        self.unique = self._check("tg.unique")
        self.avoid_filename = self._check("tg.avoid_filename", "tg.avoid_filename_tip")
        self.prevent_duplicates = self._check("tg.prevent_duplicates")
        self.instructions = QPlainTextEdit()
        self.instructions.setMaximumHeight(60)
        self._tr.placeholder(self.instructions, "tg.instructions_ph")
        self.instructions.textChanged.connect(self._on_changed)

        rows: list[tuple[str, QWidget, str | None, QWidget | None]] = [
            ("tg.mode", self.mode, "tg.source", self.source),
            ("tg.category", self.category, "tg.custom_category", self.custom_category),
            ("tg.topic", self.topic, "tg.keywords", self.keywords),
            ("tg.style", self.style, "tg.custom_style", self.custom_style),
            ("tg.tone", self.tone, "tg.custom_tone", self.custom_tone),
        ]
        for row, (k1, w1, k2, w2) in enumerate(rows):
            grid.addWidget(self._label(k1), row, 0)
            grid.addWidget(w1, row, 1)
            if k2 and w2 is not None:
                grid.addWidget(self._label(k2), row, 2)
                grid.addWidget(w2, row, 3)
        words = QHBoxLayout()
        words.addWidget(self.capacity, 1)
        words.addWidget(self._label("tg.min"))
        words.addWidget(self.min_words)
        words.addWidget(self._label("tg.max"))
        words.addWidget(self.max_words)
        grid.addWidget(self._label("tg.capacity"), 5, 0)
        grid.addLayout(words, 5, 1)
        grid.addWidget(self.use_prefix, 5, 2)
        grid.addWidget(self.prefix, 5, 3)
        grid.addWidget(self._label("tg.variation"), 6, 0)
        grid.addWidget(self.variation, 6, 1)
        checks = QHBoxLayout()
        for box in (self.unique, self.avoid_filename, self.prevent_duplicates, self.prefix_counts):
            checks.addWidget(box)
        checks.addStretch(1)
        grid.addLayout(checks, 6, 2, 1, 2)
        grid.addWidget(self._label("tg.instructions"), 7, 0, Qt.AlignmentFlag.AlignTop)
        grid.addWidget(self.instructions, 7, 1, 1, 3)
        grid.setColumnStretch(1, 1)
        grid.setColumnStretch(3, 1)
        return grid

    def _build_search(self) -> QWidget:
        self.search_box = QFrame()
        self.search_box.setObjectName("Card")
        form = QFormLayout(self.search_box)
        form.setContentsMargins(10, 8, 10, 8)
        form.setSpacing(6)
        self.query_mode = self._combo("query_mode", QUERY_MODES, "tg.query.")
        self.max_results = self._combo("max_results", MAX_RESULTS, "")
        self.use_filename_lookup = self._check("tg.filename_lookup", "tg.filename_lookup_tip")
        self.compare_results = self._check("tg.compare")
        self.context_only = self._check("tg.context_only")
        self.completely_new = self._check("tg.completely_new")
        self.search_fallback = self._check("tg.search_fallback", "tg.search_fallback_tip")
        self.custom_query = self._line("tg.custom_query_ph")
        self.search_hint = QLabel()
        self.search_hint.setObjectName("Hint")
        self.search_hint.setWordWrap(True)
        self.clear_cache_button = QPushButton()
        self._tr.text(self.clear_cache_button, "tg.clear_cache")
        self.clear_cache_button.clicked.connect(self.clear_cache)
        top = QHBoxLayout()
        top.addWidget(self.query_mode, 1)
        top.addWidget(self._label("tg.max_results"))
        top.addWidget(self.max_results)
        top.addWidget(self.clear_cache_button)
        form.addRow(self._label("tg.query_mode"), top)
        form.addRow(self._label("tg.custom_query"), self.custom_query)
        boxes = QGridLayout()
        for i, box in enumerate((self.use_filename_lookup, self.compare_results, self.context_only, self.completely_new,
                                 self.search_fallback)):  # fmt: skip
            boxes.addWidget(box, i // 2, i % 2)
        form.addRow(boxes)
        form.addRow(self.search_hint)
        return self.search_box

    def _build_presets(self) -> QHBoxLayout:
        row = QHBoxLayout()
        row.addWidget(self._label("tg.preset"))
        self.preset_combo = QComboBox()
        self.preset_combo.setMinimumWidth(200)
        row.addWidget(self.preset_combo, 1)
        self.save_preset_button = QPushButton()
        self.load_preset_button = QPushButton()
        self.delete_preset_button = QPushButton()
        self.delete_preset_button.setObjectName("Danger")
        for button, key, handler in ((self.save_preset_button, "tg.save_preset", self.save_preset),
                                     (self.load_preset_button, "tg.load_preset", self.load_selected_preset),
                                     (self.delete_preset_button, "tg.delete_preset", self.delete_preset)):  # fmt: skip
            self._tr.text(button, key)
            button.clicked.connect(handler)
            row.addWidget(button)
        self.preset_status = QLabel()
        self.preset_status.setObjectName("Muted")
        row.addWidget(self.preset_status)
        return row

    # ================================================================ state
    def set_expanded(self, expanded: bool) -> None:
        self.toggle.blockSignals(True)
        self.toggle.setChecked(expanded)
        self.toggle.blockSignals(False)
        self.toggle.setArrowType(Qt.ArrowType.DownArrow if expanded else Qt.ArrowType.RightArrow)
        self.scroll.setVisible(expanded)

    def set_search_configured(self, configured: bool) -> None:
        self._search_configured = configured
        self._update_visibility()

    def config(self) -> TitleConfig:
        def data(name: str) -> Any:
            return self._combos[name][0].currentData()

        return TitleConfig(
            enabled=self.enabled.isChecked(), mode=data("mode"), source=data("source"), category=data("category"),
            custom_category=self.custom_category.text(), topic=self.topic.text(), keywords=self.keywords.text(),
            style=data("style"), custom_style=self.custom_style.text(), tone=data("tone"), custom_tone=self.custom_tone.text(),
            capacity=data("capacity"), min_words=self.min_words.value(), max_words=self.max_words.value(),
            prefix=self.prefix.text(), use_prefix=self.use_prefix.isChecked(), variation=data("variation"),
            unique=self.unique.isChecked(), avoid_filename=self.avoid_filename.isChecked(),
            prevent_duplicates=self.prevent_duplicates.isChecked(), custom_instructions=self.instructions.toPlainText(),
            use_filename_lookup=self.use_filename_lookup.isChecked(), query_mode=data("query_mode"),
            max_results=int(data("max_results") or 5), custom_query=self.custom_query.text(),
            compare_results=self.compare_results.isChecked(), context_only=self.context_only.isChecked(),
            completely_new=self.completely_new.isChecked(), search_fallback=self.search_fallback.isChecked(),
            prefix_counts=self.prefix_counts.isChecked(),
        ).normalised()  # fmt: skip

    def set_config(self, config: TitleConfig, *, keep_enabled: bool = False) -> None:
        cfg = config.normalised()
        self._loading = True
        try:
            if not keep_enabled:
                self.enabled.setChecked(cfg.enabled)
            for name, (combo, _key) in self._combos.items():
                index = combo.findData(getattr(cfg, name))
                combo.setCurrentIndex(max(0, index))
            for edit, value in ((self.custom_category, cfg.custom_category), (self.topic, cfg.topic), (self.keywords, cfg.keywords),
                                (self.custom_style, cfg.custom_style), (self.custom_tone, cfg.custom_tone), (self.prefix, cfg.prefix),
                                (self.custom_query, cfg.custom_query)):  # fmt: skip
                edit.setText(value)
            self.min_words.setValue(cfg.min_words)
            self.max_words.setValue(cfg.max_words)
            for box, value in ((self.use_prefix, cfg.use_prefix), (self.unique, cfg.unique), (self.avoid_filename, cfg.avoid_filename),
                               (self.prevent_duplicates, cfg.prevent_duplicates), (self.use_filename_lookup, cfg.use_filename_lookup),
                               (self.compare_results, cfg.compare_results), (self.context_only, cfg.context_only),
                               (self.completely_new, cfg.completely_new), (self.search_fallback, cfg.search_fallback),
                               (self.prefix_counts, cfg.prefix_counts)):  # fmt: skip
                box.setChecked(value)
            self.instructions.setPlainText(cfg.custom_instructions)
        finally:
            self._loading = False
        self._update_visibility()

    def _update_visibility(self) -> None:
        def data(name: str) -> Any:
            return self._combos[name][0].currentData()

        self.custom_category.setEnabled(data("category") == "custom")
        self.custom_style.setEnabled(data("style") == "custom")
        self.custom_tone.setEnabled(data("tone") == "custom")
        custom_words = data("capacity") == "custom"
        self.min_words.setEnabled(custom_words)
        self.max_words.setEnabled(custom_words)
        if not custom_words and data("capacity") in CAPACITIES:
            low, high = CAPACITIES[data("capacity")]  # type: ignore[misc]
            self.min_words.blockSignals(True)
            self.max_words.blockSignals(True)
            self.min_words.setValue(low)
            self.max_words.setValue(high)
            self.min_words.blockSignals(False)
            self.max_words.blockSignals(False)
        independent = data("mode") == "independent"
        if independent:
            self.avoid_filename.blockSignals(True)
            self.avoid_filename.setChecked(True)
            self.avoid_filename.blockSignals(False)
        self.avoid_filename.setEnabled(not independent)
        self.prefix.setEnabled(self.use_prefix.isChecked())
        self.prefix_counts.setEnabled(self.use_prefix.isChecked())
        source = data("source")
        self.search_box.setVisible(source in ("search_ai", "search_only", "custom_prompt"))
        self.custom_query.setEnabled(data("query_mode") == "custom")
        configured = getattr(self, "_search_configured", True)
        hints = []
        if not configured:
            hints.append(tr("tg.search_not_configured"))
        if source == "search_only" and independent:
            hints.append(tr("tg.search_only_hint"))
        if source == "custom_prompt":
            hints.append(tr("tg.custom_prompt_hint"))
        self.search_hint.setText("\n".join(hints))
        self.search_hint.setVisible(bool(hints))
        self.load_preset_button.setEnabled(self.preset_combo.count() > 0)
        self.delete_preset_button.setEnabled(self.preset_combo.count() > 0)

    def _on_changed(self, *_args: object) -> None:
        if self._loading:
            return
        self._update_visibility()
        self.changed.emit()

    def _emit(self, *_args: object) -> None:
        if not self._loading:
            self.changed.emit()

    # ============================================================== presets
    def refresh_presets(self, select: str | None = None) -> None:
        current = select or self.preset_combo.currentText()
        self.preset_combo.clear()
        self.preset_combo.addItems(self.db.list_title_presets())
        index = self.preset_combo.findText(current)
        if index >= 0:
            self.preset_combo.setCurrentIndex(index)
        self._update_visibility()

    def save_preset(self, name: str | None = None) -> bool:
        if not isinstance(name, str):
            name, ok = QInputDialog.getText(self, tr("tg.save_preset"), tr("tg.preset_name"), text=self.preset_combo.currentText())
            if not ok:
                return False
        name = name.strip()[:80]
        if not name:
            return False
        save_preset(self.db, name, self.config())
        self.refresh_presets(select=name)
        self.preset_status.setText(tr("tg.preset_saved", name=name))
        return True

    def load_selected_preset(self) -> bool:
        name = self.preset_combo.currentText()
        config = load_preset(self.db, name) if name else None
        if config is None:
            return False
        self.set_config(config, keep_enabled=True)
        self.preset_status.setText(tr("tg.preset_loaded", name=name))
        self.changed.emit()
        return True

    def delete_preset(self) -> bool:
        name = self.preset_combo.currentText()
        if not name or not confirm_destructive(self, tr("tg.delete_preset_confirm", name=name), tr("tg.delete_preset")):
            return False
        self.db.delete_title_preset(name)
        self.refresh_presets()
        self.preset_status.setText(tr("tg.preset_deleted", name=name))
        return True

    def clear_cache(self) -> int:
        removed = self.db.purge_search_cache(None)
        self.preset_status.setText(tr("tg.cache_cleared", count=removed))
        return removed

    # ========================================================== translation
    def retranslate(self) -> None:
        self._tr.retranslate()
        for combo, prefix in self._combos.values():
            for i in range(combo.count()):
                value = combo.itemData(i)
                combo.setItemText(i, tr(f"{prefix}{value}") if prefix else str(value))
        self._update_visibility()

    _search_configured: bool = True
