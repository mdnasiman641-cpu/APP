# Facebook Bulk Reel Assistant

A Chrome (Manifest V3) extension for the **Meta Business Suite bulk Reel upload** page. It writes a description for every uploaded reel with Google Gemini, puts it into the reel's description box, and can set each reel's schedule time.

**It never publishes.** The final **Publish** button is always clicked by you, after you have reviewed everything.

---

## Installation

1. Unzip `Facebook bulk reel assistant <version>.zip` (or use this folder as-is).
2. Open `chrome://extensions` in Chrome (version 116 or newer).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. Pin the extension (puzzle icon → pin) so its popup is one click away.

## AI providers (Gemini, OpenRouter, OpenAI)

Descriptions can come from any of three providers, and each one can hold several models. The extension tries them **in order** and moves to the next one automatically when a model is rate-limited, out of quota or temporarily unavailable — you never have to switch models by hand.

1. Open Settings (extension icon → **Settings**).
2. For each provider you want: tick **Enabled**, paste its **API key**, then add models.
   - **Load models** asks the provider what it offers. Gemini confirms which models support generation, so only those are listed. OpenRouter reports each model's modalities, so only text-capable models are listed. OpenAI's model list does **not** say which models accept chat completions, so those are marked *(unconfirmed)* — if one refuses, it is simply skipped.
   - Or type a model ID and press **+ Add Model**.
3. **Base URL** (optional, under the API key) points a provider at a compatible proxy or self-hosted endpoint, for example `https://api.inmetech.com/api/v1`. Leave it empty to use the provider's own API. A pasted full endpoint (`…/v1/chat/completions`) is trimmed back to the base automatically. Because a custom host is outside the extension's normal reach, Chrome asks for permission the first time you save it — accept it, or that endpoint cannot be called.
4. Order matters: use ↑ ↓ on a provider to change its priority, and on a model to change its position inside that provider. The **Failover order** list at the bottom shows exactly what will be tried, in order.
5. **Save settings**. At least one enabled provider needs a key and one enabled model.
6. **Generate a sample** proves the whole chain works and tells you which provider/model answered.

Keys (free ones: [Google AI Studio](https://aistudio.google.com/apikey), [OpenRouter](https://openrouter.ai/keys), [OpenAI](https://platform.openai.com/api-keys)) are stored only in `chrome.storage.local` on this computer, stay inside the extension's background worker, and are sent only as a request header to that provider. The Facebook tab, the panel and the logs never see them.

### What happens when a model fails

| The provider says | Category | What the extension does |
|---|---|---|
| 429, quota exceeded, RESOURCE_EXHAUSTED, out of credits | `RATE_LIMIT` / `QUOTA_EXCEEDED` | Cools that model down and tries the next one |
| model not found, overloaded, deprecated | `MODEL_UNAVAILABLE` | Tries the next model |
| 500/502/503, timeout, network failure | `SERVER_ERROR` / `NETWORK_ERROR` | Tries the next model |
| invalid or unauthorised key | `AUTH_ERROR` | Skips **that whole provider** (its other models share the key) and tries the next provider |
| the request itself is malformed | `BAD_REQUEST` | Stops and reports it — no other model would accept it either |

- Each provider/model combination is tried **at most once per description**, so a pool of 7 means at most 7 attempts. There is never an endless retry loop.
- A failing model goes into **cooldown** (the provider's own `Retry-After` when it sends one, otherwise about a minute) so later reels skip it instead of hitting the same limit again. Cooldown is temporary — nothing is ever disabled permanently — and it is cleared as soon as you change settings.
- The floating panel shows the model in use: `AI: gemini → models/gemini-2.5-flash`, then `AI: Fallback: openrouter → …` when it switches. The panel's **AI Status** button lists the whole pool and anything currently cooling down. Model and provider names are safe to show; keys are never displayed.
- The browser console (F12) logs every step: `[AI] selected provider=… model=…`, `[AI] failure category=RATE_LIMIT`, `[AI] switching provider=… model=…`, and `[AI][ERROR] all provider/model combinations failed` if everything is exhausted.

### Upgrading from an earlier version

Your existing Gemini key and model are migrated automatically into **Gemini API (Old)** the first time the new version runs, and your parallel-requests setting carries over. Nothing to re-enter.

## Business information and prompt

Settings also hold the business name, location, two phone numbers, the language (Bangla by default) and the prompt. Defaults are *খাদিজা টেলিকম*, *আমরাইদ বাজার, কাপাসিয়া, গাজীপুর*, 01637676742 and 01619872090. **Reset prompt to default** restores the original prompt.

The model only sees the business details and the video **file name**, not the video itself, so give files meaningful names (for example `samsung-a55-unboxing.mp4`) if you want captions that mention the product.

## Using it on Facebook

1. Open Meta Business Suite → **Bulk upload reels** and upload your videos.
2. The **Bulk Reel Assistant** panel appears bottom-right and shows **CONNECTED**. (If it doesn't, click the extension icon → **Show panel on this tab**.)
3. Click **Refresh Detection**. *Detected* should equal the number of uploaded videos.
4. Choose one of the three actions below.
5. Check the **Rows** section for anything marked **Manual Action Required**, review the descriptions and times, then click Facebook's **Publish** / **Schedule** button yourself.

### Per-row buttons (✨ Generate / Test Insert)

Each reel's description box gets two small buttons in its top-right corner:

- **✨ Generate** — writes a description for **that one reel**, with the same automatic failover: it finds the reel again, asks Gemini, inserts the text and reads it back. The button shows *⏳ Generating…*, then *✓ Generated*, or *⚠ Failed* (hover it for the reason). It never schedules and never publishes, and no other reel is touched.
- **Test Insert** — writes the fixed text "Test description" into that box **without calling Gemini**. Use it to tell apart a Gemini problem from a Facebook-editor problem.

The buttons float over the page; the extension never inserts anything into Facebook's own markup. Each step is logged as `[ROW-GENERATE] …` in the browser console (F12) and ends with `ERROR step=…` naming the stage that failed: `reacquire` (reel not found), `gemini` (generation), `insert` or `verify` (Facebook's editor).

### Generate All

Works in two phases, which is what makes it fast:

1. **Generating** — asks the AI for every reel's description, **3 requests at a time** (change this in Settings, 1–5). Each request picks its own model from the failover pool, so one reel hitting a limit never restarts the others. Nothing on the Facebook page is touched during this phase, so network waiting never blocks the page. The panel counts up: *Generating descriptions: 2/6 completed*.
2. **Applying** — inserts the finished descriptions **one reel at a time**: it finds the reel again, types the text into that reel's box and reads it back. *Applying descriptions: 3/6 applied*. A reel only counts once the text was read back from the page.

A single reel's failure is reported and the others carry on. Each reel's row in the panel shows which provider/model wrote its description.

### Apply Schedule

Schedules each reel through Facebook's own controls, one reel at a time: it opens that reel's **Scheduling options** control (never the row's *Publish now* label or button — if the row has no Scheduling options control, that reel stops with a clear error), **switches that popover to the Schedule tab with the real keyboard and confirms it became active** — it focuses the current tab, presses **Tab** (checking after every press which element has focus; the arrow keys for tab lists that Tab skips over) until the **Schedule** tab itself has focus, then presses **Enter** (Space once as a retry). Script clicks on that tab do not reliably switch Facebook's UI and are never used. (Facebook shows the date and time fields on the *Publish now* tab too, so filling them without switching tabs would schedule nothing), sets the date and time, reads both fields back, presses **Update**, and then confirms Facebook really shows that time for the reel — re-opening the popover to check if the row itself doesn't say. Only then does *Scheduled* go up; a click alone never counts, and **Update is never pressed while *Publish now* is the active tab**.

- **Descriptions are not required.** Reels you captioned yourself, or that need no caption, are scheduled normally. Only a reel whose description **was attempted and failed** is skipped, so a half-finished reel is never scheduled.
- Times come from the panel's **Schedule** section: with 18:00 and 60 minutes, reels get 18:00, 19:00, 20:00, … Times past midnight roll onto the next date. Everything is worked out in your own local time (Asia/Dhaka), never UTC, and the whole plan is validated **before** anything is clicked — a time in the past (or under 10 minutes away) is refused.
- If nothing could be scheduled, the panel lists the reason per reel, for example *Row 1: schedule-option: No "Schedule" option in the menu*.
- Every step is logged as `[SCHEDULE] row=1 …` in the browser console (F12): `scheduling control found`, `scheduling control clicked`, `popover visible`, `current tab`, `schedule tab found`, `schedule tab initial selected`, `schedule active`, `date/time fields visible`, `date field found`, `time field found`, `date set`, `time set`, `values verified`, `update clicked`, `scheduled`. Plain progress lines are logged as well: `[SCHEDULE] popover opened`, `navigating to Schedule tab`, `Schedule tab focused`, `Enter pressed`, `schedule mode verified`, `date/time set`, `Update clicked`, `row verified`, `next row`. The next reel is not touched until the current one is verified or has failed. A failure logs `[SCHEDULE] [ERROR] row=1 step=… message=…`, where the step is one of `control`, `popover`, `schedule-tab`, `schedule-tab-focus` ("Schedule tab could not be focused with the keyboard"), `keyboard` (keyboard control unavailable), `schedule-tab-activate` ("Schedule tab could not be activated"), `date-field`, `values`, `update` or `verify`.
- The extension clicks the schedule dialog's own Save/Schedule button, never Facebook's final **Publish**.

**Keyboard control and the "debugging" bar.** Real key presses can only be sent by an extension through Chrome's debugger interface, so the extension has the `debugger` permission and Chrome shows *"Facebook Bulk Reel Assistant started debugging this browser"* while Apply Schedule runs; it disappears when scheduling ends. Leave that bar alone (pressing *Cancel* stops the keyboard control). Only Tab, Enter, Space and the arrow keys are ever sent, only to the Facebook tab, and **Enter/Space are refused by the extension unless keyboard focus is on the Schedule tab it verified** — so a key can never press *Publish now*, *Update* or the final *Publish*. If DevTools or another debugging extension is attached to the tab, the reel stops with `step=keyboard`.

### Generate + Schedule All

Runs the complete **Generate All** work first (generate everything, then apply everything), and only then the **Apply Schedule** phase. The schedule is validated before generation starts and again before scheduling (because time has passed).

### Other buttons

- **Pause / Resume** — Pause takes effect before the next Gemini request or the next reel's Facebook actions; Resume continues from the same reel.
- **Refresh Detection** — re-counts the reels on the page (disabled during a batch).
- **Refresh Models** — reloads the Gemini model list and checks your selected model.
- **Debug Facebook** — shows what the detector found (rows, file names, which controls it recognised) plus the recent log. Useful for troubleshooting and for reporting problems; it contains no page content beyond labels. **Copy debug output** (inside the Debug section) copies it all.
  - *Temporary (1.2.5):* the output starts with a **"Scheduling options" DOM diagnostic**: every visible element the page labels "Scheduling options" (exact text/aria-label, tag, role, aria and other attributes, the element that takes the click, ancestors) and, for each reel row, whether that control is INSIDE the row element the scheduler searches, a SIBLING of it, at PARENT-LEVEL, in a SHARED container of several reels (column layout / header) or in a PORTAL outside the rows. It is read-only and clicks nothing.
- **Settings** — opens the options page.

## What happens when something goes wrong

| Situation | Behaviour |
|---|---|
| A model is busy, out of quota or unavailable | The next provider/model in the pool is used automatically; the failing one cools down. If every one is exhausted, that reel is marked as an error and the batch moves on. |
| A key is invalid | That provider is skipped for the rest of the request and cools down; the next provider is used. |
| The request itself is malformed (400) | Generation stops with the reason — another model would reject it too. |
| Facebook shows *"We're having trouble completing your request."* | Clicking stops, the message is dismissed, the assistant waits for the page to recover and retries that reel once. If it fails again, only that reel is marked **Manual Action Required**. |
| A reel row disappears (Facebook re-render) | Waits up to 5 s for it to come back. If it doesn't, that reel is marked **Manual Action Required**. |
| Facebook briefly shows zero rows | Counters are not reset; the batch keeps its own frozen list of reels. |
| A reel's only control is a direct *Publish* button | The assistant refuses to click it and marks the reel for manual action. |

## Troubleshooting

- **Panel says NOT CONNECTED** — the page isn't recognised as the bulk Reel page. Use the popup's **Show panel on this tab**, then **Refresh Detection**.
- **Detected = 0** — wait until the uploads have finished and each reel shows its description box, then **Refresh Detection**. Click **Debug Facebook**: `descriptionCandidates` tells you how many description boxes were found.
- **"No AI provider is configured"** — open Settings, enable a provider, paste its key, add at least one model, save.
- **"every model is rate-limited or cooling down"** — every configured model has hit a limit. Add another provider or model, or wait; the message says how long until the soonest one frees up.
- **A model keeps being skipped** — click **AI Status** in the panel to see why (cooldown and its category).
- **"The custom Base URL … has not been allowed"** — open Settings, press **Save settings** and accept Chrome's permission prompt for that host.
- **The whole page turns into "We're having trouble completing your request."** — Facebook's composer crashed. The assistant stops the batch immediately and says so. Reload the page and check your uploads. Since 1.0.3 the assistant only gives text to Facebook's editor the way the editor expects (never by editing the page's HTML directly), which was the most likely trigger. If it still happens, test by typing a caption by hand right after uploading: if that also crashes, wait until the upload has fully finished before clicking Generate All. Either way, send the panel's **Debug** output.
- **"Row N (file.mp4) not found after waiting 5 s" / "identity ambiguous"** — the assistant finds each reel again by its **file name** and the description box next to it (Facebook redraws rows constantly, so page elements are never reused). It waits up to 5 s for a redraw before giving up. *Ambiguous* means several reels show the same file name and nothing tells them apart; the assistant then writes nothing rather than risk the wrong reel. Click **Debug Facebook**: `batchRows` shows, for each reel, whether it is found and which description field it would use.
- **Description not verified** — Facebook's editor did not accept the text. The generated text is shown under that reel in the panel's **Rows** list; copy it and paste it manually.
- **Scheduling reports `step=control` or `step=schedule-tab`** — Facebook's layout differs from what the assistant recognises. The error message lists the controls or menu entries it did find. Run **Debug Facebook**, send the output, and schedule those reels by hand meanwhile.
- **`step=verify`** — Facebook accepted the dialog but the reel does not show that time, so it is deliberately **not** counted as scheduled. Check the reel and set it manually.
- **Extension was reloaded** — after updating or reloading the extension, refresh the Facebook tab.
- Keep the Facebook tab **in the foreground** during a batch. Chrome slows down timers in background tabs, which makes batches much slower.

## How it works (short)

```
background/service-worker.js   holds every API key; the only code that talks to a provider
  ai/manager.js                provider/model pool + automatic failover
  ai/classify.js               error categories and the failover decision
  ai/health.js                 per-model / per-provider cooldown (in memory)
  ai/http.js                   fetch + 30 s AbortController + key scrubbing
  ai/prompt.js                 prompt building, response cleaning
  ai/providers/gemini.js       Gemini generateContent + model discovery
  ai/providers/chat.js         shared OpenAI-style chat client
  ai/providers/openrouter.js   OpenRouter + model discovery
  ai/providers/openai.js       OpenAI + model listing
shared/settings.js             settings defaults, migration + storage (service worker, options page)
shared/schedule.js             pure schedule builder/validator (content + options)
content/navigation-hook.js     page-world pushState/replaceState notifier (nothing else)
content/utils/*                logger, error types, DOM helpers + click safety guard, bounded waits
content/state/batchState.js    live detection vs frozen batch; derived counters; pause gate
content/facebook/detector.js   semantic row detection (single pass, ancestor index)
content/facebook/row.js        re-find a batch row from its stable identity
content/facebook/description.js  write + read-back verification
content/facebook/scheduler.js  per-row scheduling through Facebook's own menus
content/facebook/pageErrors.js Facebook error detection/recovery
content/batch/rowGenerate.js   one row: reacquire → AI → insert → verify (shared by both entry points)
content/batch/runner.js        the three actions and their phases
content/ui/panel.js            floating panel (Shadow DOM, outside Facebook's <body>)
content/content.js             page detection, debounced observer, wiring
```

Detection is triggered only by navigation, relevant DOM changes (media or text fields added/removed, debounced 800 ms), a 20-second safety poll, or the Refresh button. During a batch it is paused entirely.

## Development

```
npm run check   # node --check on every file, manifest + file-reference validation, architecture guards
npm test        # unit tests + end-to-end tests (real Chromium, fake bulk-upload page, mocked Gemini)
npm run build   # check + test + dist/Facebook bulk reel assistant <version>.zip (the only artifact)
```

End-to-end tests need Playwright and a Chromium build; they are skipped if Playwright isn't installed.
