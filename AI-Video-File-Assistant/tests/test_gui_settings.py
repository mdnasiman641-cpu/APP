"""Settings dialog behaviour (headless Qt)."""

from __future__ import annotations

import pytest
from PySide6.QtWidgets import QLineEdit, QMessageBox

from app.ai import openai_provider
from app.context import AppContext
from app.i18n import set_language
from app.ui.settings_window import SettingsDialog
from app.ui.theme import apply_theme
from tests.fake_ai_server import FakeAIServer
from tests.helpers import wait_until

pytestmark = pytest.mark.gui
KEY = "sk-test-ABCDEFGHIJKLMNOP1234"


@pytest.fixture
def dialog(qapp, tmp_path, dispose):
    apply_theme(qapp, "dark")
    ctx = AppContext.create(tmp_path / "ctx")
    dlg = SettingsDialog(ctx)
    dlg.ctx_for_test = ctx
    yield dlg
    dispose(dlg)
    set_language("en")


def test_auto_apply_is_off_by_default_and_prevent_overwrite_on(dialog):
    assert not dialog.auto_apply.isChecked()
    assert dialog.prevent_overwrite.isChecked() and dialog.ask_before.isChecked()
    assert not dialog.include_subfolders.isChecked()


def test_key_field_is_masked_and_toggle_shows_text(dialog):
    row = dialog.openai_key
    assert row.input.echoMode() == QLineEdit.EchoMode.Password
    row.toggle.setChecked(True)
    assert row.input.echoMode() == QLineEdit.EchoMode.Normal
    row.toggle.setChecked(False)
    assert row.input.echoMode() == QLineEdit.EchoMode.Password


def test_saving_a_key_stores_it_encrypted_and_shows_only_the_tail(dialog):
    ctx = dialog.ctx_for_test
    dialog.openai_key.input.setText(KEY)
    dialog.save()
    assert ctx.settings.api_key("openai") == KEY
    assert "ABCDEFGH" not in (ctx.db.get_raw("secret.openai_api_key") or "")
    dialog.openai_key.refresh_status()
    text = dialog.openai_key.status.text()
    assert text.endswith("************1234") and KEY not in text
    assert dialog.openai_key.input.text() == ""  # the typed key is cleared after saving
    assert not any(KEY in w.text() for w in dialog.findChildren(__import__("PySide6.QtWidgets", fromlist=["QLabel"]).QLabel))


def test_remove_key_asks_then_deletes(dialog, monkeypatch):
    ctx = dialog.ctx_for_test
    ctx.settings.set_api_key("gemini", "AIzaSyKEY-1234567890-abcdefghijklmn")
    dialog.gemini_key.refresh_status()
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.No)
    dialog.gemini_key.remove_button.click()
    assert ctx.settings.has_api_key("gemini")
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.Yes)
    dialog.gemini_key.remove_button.click()
    assert not ctx.settings.has_api_key("gemini")
    assert not dialog.gemini_key.remove_button.isEnabled()


def test_test_connection_success_and_failure(dialog, monkeypatch):
    with FakeAIServer() as srv:
        monkeypatch.setattr(openai_provider, "OPENAI_API_BASE", srv.base)
        row = dialog.openai_key
        row.input.setText(KEY)
        srv.queue(200, {"data": [{"id": "gpt-4o-mini"}, {"id": "gpt-4o"}]})
        row.test_button.click()
        assert wait_until(lambda: row.result.text().startswith("✓"))
        assert "2 models" in row.result.text()
        assert dialog.openai_model.count() == 2  # model list refreshed from the account
        assert srv.requests[0]["headers"]["authorization"] == f"Bearer {KEY}"

        srv.queue(401, {"error": {"message": "Incorrect API key provided"}})
        row.test_button.click()
        assert wait_until(lambda: row.result.text().startswith("✗"))
        assert "Authentication" in row.result.text()
    assert KEY not in row.result.text()


def test_test_button_disabled_without_any_key(dialog):
    assert not dialog.gemini_key.test_button.isEnabled()
    dialog.gemini_key.input.setText("something")
    assert dialog.gemini_key.test_button.isEnabled()


def test_enabling_auto_apply_requires_confirmation(dialog, monkeypatch):
    monkeypatch.setattr(QMessageBox, "warning", lambda *a, **k: QMessageBox.StandardButton.No)
    dialog.auto_apply.setChecked(True)
    assert not dialog.auto_apply.isChecked()
    monkeypatch.setattr(QMessageBox, "warning", lambda *a, **k: QMessageBox.StandardButton.Yes)
    dialog.auto_apply.setChecked(True)
    assert dialog.auto_apply.isChecked()


def test_save_roundtrips_all_options(dialog):
    ctx = dialog.ctx_for_test
    dialog.gemini_model.setCurrentText("my-gemini-model")
    dialog.openai_model.setCurrentText("my-openai-model")
    dialog.default_provider.setCurrentIndex(dialog.default_provider.findData("auto"))
    dialog.auto_preferred.setCurrentIndex(dialog.auto_preferred.findData("openai"))
    dialog.fallback_mode.setCurrentIndex(dialog.fallback_mode.findData("ask"))
    dialog.batch_size.setValue(25)
    dialog.theme.setCurrentIndex(dialog.theme.findData("light"))
    dialog.language.setCurrentIndex(dialog.language.findData("bn"))
    dialog.delete_mode.setCurrentIndex(dialog.delete_mode.findData("permanent"))
    dialog.duplicate_policy.setCurrentIndex(dialog.duplicate_policy.findData("number"))
    dialog.prevent_overwrite.setChecked(False)
    dialog.save()
    s = ctx.settings.reload()
    assert (s.gemini_model, s.openai_model) == ("my-gemini-model", "my-openai-model")
    assert (s.default_provider, s.auto_preferred_provider, s.fallback_mode) == ("auto", "openai", "ask")
    assert (s.batch_size, s.theme, s.language) == (25, "light", "bn")
    assert (s.delete_mode, s.duplicate_policy, s.prevent_overwrite) == ("permanent", "number", False)
    assert s.auto_apply is False


def test_dialog_translates_to_bangla(dialog):
    set_language("bn")
    dialog.retranslate()
    assert dialog.tabs.tabText(0) == "AI" and dialog.tabs.tabText(1) == "ফাইল অপারেশন"
    assert dialog.openai_key.test_button.text() == "সংযোগ পরীক্ষা"
