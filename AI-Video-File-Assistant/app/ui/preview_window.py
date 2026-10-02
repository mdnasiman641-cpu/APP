"""The "Preview" card: every planned change, colour-coded, with per-row inclusion."""

from __future__ import annotations

from PySide6.QtCore import QAbstractTableModel, QModelIndex, QPersistentModelIndex, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QFont
from PySide6.QtWidgets import (
    QAbstractItemView,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QStyle,
    QStyledItemDelegate,
    QTableView,
)

from app.files.plan import OpKind, OpStatus, Plan, PlannedOp
from app.i18n import tr
from app.ui.widgets import Card, IconBinder, make_button

_Index = QModelIndex | QPersistentModelIndex
COL_INCLUDE, COL_ACTION, COL_OLD, COL_ARROW, COL_NEW, COL_NOTE = range(6)
KIND_KEYS = {
    OpKind.RENAME: "preview.rename",
    OpKind.MOVE: "preview.move",
    OpKind.COPY: "preview.copy",
    OpKind.CREATE_FOLDER: "preview.create_folder",
    OpKind.DELETE: "preview.delete",
}
SYMBOLS = {OpStatus.OK: "✓", OpStatus.WARNING: "⚠", OpStatus.CONFLICT: "⚠", OpStatus.INVALID: "✕"}


def action_label(op: PlannedOp) -> str:
    """``✓ Rename`` / ``⚠ Conflict`` / ``✕ Invalid`` - the first column of the preview."""
    if op.status == OpStatus.CONFLICT:
        return f"{SYMBOLS[op.status]} {tr('preview.conflict')}"
    if op.status == OpStatus.INVALID:
        return f"{SYMBOLS[op.status]} {tr('preview.invalid')}"
    return f"{SYMBOLS[op.status]} {tr(KIND_KEYS[op.kind])}"


class PreviewModel(QAbstractTableModel):
    """Rows are the plan's visible (non-no-op) operations."""

    changed = Signal()  # an include checkbox was toggled and the plan was re-validated

    def __init__(self) -> None:
        super().__init__()
        self._plan: Plan | None = None
        self._rows: list[PlannedOp] = []
        self._palette: dict[str, str] = {}

    def set_palette(self, palette: dict[str, str]) -> None:
        self._palette = palette
        if self._rows:
            self.dataChanged.emit(self.index(0, 0), self.index(len(self._rows) - 1, 5), [Qt.ItemDataRole.BackgroundRole])

    def set_plan(self, plan: Plan | None) -> None:
        self.beginResetModel()
        self._plan = plan
        self._rows = [op for op in plan.ops if not op.noop] if plan else []
        self.endResetModel()

    def refresh(self) -> None:
        """Re-read statuses after validation, keeping scroll/selection unless the row set changed."""
        rows = [op for op in self._plan.ops if not op.noop] if self._plan else []
        if [op.id for op in rows] == [op.id for op in self._rows]:
            if self._rows:
                self.dataChanged.emit(self.index(0, 0), self.index(len(self._rows) - 1, 5))
        else:  # an automatically created folder appeared or vanished
            self.set_plan(self._plan)

    # ---------------------------------------------------------------- Qt model
    def rowCount(self, parent: _Index = QModelIndex()) -> int:  # noqa: B008
        return 0 if parent.isValid() else len(self._rows)

    def columnCount(self, parent: _Index = QModelIndex()) -> int:  # noqa: B008
        return 0 if parent.isValid() else 6

    def headerData(self, section: int, orientation: Qt.Orientation, role: int = Qt.ItemDataRole.DisplayRole) -> object:
        if orientation == Qt.Orientation.Horizontal and role == Qt.ItemDataRole.DisplayRole:
            keys = ("", "preview.col_action", "preview.col_old", "", "preview.col_new", "preview.col_note")
            return tr(keys[section]) if keys[section] else ""
        return None

    def flags(self, index: _Index) -> Qt.ItemFlag:
        flags = Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable
        if index.column() == COL_INCLUDE:
            flags |= Qt.ItemFlag.ItemIsUserCheckable
        return flags

    def data(self, index: _Index, role: int = Qt.ItemDataRole.DisplayRole) -> object:
        if not index.isValid():
            return None
        op = self._rows[index.row()]
        col = index.column()
        if role == Qt.ItemDataRole.CheckStateRole and col == COL_INCLUDE:
            return Qt.CheckState.Checked if op.included else Qt.CheckState.Unchecked
        if role == Qt.ItemDataRole.DisplayRole:
            return self._text(op, col)
        if role == Qt.ItemDataRole.ToolTipRole:
            return "\n".join(filter(None, [op.source, f"→ {op.target}" if op.target else "", *op.messages]))
        if role == Qt.ItemDataRole.BackgroundRole and self._palette and op.included:
            return QBrush(QColor(self._palette[self._row_colour(op)]))
        if role == Qt.ItemDataRole.ForegroundRole and col == COL_ACTION and self._palette:
            return QBrush(QColor(self._palette[self._text_colour(op)]))
        if role == Qt.ItemDataRole.ForegroundRole and not op.included and self._palette:
            return QBrush(QColor(self._palette["disabled"]))
        if role == Qt.ItemDataRole.FontRole and col == COL_ACTION:
            font = QFont()
            font.setBold(True)
            return font
        return None

    @staticmethod
    def _row_colour(op: PlannedOp) -> str:
        if op.status == OpStatus.INVALID:
            return "row_bad"
        if op.status == OpStatus.CONFLICT:
            return "row_warn"
        if op.kind == OpKind.DELETE:
            return "row_delete"
        return "row_warn" if op.status == OpStatus.WARNING else "row_ok"

    @staticmethod
    def _text_colour(op: PlannedOp) -> str:
        if op.status == OpStatus.INVALID or op.kind == OpKind.DELETE:
            return "danger"
        if op.status in (OpStatus.CONFLICT, OpStatus.WARNING):
            return "warning"
        return "success"

    def _text(self, op: PlannedOp, col: int) -> str:
        if col == COL_ACTION:
            return action_label(op)
        if col == COL_OLD:
            return op.source or ("—" if op.kind != OpKind.CREATE_FOLDER else "")
        if col == COL_ARROW:
            return "→"
        if col == COL_NEW:
            if op.kind == OpKind.DELETE:
                permanent = self._plan is not None and self._plan.delete_mode == "permanent"
                return tr("preview.deleted_forever" if permanent else "preview.to_trash")
            return op.target or ""
        if col == COL_NOTE:
            return " ".join(op.messages) or op.info
        return ""

    def setData(self, index: _Index, value: object, role: int = Qt.ItemDataRole.EditRole) -> bool:
        if index.isValid() and index.column() == COL_INCLUDE and role == Qt.ItemDataRole.CheckStateRole:
            self._rows[index.row()].included = Qt.CheckState(value) == Qt.CheckState.Checked  # type: ignore[arg-type]
            if self._plan is not None:
                self._plan.revalidate()
            self.refresh()
            self.changed.emit()
            return True
        return False


class TintDelegate(QStyledItemDelegate):
    """Paints each row's status tint (the stylesheet would otherwise ignore the model's background)."""

    def paint(self, painter, option, index):  # type: ignore[no-untyped-def]  # noqa: ANN001
        brush = index.data(Qt.ItemDataRole.BackgroundRole)
        if brush is not None and not (option.state & QStyle.StateFlag.State_Selected):
            painter.fillRect(option.rect, brush)
        super().paint(painter, option, index)


class PreviewPanel(Card):
    """Shows the plan and the Cancel / Apply Changes buttons."""

    apply_requested = Signal()
    cancel_requested = Signal()

    def __init__(self, icons: IconBinder) -> None:
        super().__init__("preview.title")
        self.plan: Plan | None = None
        self.model = PreviewModel()

        self.info = QLabel()
        self.info.setObjectName("Muted")
        self.info.setWordWrap(True)
        self.header.insertWidget(1, self.info, 1)

        self.table = QTableView()
        self.table.setModel(self.model)
        self.table.setItemDelegate(TintDelegate(self.table))
        self.table.setAlternatingRowColors(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setShowGrid(False)
        self.table.setWordWrap(False)
        self.table.setTextElideMode(Qt.TextElideMode.ElideMiddle)
        self.table.verticalHeader().hide()
        self.table.verticalHeader().setDefaultSectionSize(30)
        self.table.setMinimumHeight(120)
        header = self.table.horizontalHeader()
        header.setDefaultAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        header.setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        header.setSectionResizeMode(COL_OLD, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(COL_NEW, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(COL_INCLUDE, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(COL_ARROW, QHeaderView.ResizeMode.Fixed)
        self.table.setColumnWidth(COL_INCLUDE, 44)
        self.table.setColumnWidth(COL_ACTION, 140)
        self.table.setColumnWidth(COL_ARROW, 28)
        self.table.setColumnWidth(COL_NOTE, 280)
        self.model.changed.connect(self._update_summary)
        self.body.addWidget(self.table, 1)

        self.empty_label = QLabel()
        self.empty_label.setObjectName("Muted")
        self.empty_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.empty_label.setWordWrap(True)
        self.body.addWidget(self.empty_label)

        footer = QHBoxLayout()
        self.summary = QLabel()
        self.summary.setObjectName("Muted")
        self.summary.setWordWrap(True)
        footer.addWidget(self.summary, 1)
        self.cancel_button = make_button("common.cancel", self._tr, icon="x", binder=icons, tooltip_key="preview.cancel_tip")
        self.cancel_button.clicked.connect(self.cancel_requested)
        self.apply_button = make_button(
            None, self._tr, icon="check", binder=icons, icon_color="#ffffff", name="Primary", tooltip_key="preview.apply_tip"
        )
        self.apply_button.clicked.connect(self.apply_requested)
        footer.addWidget(self.cancel_button)
        footer.addWidget(self.apply_button)
        self.body.addLayout(footer)
        self.clear()

    # ------------------------------------------------------------------ public
    def set_palette(self, palette: dict[str, str]) -> None:
        self.model.set_palette(palette)

    def set_plan(self, plan: Plan, info: str = "") -> None:
        """Show ``plan``; ``info`` is the provider/summary line."""
        self.plan = plan
        self.model.set_plan(plan)
        self.info.setText(info)
        self._update_summary()

    def clear(self) -> None:
        self.plan = None
        self.model.set_plan(None)
        self.info.setText("")
        self._update_summary()

    def apply_count(self) -> int:
        """Number of user-visible changes that would be applied."""
        return sum(self.plan.kind_summary().values()) if self.plan else 0

    # ----------------------------------------------------------------- summary
    def _update_summary(self) -> None:
        plan = self.plan
        has_rows = plan is not None and self.model.rowCount() > 0
        self.table.setVisible(has_rows)
        self.empty_label.setVisible(not has_rows)
        self.empty_label.setText(
            tr("preview.empty_nothing") if plan is not None else tr("preview.empty_initial")
        )
        count = self.apply_count()
        self.apply_button.setText(tr("preview.apply_n", count=count) if count else tr("preview.apply"))
        self.apply_button.setEnabled(count > 0)
        self.cancel_button.setEnabled(plan is not None)
        if plan is None:
            self.summary.setText("")
            return
        counts = plan.counts()
        parts = [tr("preview.sum_ready", count=count)]
        if counts["conflict"]:
            parts.append(tr("preview.sum_conflicts", count=counts["conflict"]))
        if counts["invalid"]:
            parts.append(tr("preview.sum_invalid", count=counts["invalid"]))
        warnings = counts["warning"] - len(plan.delete_ops)
        if warnings > 0:
            parts.append(tr("preview.sum_warnings", count=warnings))
        if plan.delete_ops:
            parts.append(tr("preview.sum_deletes", count=len(plan.delete_ops)))
        if plan.unchanged:
            parts.append(tr("preview.sum_unchanged", count=plan.unchanged))
        self.summary.setText("  ·  ".join(parts))

    def retranslate(self) -> None:
        super().retranslate()
        self.model.headerDataChanged.emit(Qt.Orientation.Horizontal, 0, 5)
        self._update_summary()
