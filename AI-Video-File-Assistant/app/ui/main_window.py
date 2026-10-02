"""Main application window."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from PySide6.QtCore import QEvent, QObject, Qt, QThreadPool, QUrl
from PySide6.QtGui import QCloseEvent, QDragEnterEvent, QDropEvent, QIcon
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from app.config.constants import APP_NAME, FileKind
from app.context import AppContext
from app.files.scanner import ScanResult
from app.i18n import tr
from app.ui.files_panel import FilesPanel
from app.ui.icons import get_icon
from app.ui.theme import PALETTES, resolve_theme
from app.ui.widgets import Card, Retranslator, make_button
from app.utils.helpers import resource_path
from app.utils.logger import get_logger
from app.workers.base_worker import BaseWorker
from app.workers.scan_worker import ScanWorker

log = get_logger("ui.main")


class MainWindow(QMainWindow):
    """Dashboard: folder → files → AI command → preview → apply → undo."""

    def __init__(self, ctx: AppContext) -> None:
        super().__init__()
        self.ctx = ctx
        self.settings = ctx.settings.load()
        self.workspace: Path | None = None
        self._tr = Retranslator()
        self._pool = QThreadPool.globalInstance()
        self._workers: set[BaseWorker] = set()
        self._scan_generation = 0
        self._busy = 0
        self._pending_check: set[str] = set()
        self._icon_color = PALETTES[resolve_theme(self.settings.theme)]["muted"]

        self._tr.title(self, "app.title")
        self.setMinimumSize(900, 640)
        self.resize(1200, 820)
        icon_path = resource_path("icons", "app.png")
        if icon_path.exists():
            self.setWindowIcon(QIcon(str(icon_path)))
        self.setAcceptDrops(True)

        self._build_ui()
        self._restore_geometry()
        QApplication.instance().installEventFilter(self)  # type: ignore[union-attr]
        self.show_status(tr("status.ready"))
        if self.settings.reopen_last_folder and self.settings.last_folder:
            if Path(self.settings.last_folder).is_dir():
                self.load_folder(self.settings.last_folder)

    # ------------------------------------------------------------------ build
    def _build_ui(self) -> None:
        root = QWidget()
        root.setObjectName("Root")
        self.setCentralWidget(root)
        layout = QVBoxLayout(root)
        layout.setContentsMargins(18, 14, 18, 12)
        layout.setSpacing(12)

        layout.addLayout(self._build_header())
        self.folder_card = self._build_folder_card()
        layout.addWidget(self.folder_card)

        self.splitter = QSplitter(Qt.Orientation.Vertical)
        self.splitter.setChildrenCollapsible(False)
        self.files_panel = FilesPanel(self._icon_color)
        self.files_panel.selection_changed.connect(self._on_selection_changed)
        self.splitter.addWidget(self.files_panel)
        layout.addWidget(self.splitter, 1)

        self._build_status_bar()

    def _build_header(self) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setSpacing(6)
        title = QLabel()
        title.setObjectName("AppTitle")
        self._tr.bind(lambda t: title.setText(t.upper()), "app.title")
        row.addWidget(title)
        row.addStretch(1)
        self.header_layout = row
        self.header_buttons: dict[str, QPushButton] = {}
        return row

    def add_header_button(self, key: str, icon_name: str, text_key: str, tip_key: str, handler: Callable[[], None]) -> None:
        """Add a button to the top-right of the header (used for Prompts / History / Settings)."""
        button = make_button(
            text_key, self._tr, icon=get_icon(icon_name, self._icon_color, 18), name="HeaderButton", tooltip_key=tip_key
        )
        button.clicked.connect(handler)
        self.header_buttons[key] = button
        self.header_layout.addWidget(button)

    def _build_folder_card(self) -> Card:
        card = Card("folder.title")
        row = QHBoxLayout()
        row.setSpacing(8)
        self.folder_edit = QLineEdit()
        self.folder_edit.setClearButtonEnabled(True)
        self.folder_edit.setAcceptDrops(False)  # drops are handled by the window
        self._tr.placeholder(self.folder_edit, "folder.placeholder")
        self.folder_edit.returnPressed.connect(self._on_folder_entered)
        row.addWidget(self.folder_edit, 1)
        self.browse_button = make_button(
            "folder.browse", self._tr, icon=get_icon("folder", "#ffffff", 16), name="Primary", tooltip_key="folder.browse_tip"
        )
        self.browse_button.clicked.connect(self.browse_folder)
        row.addWidget(self.browse_button)
        self.refresh_button = make_button(
            "folder.refresh", self._tr, icon=get_icon("refresh", self._icon_color, 16), tooltip_key="folder.refresh_tip"
        )
        self.refresh_button.clicked.connect(self.refresh)
        row.addWidget(self.refresh_button)
        card.body.addLayout(row)

        row2 = QHBoxLayout()
        self.subfolders_check = QCheckBox()
        self._tr.text(self.subfolders_check, "folder.subfolders")
        self._tr.tooltip(self.subfolders_check, "folder.subfolders_tip")
        self.subfolders_check.setChecked(self.settings.include_subfolders)
        self.subfolders_check.toggled.connect(self._on_subfolders_toggled)
        row2.addWidget(self.subfolders_check)
        row2.addStretch(1)
        hint = QLabel()
        hint.setObjectName("DropHint")
        self._tr.text(hint, "folder.drop_hint")
        row2.addWidget(hint)
        card.body.addLayout(row2)
        return card

    def _build_status_bar(self) -> None:
        bar = self.statusBar()
        bar.setSizeGripEnabled(False)
        self.status_label = QLabel()
        self.status_label.setContentsMargins(8, 0, 0, 0)
        bar.addWidget(self.status_label, 1)
        self.progress = QProgressBar()
        self.progress.setFixedWidth(220)
        self.progress.setTextVisible(False)
        self.progress.hide()
        bar.addPermanentWidget(self.progress)
        self.provider_label = QLabel()
        self.provider_label.setContentsMargins(12, 0, 8, 0)
        bar.addPermanentWidget(self.provider_label)

    # ----------------------------------------------------------------- status
    def show_status(self, text: str, kind: str = "info") -> None:
        """Show a message in the status bar (``kind``: info / success / warning / error)."""
        self.status_label.setText(text)
        names = {"success": "Success", "warning": "Warning", "error": "Danger"}
        self.status_label.setObjectName(names.get(kind, ""))
        self.status_label.style().unpolish(self.status_label)
        self.status_label.style().polish(self.status_label)
        log.debug("status[%s]: %s", kind, text)

    def set_provider_text(self, text: str) -> None:
        self.provider_label.setText(text)

    def _set_busy(self, busy: bool, determinate: tuple[int, int] | None = None) -> None:
        if busy:
            self.progress.show()
            if determinate and determinate[1] > 0:
                self.progress.setRange(0, determinate[1])
                self.progress.setValue(determinate[0])
            else:
                self.progress.setRange(0, 0)
        else:
            self.progress.hide()

    # ----------------------------------------------------------------- workers
    def run_worker(
        self,
        worker: BaseWorker,
        *,
        on_result: Callable[[object], None] | None = None,
        on_error: Callable[[str, object], None] | None = None,
        on_cancelled: Callable[[], None] | None = None,
        on_progress: Callable[[int, int, str], None] | None = None,
        busy: bool = True,
    ) -> BaseWorker:
        """Start ``worker`` on the thread pool; the window keeps it alive until it finishes."""
        self._workers.add(worker)
        if busy:
            self._busy += 1
            self._set_busy(True)
        signals = worker.signals
        if on_result:
            signals.result.connect(on_result)
        if on_error:
            signals.error.connect(on_error)
        else:
            signals.error.connect(lambda msg, _exc: self._show_error(msg))
        if on_cancelled:
            signals.cancelled.connect(on_cancelled)
        signals.progress.connect(on_progress or self._default_progress)
        signals.finished.connect(lambda: self._worker_finished(worker, busy))
        self._pool.start(worker)
        return worker

    def _default_progress(self, done: int, total: int, message: str) -> None:
        if message:
            self.show_status(message)
        if total > 0:
            self._set_busy(True, (done, total))

    def _worker_finished(self, worker: BaseWorker, counted: bool) -> None:
        self._workers.discard(worker)
        if counted:
            self._busy = max(0, self._busy - 1)
            if self._busy == 0:
                self._set_busy(False)

    def _show_error(self, message: str) -> None:
        self.show_status(message, "error")
        QMessageBox.warning(self, APP_NAME, message)

    # ------------------------------------------------------------------ folder
    def browse_folder(self) -> None:
        start = str(self.workspace) if self.workspace else self.settings.last_folder or str(Path.home())
        chosen = QFileDialog.getExistingDirectory(self, tr("folder.dialog_title"), start)
        if chosen:
            self.load_folder(chosen)

    def _on_folder_entered(self) -> None:
        text = self.folder_edit.text().strip().strip('"')
        if text:
            self.load_folder(text)

    def load_folder(self, path: str | Path) -> None:
        """Select ``path`` as the workspace and scan it."""
        folder = Path(path)
        if not folder.is_dir():
            self.show_status(tr("error.folder_missing", path=str(folder)), "error")
            QMessageBox.warning(self, APP_NAME, tr("error.folder_missing", path=str(folder)))
            return
        self.workspace = folder
        self.folder_edit.setText(str(folder))
        self.ctx.settings.update(last_folder=str(folder))
        self.settings = self.ctx.settings.load()
        self.refresh()

    def refresh(self) -> None:
        """Rescan the current folder."""
        if self.workspace is None:
            self.show_status(tr("status.choose_folder"), "warning")
            return
        self._scan_generation += 1
        generation = self._scan_generation
        worker = ScanWorker(self.workspace, self.subfolders_check.isChecked())
        self.show_status(tr("status.scanning"))
        self.run_worker(
            worker,
            on_result=lambda res: self._on_scan_done(generation, res),  # type: ignore[arg-type]
            on_error=lambda msg, _e: self._on_scan_failed(generation, msg),
        )

    def _on_scan_done(self, generation: int, result: ScanResult) -> None:
        if generation != self._scan_generation:
            return  # a newer scan superseded this one
        self.files_panel.set_entries(result.entries)
        if self._pending_check:
            names = self._pending_check
            self._pending_check = set()
            self.files_panel.check_paths(e.rel_path for e in result.entries if e.name in names)
        self.show_status(tr("status.files_found_in", count=len(result.entries), folder=result.root.name or str(result.root)))
        log.info("Folder loaded: %d files", len(result.entries))

    def _on_scan_failed(self, generation: int, message: str) -> None:
        if generation != self._scan_generation:
            return
        self.files_panel.set_entries([])
        self._show_error(message)

    def _on_subfolders_toggled(self, checked: bool) -> None:
        self.ctx.settings.update(include_subfolders=checked)
        self.settings = self.ctx.settings.load()
        if self.workspace is not None:
            self.refresh()

    def _on_selection_changed(self, count: int) -> None:
        """Hook for later phases (enables/disables command controls)."""

    # -------------------------------------------------------------- drag & drop
    def eventFilter(self, obj: QObject, event: QEvent) -> bool:  # noqa: N802
        """Catch folder/file drops anywhere in this window (child widgets would swallow them)."""
        kind = event.type()
        if kind in (QEvent.Type.DragEnter, QEvent.Type.DragMove, QEvent.Type.Drop):
            if isinstance(obj, QWidget) and obj.window() is self and event.mimeData().hasUrls():  # type: ignore[attr-defined]
                if kind == QEvent.Type.Drop:
                    assert isinstance(event, QDropEvent)
                    self.handle_drop(event.mimeData().urls())
                event.accept()
                return True
        return super().eventFilter(obj, event)

    def dragEnterEvent(self, event: QDragEnterEvent) -> None:  # noqa: N802
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event: QDropEvent) -> None:  # noqa: N802
        self.handle_drop(event.mimeData().urls())
        event.acceptProposedAction()

    def handle_drop(self, urls: list[QUrl]) -> None:
        """A dropped folder becomes the workspace; dropped files select themselves in their folder."""
        paths = [Path(u.toLocalFile()) for u in urls if u.isLocalFile()]
        if not paths:
            return
        first = paths[0]
        if first.is_dir():
            self.load_folder(first)
            return
        folder = first.parent
        same_folder = [p for p in paths if p.parent == folder and p.is_file()]
        skipped = len(paths) - len(same_folder)
        self._pending_check = {p.name for p in same_folder}
        if any(p.suffix.lower() and self._kind_of(p) != FileKind.VIDEO for p in same_folder):
            self.files_panel.set_filter("all")
        self.load_folder(folder)
        if skipped:
            self.show_status(tr("status.drop_skipped", count=skipped), "warning")

    @staticmethod
    def _kind_of(path: Path) -> FileKind:
        from app.utils.helpers import classify_extension

        return classify_extension(path.suffix)

    # ------------------------------------------------------------------ misc
    def retranslate(self) -> None:
        self._tr.retranslate()
        self.folder_card.retranslate()
        self.files_panel.retranslate()
        if not self.status_label.text():
            self.show_status(tr("status.ready"))

    def _restore_geometry(self) -> None:
        if self.settings.window_geometry:
            from PySide6.QtCore import QByteArray

            self.restoreGeometry(QByteArray.fromBase64(self.settings.window_geometry.encode("ascii")))

    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802
        for worker in list(self._workers):
            worker.cancel()
        self._pool.waitForDone(3000)
        try:
            geometry = bytes(self.saveGeometry().toBase64().data()).decode("ascii")
            self.ctx.settings.update(window_geometry=geometry)
        except Exception:  # noqa: BLE001 - never block closing
            log.debug("could not persist window geometry", exc_info=True)
        QApplication.instance().removeEventFilter(self)  # type: ignore[union-attr]
        super().closeEvent(event)

