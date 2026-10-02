"""AI Video File Assistant - application entry point."""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    """Create the Qt application, apply settings and show the main window."""
    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication

    from app.config.constants import APP_NAME, APP_ORGANIZATION
    from app.context import AppContext
    from app.i18n import set_language
    from app.ui.gc_guard import MainThreadGC
    from app.ui.main_window import MainWindow
    from app.ui.theme import apply_theme
    from app.utils.helpers import resource_path
    from app.utils.logger import get_logger, setup_logging

    argv = sys.argv if argv is None else argv
    app = QApplication(argv)
    app.setApplicationName(APP_NAME)
    app.setOrganizationName(APP_ORGANIZATION)
    app.setQuitOnLastWindowClosed(True)
    gc_guard = MainThreadGC(app)  # never let Python's GC destroy Qt objects from a worker thread
    icon = resource_path("icons", "app.png")
    if icon.exists():
        app.setWindowIcon(QIcon(str(icon)))

    ctx = AppContext.create()
    settings = ctx.settings.load()
    setup_logging(settings.log_level)
    set_language(settings.language)
    apply_theme(app, settings.theme)
    get_logger("app").info("Startup complete (theme=%s, language=%s)", settings.theme, settings.language)

    window = MainWindow(ctx)
    window.show()
    window.raise_()
    window.activateWindow()
    code = app.exec()
    gc_guard.stop()
    return code


if __name__ == "__main__":
    sys.exit(main())
