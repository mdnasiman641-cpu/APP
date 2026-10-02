"""Reusable UI building blocks: cards, translatable text binding, helpers."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from PySide6.QtCore import QSize, Qt
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QLayout,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from app.i18n import tr


class Retranslator:
    """Remembers ``(widget, setter, key)`` bindings and re-applies them on language change."""

    def __init__(self) -> None:
        self._bindings: list[tuple[Callable[[str], None], str, dict[str, Any]]] = []

    def bind(self, setter: Callable[[str], None], key: str, **kwargs: Any) -> None:
        self._bindings.append((setter, key, kwargs))
        setter(tr(key, **kwargs))

    def text(self, widget: Any, key: str, **kwargs: Any) -> None:
        self.bind(widget.setText, key, **kwargs)

    def tooltip(self, widget: QWidget, key: str, **kwargs: Any) -> None:
        self.bind(widget.setToolTip, key, **kwargs)

    def placeholder(self, widget: Any, key: str, **kwargs: Any) -> None:
        self.bind(widget.setPlaceholderText, key, **kwargs)

    def title(self, widget: QWidget, key: str, **kwargs: Any) -> None:
        self.bind(widget.setWindowTitle, key, **kwargs)

    def retranslate(self) -> None:
        for setter, key, kwargs in self._bindings:
            setter(tr(key, **kwargs))


class Card(QFrame):
    """A rounded surface with an optional small-caps title and a right-aligned header area."""

    def __init__(self, title_key: str | None = None, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("Card")
        self._tr = Retranslator()
        outer = QVBoxLayout(self)
        outer.setContentsMargins(16, 14, 16, 16)
        outer.setSpacing(10)
        self.header = QHBoxLayout()
        self.header.setSpacing(8)
        self.title_label = QLabel()
        self.title_label.setObjectName("CardTitle")
        self.header.addWidget(self.title_label)
        self.header.addStretch(1)
        self.body = QVBoxLayout()
        self.body.setSpacing(10)
        outer.addLayout(self.header)
        outer.addLayout(self.body, 1)
        if title_key:
            self._tr.bind(lambda t: self.title_label.setText(t.upper()), title_key)
        else:
            self.title_label.hide()

    def retranslate(self) -> None:
        self._tr.retranslate()


def make_button(
    text_key: str | None,
    retranslator: Retranslator,
    *,
    icon: QIcon | None = None,
    name: str | None = None,
    tooltip_key: str | None = None,
    icon_size: int = 16,
) -> QPushButton:
    """Create a translatable button; ``name`` selects a QSS style (``Primary``, ``Danger``...)."""
    button = QPushButton()
    if name:
        button.setObjectName(name)
    if icon is not None:
        button.setIcon(icon)
        button.setIconSize(QSize(icon_size, icon_size))
    if text_key:
        retranslator.text(button, text_key)
    if tooltip_key:
        retranslator.tooltip(button, tooltip_key)
    button.setCursor(Qt.CursorShape.PointingHandCursor)
    return button


def clear_layout(layout: QLayout) -> None:
    """Remove and delete every widget in ``layout``."""
    while layout.count():
        item = layout.takeAt(0)
        widget = item.widget()
        if widget is not None:
            widget.deleteLater()
