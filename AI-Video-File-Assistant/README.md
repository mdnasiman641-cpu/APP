# AI Video File Assistant

A Windows desktop app that renames and organises (video) files from **plain-language commands in English or Bangla**.
You pick a folder, type what you want — *"Remove 1080p and WEB-DL from all filenames"*, *"সব ভিডিওর নামের শেষে 01 থেকে numbering দাও"* —
review a colour-coded **preview**, click **Apply**, and can **Undo** the whole batch afterwards.

* Gemini **or** OpenAI (or **Auto** with fallback) — the AI only *describes* the change; the app validates and performs it.
* Simple commands run **offline** (no AI request, no cost). Big folders need **one** request, not one per file.
* Nothing is changed without a preview. Every batch is journaled, atomic and undoable.

## Contents
1. [Quick start (using the .exe)](#quick-start)
2. [Building the .exe](#building-the-exe)
3. [How a command is processed](#how-a-command-is-processed)
4. [Safety model](#safety-model)
5. [Settings, API keys and models](#settings-api-keys-and-models)
6. [Command examples](#command-examples)
7. [Undo, history and the undo-trash](#undo-history-and-the-undo-trash)
8. [Optional: durations and thumbnails (ffmpeg)](#optional-durations-and-thumbnails-ffmpeg)
9. [Tests](#tests) · [Project layout](#project-layout) · [Extending](#extending-the-app) · [Troubleshooting](#troubleshooting)

## Quick start
1. Start **AI Video File Assistant.exe**. 2. *Settings → AI*: paste a Gemini and/or OpenAI API key and press **Test Connection**.
3. **Browse** (or drag & drop a folder). 4. Type a command, choose **Gemini / OpenAI / Auto**, press **Generate Preview** (Ctrl+Enter).
5. Check the preview, then **Apply Changes**. 6. Changed your mind? **Undo** (top right) or open **History**.

Offline commands need no key at all. Only file **names** (never file contents, never full paths) are sent to an AI.

## Building the .exe
Requirements: Windows 10/11 and **Python 3.12+** (python.org installer, "Add to PATH" + "py launcher").

```bat
cd AI-Video-File-Assistant
build.bat              rem one-folder build  -> dist\AI Video File Assistant\AI Video File Assistant.exe
build.bat onefile      rem single-file build -> dist\AI Video File Assistant.exe
```

`build.bat` creates `.venv`, installs `requirements-dev.txt`, **runs the test-suite** (the build stops if a test fails), runs PyInstaller with
`AI Video File Assistant.spec`, then **starts the new exe with `--self-test`** (scan → plan → apply → undo in a temp folder) to prove the bundle is complete.
`set SKIP_TESTS=1` skips the test run. Running from source: `python -m pip install -r requirements.txt` then `python main.py`.

### Packaging trade-offs (why the default is one-folder)
| | **One-folder** (default) | One-file (`build.bat onefile`) |
|---|---|---|
| Start-up | fast (nothing to unpack) | slower: unpacks ~60–150 MB to `%TEMP%` on **every** launch |
| Antivirus | fewer false positives | self-extracting exes are flagged more often |
| ffmpeg/ffprobe | bundled by dropping the `.exe`s into `app\resources\bin` before building | would be re-extracted each launch, so **not bundled** — put `bin\ffprobe.exe`/`ffmpeg.exe` next to the exe or use *Settings → General* |
| Distribution | zip the folder | one file |

Both builds are verified in CI-style runs of `--self-test`. Ship the one-folder build as a zip (or wrap it with an installer such as Inno Setup).

## How a command is processed
```
command ──► offline parser ─(simple? done, 0 requests)
              │ no
              ▼
        AI router ── Gemini / OpenAI / Auto(+fallback) ──► JSON only
              ▼
        strict response parser   (untrusted data!)
              ▼
        planner  ── rule actions applied locally to ALL selected files
                 ── explicit actions resolved, every path validated
              ▼
        batch validator ── conflicts, duplicates, overwrites, missing folders
              ▼
        PREVIEW ──(you)──► operation manager: journal → two-phase rename → commit / rollback
```
* **Rule actions** (`remove_text`, `replace_text`, `add_prefix`, `add_suffix`, `numbering`, `change_case`, `sort`, and `move`/`copy`/`delete` with `match`) are described
  once by the AI and applied locally to every file — so a 5 000-file folder costs **one** request.
* **Explicit actions** (`rename`, `move`, `copy`, `delete`, `create_folder`) are used when each file needs its own interpretation; those files are sent in
  **batches** (*Settings → Files per AI request*, default 50).
* `sort` reorders the working list (affects numbering order and the table); it never touches files.

## Safety model
* The AI **never executes anything**. It can only return the 12 whitelisted action types; anything else — or any answer containing keys like `command`, `shell`, `powershell`,
  `script`, `exec` — is rejected as a whole. No shell, CMD, PowerShell, registry or process is ever used on AI output.
* AI output is **untrusted**: JSON is parsed strictly; sources must be among the *selected* files; targets must be plain relative names — no absolute paths, drive letters, UNC paths, `..`,
  illegal Windows characters, reserved names (`CON`, `NUL`…), trailing dots/spaces, or paths that leave the workspace through symlinks/junctions.
* File names in the prompt are marked as **data, not instructions** (prompt-injection hardening), and a deleting plan is only ever a *preview* until you confirm.
* **Extensions are preserved** unless the command explicitly asks otherwise; an unrequested change (`.mp4`→`.mkv`) is rejected.
* **Previews first**: conflicts and invalid rows are shown and skipped; valid rows can be un-ticked individually (the plan is re-validated).
* **Deletes** always need an extra confirmation ("Delete 3 files? This action may not be reversible."), even with *Ask before applying* off or *Auto Apply* on.
  Auto Apply (off by default) never applies plans containing deletes, conflicts or invalid rows.
* **Two-phase renames** (`A→B`, `B→C`, swaps, case-only changes) go through `.tmp_ai_*` temp names so nothing is ever overwritten.
* **All-or-nothing**: every step is journaled in SQLite first; if one file fails (locked, disk full, cancelled) everything done so far is rolled back.
* API keys are stored encrypted with **Windows DPAPI** (only your Windows user can decrypt), shown as `************ABCD`, sent in HTTP *headers* (never URLs), and scrubbed from logs.

## Settings, API keys and models
*Settings → AI* has key entry (hidden by default, **Show/Hide**, **Test Connection** — a free models-list call —, **Remove Key**), the **model** for each provider (editable;
**Test Connection** also refreshes the list from your account), default provider, *Auto* preferred provider and fallback behaviour (automatic / ask / never),
batch size, timeout and *Handle simple commands offline*. **No model name is hard-coded outside `app/config/constants.py`** — change it in Settings whenever vendors rename models.
*File Operations*: ask before applying, operation history, prevent overwrite, include subfolders, **Auto Apply (off by default)**, duplicate-name policy, delete mode (undo-trash / permanent).
*Appearance*: Dark / Light / System. *General*: reopen last folder, **language (English / বাংলা)**, default filter, log level, ffmpeg folder.

In **Auto** mode the status bar always shows what happened — `Gemini ✓` or `Gemini failed → OpenAI fallback ✓`; explicit Gemini/OpenAI choices never fall back.
Data folder: `%APPDATA%\AI Video File Assistant` (SQLite database, logs, thumbnail cache). Override with the `AIVFA_DATA_DIR` environment variable.

## Command examples
| You type | What happens |
|---|---|
| `Remove 1080p and WEB-DL from all filenames.` | offline: `remove_text` |
| `Replace WEB-DL with WEB.` / `Replace underscores with spaces` | offline: `replace_text` |
| `Add prefix "S02 - "` / `Blue Bloods নামটা শুরুতে যোগ করো।` | offline: `add_prefix` |
| `সব ভিডিওর নামের শেষে 01 থেকে numbering দাও।` | offline: `numbering` |
| `Convert filenames to lowercase` · `Sort by size descending` | offline: `change_case` · `sort` |
| `Clean these filenames and rename them sequentially as Blue Bloods Episode 01, 02 and 03.` | AI → one `numbering` rule → `Blue Bloods - Episode 01.mp4` … |
| `Season 2-এর সব ভিডিও আলাদা folder-এ রাখো।` | AI → `create_folder` + `move` by pattern |
| `Give each video a clean title from its name` | AI → explicit `rename` per file, in batches |

The five built-in **Saved Prompts** (Blue Bloods Rename, Clean Video Filename, Episode Numbering, Remove Quality Tags, YouTube Title Format) can be edited or deleted; save your own with **Save as prompt**.
**Recent** commands are one click away, can be favourited, reused or deleted.

## Undo, history and the undo-trash
Every applied batch is recorded (*History*: operation #, time, command, provider, summary, status, every item). **Undo** first checks the disk; if it cannot be done safely
(a file was renamed again, its original name is taken, a copy was edited, the trash was emptied…) it **explains why and changes nothing**. Deleted files go to
`.ai_video_assistant_trash` inside the folder (same drive → instant) so Undo can restore them; **History → Empty undo-trash** frees the space. Choose *Delete permanently* in Settings if you prefer — those files can't be restored.
Operations interrupted by a crash or power loss are marked *Interrupted* on the next start and can still be undone (temp files included).

## Optional: durations and thumbnails (ffmpeg)
With `ffprobe`/`ffmpeg` available (bundled in `app\resources\bin`, on `PATH`, or via *Settings → General*), the **Duration** column fills in **lazily for visible rows only**, results are cached in SQLite,
and selecting a video shows a cached **thumbnail**, resolution, fps and codecs. Thumbnails are never generated in bulk. Without ffmpeg these features just stay hidden.

## Tests
```bash
python -m pip install -r requirements-dev.txt
python -m pytest            # headless (QT_QPA_PLATFORM=offscreen is set automatically)
```
Over 500 tests cover validation, path traversal, collisions, two-phase renames, rollback, undo, recovery, JSON parsing, AI/offline command handling, API failures
(against a real local HTTP server), Bangla/Unicode names, the GUI workflow and 20 000-row performance. ffmpeg tests skip automatically if ffmpeg is absent.

## Project layout
```
main.py                      entry point (--self-test for packaging checks)
build.bat / *.spec           build + PyInstaller recipe
app/config/                  constants (models, limits), typed settings
app/ai/                      providers, router, prompt builder, response parser, schemas, pipeline
app/files/                   scanner, planner, validators, rename/move engines, operation manager, metadata, thumbnails
app/database/                SQLite access
app/workers/                 QRunnable workers (scan, AI, operations, ffprobe) - the UI never blocks
app/ui/                      main window, panels, dialogs, theme, icons
app/i18n/                    English + Bangla strings
tests/                       pytest suite
```

## Extending the app
* **New AI provider**: subclass `AIProvider` (`app/ai/base_provider.py`), register it in `app/ai/ai_router.py:PROVIDER_CLASSES`.
* **New action type**: add a dataclass in `app/ai/schemas.py`, a builder in `app/ai/response_parser.py`, handle it in `RuleEngine`/`Planner`, and describe it in `prompt_builder.SYSTEM_PROMPT`.
* **New language**: add `app/i18n/<code>.py` (same keys) and register it in `app/i18n/__init__.py`; a test enforces key parity.
* The architecture leaves room for the roadmap items (YouTube titles/descriptions, subtitle management, duplicate detection, categorisation, batch metadata editing, workflows):
  they are new action types + planner/executor handlers over the same preview → journal → undo pipeline.

## Troubleshooting
| Message | Meaning |
|---|---|
| *Authentication error* | The key was rejected — re-enter it (Settings → AI → Test Connection). |
| *Rate limit or quota reached* | Wait, check your plan, or switch to the other provider / Auto. |
| *Network error / Timeout* | No connection or a slow reply; raise *Request timeout* or retry. |
| *The file is in use by another program* | A player/Explorer pane holds the file; close it and apply again (nothing was changed). |
| *The folder changed since the preview* | Files were added/removed after the preview; generate a new one. |
| *Undo is not possible right now* | The dialog lists exactly why (e.g. a file was renamed again). |

Logs: *Settings → General → Open log folder* (never contain API keys).
