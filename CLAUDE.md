# Job Application Tracker — Browser Extension

## What this is

A Chrome extension (Manifest V3) that detects when the user submits a job
application on a supported job site, automatically extracts the relevant
data (title, company, URL, date), and logs it to the user's spreadsheet
(Google Sheets) with no manual data entry.
Goal: eliminate the manual copy-paste-into-spreadsheet step of a job
search, while remaining safe to publish on the Chrome Web Store.

Primary user: a student running a real, active job search with multiple
resume variants across roles (this project is being built for personal
daily use first, Web Store publication second — decisions below optimize
for "works great for one real user" without blocking a future public
release).

---

## Working agreement (read this before writing code)

- **Confirm before code.** Before implementing any phase or any
  non-trivial change, propose the approach and wait for explicit
  go-ahead. Do not silently expand scope mid-phase.
- **Evidence over summary.** Any claim about what was tested or what
  works must come with real pasted evidence — actual command output,
  a real API response, a before/after diff — not a prose summary of
  what supposedly happened.
- **Never chain a commit or push after a test command without gating on
  its exit code.** Write `npm test && git commit … && git push`, or run
  them as separate steps and read the result first. Incident 2026-09-16:
  a merge was committed and pushed in one `;`-chained command whose
  `npm test` had just failed two headless steps; the failure was only
  noticed afterwards, in the output of the same command. (The failure was
  a flake, and the fixed waits behind it were then replaced by polling —
  see Tech stack, Tests — but the push happened blind either way.)
- **No single-case verification for anything safety- or
  correctness-critical.** A parser working on one sample job posting
  is not "the parser works" — test each site parser against several
  real postings on that site, including edge cases (missing fields,
  unusual page layouts), before calling a parser done.
- **Proactively share and re-share.** When a design decision gets
  locked in during a session, update this file and any related spec
  docs immediately, without waiting to be asked.
- **Do not change the architecture below without flagging it
  explicitly first.** The interfaces here (especially
  `SpreadsheetProvider`, the detection tiers, and the permission
  model) were deliberately decided to avoid rework. If a phase
  reveals one of them doesn't work, stop and raise it as a decision,
  don't quietly patch around it.
- **Commit and push only with Ryan's explicit approval.** Repo:
  https://github.com/rynjung1/job-app-tracker. Propose a commit at
  meaningful checkpoints (after each build phase below, or after any
  working, testable increment), show the diff, and commit only once it's
  approved; in practice the approval is relayed by the reviewer
  session. Before committing, check `git status` and `git log -3` and
  stage by explicit path (see the Known risk below). Push after each
  commit so the remote stays current. (Updated 2026-09-11: this used
  to say "commit and push regularly", which contradicted the approval
  rule.)

**Known risk (incident 2026-09-10): multiple Claude Code sessions
share this working directory** (an implementer session and a
separate reviewer session, possibly others), and this file in
particular gets edited by more than one of them in the same sitting.
A real lost-update collision happened on this exact file: a session
wrote back a stale in-memory copy of `CLAUDE.md`, silently reverting
another session's already-committed trims *and* its own just-added
`MS_TOKEN_KEY`/`lib/msTokenLock.ts` paragraph. It was caught (not
prevented) because the git history was checked before trusting the
working tree, and resolved by re-reading fresh from disk/git and
redoing the edit from that copy — nothing was permanently lost only
because it had already been committed once. Before writing this file,
re-read it fresh (don't trust an in-memory copy from earlier in a long
session); after writing it, diff or re-read to confirm the write
landed as expected and nothing concurrent got clobbered.

---

## Architecture

### Three components

1. **Content scripts** — one per supported job site (see "Site
   parsers" below), injected only into matching domains via scoped
   `host_permissions` (never `<all_urls>`). Each script:
   - Detects it's on a job posting page (URL pattern + DOM check).
   - Extracts title / company / location / posting URL at the moment
     of the Apply click, not ahead of time, so it reads the page as
     the user sees it then. (Updated 2026-09-11: this used to say
     "passively, once the page settles, via a `MutationObserver`";
     the code already extracted at click time.)
   - Listens for a click on that site's real "Apply"/"Submit
     application" button (site-specific selector, defined per
     parser) as the logging trigger. LinkedIn: one delegated,
     capture-phase click listener on `document` matched with
     `closest(selector)`, so every copy of the button is caught and
     SPA re-renders need no rebinding. Greenhouse: a
     `MutationObserver` rebinds a listener to its one
     `button[type="submit"]`; delegating that selector could catch
     unrelated submit buttons on the page. Since 2026-09-12 the
     Greenhouse click only records the application as pending; the row
     is written when its confirmation page loads (see Logging
     behavior).
   - Sends extracted data to the background service worker via
     `chrome.runtime.sendMessage` — never writes to the spreadsheet
     directly.

2. **Background service worker** — the only component that holds
   OAuth tokens and makes spreadsheet API calls. Responsibilities:
   - Verifies the sender/origin of every message from a content
     script before acting on it (prevents a malicious page script
     from spoofing a fake "log this" event).
   - Sanitizes and validates incoming field data (see Security).
   - Calls the active `SpreadsheetProvider` to write the row.
   - Manages an offline queue in `chrome.storage.local` — if the API
     call fails (network, expired token), queue the write and retry,
     never silently drop it.
   - Manages OAuth token lifecycle (refresh, expiry) for whichever
     provider is active.

**Verified 2026-09-01 (Phase 3):** offline queue + 401-retry path
confirmed against a real revoked-access failure — `appendRow` failed
with a real "OAuth2 not granted or revoked" error, the row was queued
rather than dropped (`offlineQueue: Array(1)`, not silently lost),
and after reconnecting via the options page's Reconnect button (which
forces a genuinely fresh interactive token rather than potentially
reusing a stale cached one — see Security notes), a
`chrome.alarms`-triggered drain wrote the queued row to the real
sheet and emptied the queue (`offlineQueue: Array(0)`).

**Fixed 2026-09-09 (concurrency):** a real, reproduced bug, not a
theoretical one — `queueRow`, `addRecentApplication`, and
`updateRecentApplication` are each a `chrome.storage.local`
read-modify-write with no locking, and two concurrent calls (e.g.
two applications logged in quick succession) silently lost one
entirely: a real repro script simulating two concurrent `queueRow`
calls against a realistically-timed async mock produced
`offlineQueue: [{"Company":"Company B"}]` where 2 entries were
expected. Confirmed first that `chrome.storage` has no compare-and-
swap or transaction primitive at all (checked the real API
reference — `get`/`set`/`remove`/`clear`/`getBytesInUse`/`getKeys`/
`setAccessLevel`, nothing conditional) before reaching for an
in-memory fix. Fixed with a minimal promise-chaining mutex
(`lib/storageLock.ts`, `withStorageLock`), safe across service
worker suspension — a killed worker's in-memory chain dies with any
operation that was genuinely in flight anyway, and a fresh worker
starts with a clean, already-resolved chain, so there's nothing
left to conflict with.

**Design choice, not a default:** one shared lock across both
`OFFLINE_QUEUE_KEY` and `RECENT_APPLICATIONS_KEY`, not a lock per
key. These operations are rare (a user applying to jobs, not a
high-throughput system) and fast (a few ms of storage I/O), so the
contention cost of serializing two unrelated keys together is
negligible against the simplicity of one lock instead of two.

A second, distinct real bug found in the same pass:
`drainOfflineQueue` read the queue once, spent real time on network
round-trips per row, then overwrote storage with a slice of that
*stale* snapshot — silently discarding any row a real concurrent
`queueRow` call added while the drain was mid-flight (drains run
every 5 minutes and can take real time; a normal apply landing
during that window is an everyday occurrence, not an edge case).
Fixed by moving the lock to *only* the closing step — re-reading
the current queue and writing `current.slice(drainedCount)` inside
`withStorageLock`, after all the network calls have already
happened, so an ordinary apply never has to wait behind a slow
drain. This is correct by construction, not a heuristic:
`queueRow` only ever appends to the end and `drainOfflineQueue`
only ever processes from the start in original order, so nothing
queued mid-drain can land anywhere but after the entries already
being drained — dropping exactly the first `drainedCount` items
from whatever the queue looks like *right now* is always correct.

**Verified 2026-09-09:** both fixes confirmed with real before/after
output from faithful copies of the actual shipped logic (not
re-derivations) — the original two-concurrent-`queueRow` repro now
preserves both entries, and a second repro (a slow mock `appendRow`
standing in for a real network round-trip, with a real `queueRow`
call landing mid-drain) confirms the newly-queued row survives the
drain's final write. One real mock-fidelity bug was caught and
fixed during this verification, not silently papered over: the
first attempt at the second repro produced a false failure because
the mock's `get()` returned a live reference to the stored array
rather than a copy, letting `queueRow`'s `push()` mutate the same
array `drainOfflineQueue`'s loop was still iterating — not how real
`chrome.storage.local` behaves (it always round-trips through real
serialization). Fixed the mock to deep-clone on `get`/`set` before
trusting the result.

**Fixed 2026-09-10 (re-entrancy + fetch timeout):** a third, distinct
real bug in the same area, found by a separate reviewer pass, not
self-discovered — `drainOfflineQueue` had no guard against a second
invocation starting while a first was still mid-flight.
`RETRY_ALARM_NAME` fires every 5 minutes with nothing serializing
`chrome.alarms.onAlarm` invocations, and (before this fix) no
`fetch()` call in any provider had a timeout, so one genuinely
stalled request (dead proxy, hung connection accepted but never
answered) could keep a drain mid-loop past the next alarm. A second
invocation starting then reads the *same* un-drained queue — per-row
success is never flushed to storage incrementally, only the whole
loop's closing write is — and re-appends whatever the first
invocation already wrote. Reproduced for real, not asserted: a mock
`appendRow` that succeeds on row 1 then hangs forever on row 2,
overlapped with a second drain starting mid-hang, produced row 1
appended twice before the fix and exactly once after. Fixed with a
module-scope `isDraining` boolean (checked and set at the top of
`drainOfflineQueue`, reset in a `finally`) — safe as a plain in-memory
flag specifically because this function only ever runs inside the
background worker's own realm; no popup/options caller exists for it.

Paired with a real fetch timeout, added because it didn't exist at
all — confirmed via grep of every provider file before writing
`lib/fetchWithTimeout.ts`. 20 seconds: comfortably above any real
API call this project has actually observed, and below the tightest
limit on the worker. This shrinks the
window the `isDraining` guard needs to cover, it doesn't replace it —
a stalled request now fails within 20s instead of indefinitely, but
the guard is still what actually prevents the double-append during
that window.

**Corrected 2026-09-14 (30s to 20s):** the timeout was 30 seconds,
chosen against only `RETRY_ALARM_NAME`'s 5-minute period and Chrome's
5-minute single-request limit. Chrome's service-worker lifecycle doc
lists a third limit: the worker is terminated "When a fetch() response
takes more than 30 seconds to arrive". At 30s our own abort raced that
kill, and if the kill won, `handleJobApplicationLogged`'s catch never
ran its `queueRow`, so the application was lost. At 20s the abort fires
first, leaving 10s for the catch. The same single deadline still covers
the body read. **Verified 2026-09-14 in Node only**
(`tests/fetchWithTimeout.test.ts`, the real file against Node's fetch
and a local HTTP server, with the deadline timer fired by the test):
the deadline is 20000 ms; no headers rejects with `AbortError`; headers
followed by a stalled body leaves the timer running after headers, and
the body read rejects with `AbortError` when it fires; a normal
response clears the timer once its body is read.

**Fixed 2026-09-14 (retry alarm on every start):** `RETRY_ALARM_NAME`
was created only in `onInstalled`. The alarms doc says persistence
across restarts is unpredictable before Chrome 150 ("it is best to make
sure important alarms exists each time your service worker starts up"),
and `minimum_chrome_version` is 110. Without the alarm, queued rows
would wait for the next Connect or Reconnect. Now `ensureRetryAlarm`
(`background/offlineQueue.ts`) runs at the worker's top level, so on
every start: `alarms.get`, then `create` only if it's missing, so a
wake-up never pushes back the next run. **Verified 2026-09-14 in Node
only** (`tests/background.test.ts`): importing the worker with no
`onInstalled` creates it (`periodInMinutes: 5`); with the alarm already
there, nothing is created.

Two more real, reviewer-caught bugs surfaced building
`fetchWithTimeout.ts` itself, both instructive enough to record here
rather than fold silently into the fix above:
- **Timer cleared before the body, not after.** The first version
  cleared the timeout in a `finally` immediately after `await
  fetch(...)` — which resolves once response *headers* arrive, before
  any caller's separate `await res.text()`/`res.json()` call ever
  runs. A server sending headers immediately and then stalling the
  body cleared the timer before the stall even started, leaving it
  exactly as unbounded as no timeout at all. Confirmed for real
  against Node's actual fetch/undici and a real local HTTP server
  that sends headers then never calls `res.end()`: the naive
  version's `res.text()` was still unresolved 6x past its timeout.
  Fixed by wrapping the returned `Response` in a `Proxy` that
  intercepts exactly `text()`/`json()` (the only two body-reading
  methods any caller here uses) and only clears the timer once one of
  those settles, so the same single deadline covers the full request
  lifecycle, connection through body.
- **The Proxy passthrough branch broke every non-body property in
  real Chrome.** `Reflect.get(target, prop, receiver)` runs a
  property's getter with `this = receiver` — the Proxy itself.
  `Response.ok`/`.status`/`.headers` are WebIDL-branded accessors
  that check `this` is a genuine `Response` with real internal slots
  and throw `Illegal invocation` otherwise. Since every provider's
  `apiFetch` checks `res.ok` on the very first line after every
  call, this would have broken every spreadsheet write in production
  — worse than the bug the fix existed to close. Missed by three initial verification passes because all
  three ran under Node (a local Node HTTP server, Node's own fetch,
  this file bundled and run under Node) — Node's fetch (undici) is
  receiver-agnostic and never enforces the brand check that real
  Chrome does, so nothing Node-based could have caught it. Caught by
  a reviewer testing the exact shipped code in a real Chrome tab.
  Fixed by reading off `target` instead of `receiver`
  (`Reflect.get(target, prop, target)`); re-verified in a real Chrome
  tab afterward, reproducing both the original failure (`Illegal
  invocation` on `ok`/`status`/`headers`) and the fix (all four of
  `ok`/`status`/`headers`/`json()` clean) against the same real
  `fetch()` response. **Lesson applied going forward: anything
  touching `Response`/`Headers`/`Proxy` or other WebIDL-branded
  platform objects gets verified in a real Chrome tab, not just
  Node** — Node's fetch implementation is close enough to pass
  Node-only tests while still shipping a real production break.

**Excel-era history (removed 2026-09-13):** the same investigation
found that the Excel provider's `MS_TOKEN_KEY` refresh could race
across JS realms. That led to centralizing every provider call in the
background worker (see Trust boundary) and a dedicated
`lib/msTokenLock.ts`; both the Excel token and that lock left with
Excel support. The lesson that still applies: one realm can still race
between two async message handlers, so a read-decide-write on shared
state needs a lock around the decision, not just the write (the
pattern `lib/pendingApplications.ts` follows).

3. **Popup + Settings**
   - Popup: the scrollable list of recent applications, with Edit/Undo
     and a status chip per entry, plus Open-sheet and Settings buttons.
     (The original toast-style confirmation is a system notification;
     see Logging behavior, Phase 4 note.)
   - Settings (the options page): authenticate and auto-create a sheet
     (the only supported setup path — see "Sheet setup" below), and
     Reconnect.

**Updated 2026-09-13 (phase B, decided by Ryan): Settings opens as a
small popup window, not a tab.** `background/settingsWindow.ts` opens
it: the popup's gear and its not-connected button send the new
`OPEN_SETTINGS` internal message, and the first-install `onInstalled`
and the "Not connected" notification's button call it directly (the
auto-open and "Open Settings" buttons in the 2026-09-10 note below
now open this window). One window at a time: its id is kept in
`chrome.storage.session` (`SETTINGS_WINDOW_KEY`), opening it again
focuses it, `windows.onRemoved` clears the id, and concurrent opens
share one in-flight call. `options_page` stays in the manifest as the
fallback: chrome://extensions' "Extension options", and whenever the
window can't be created. The popup and Settings were restyled from the
approved mockups with shared `src/ui/tokens.css` (colours, buttons,
focus ring, status chips) and inline SVG icons, no new dependencies:
labelled controls, visible focus, `role="alert"` errors, `aria-busy`
while loading or saving, and every text colour at 4.6:1 or better. The
popup keeps a location on one line ("Seattle, WA" no longer splits
across lines). Fixed in passing: after a failed Reconnect, the error's
"Try again" ran Connect, which creates a new sheet and replaces the
connected one; it now retries Reconnect. The notification's Edit
window grew from 320 to 480px tall for the restyled edit panel.

**Verified 2026-09-13** by Ryan on the reloaded build:
- **Live statuses, shipped code**, checked via the script's JSON output:
  an esbuild bundle of the real `googleSheets.ts` and `liveStatuses.ts`
  run in the extension's service worker, on a throwaway sheet built by
  the real `createSheet` with rows from the real `appendRow` and
  `updateCell`. `readCells` made the headers read, then exactly one
  `values:batchGet` (`B2:B40`, `C2:C40`, `G2:G40`). The entry pointing
  at row 40 (past the data), the row whose Company was renamed by hand,
  and the row with an emptied Status were all skipped; the result,
  `{e5: Cancelled, e2: Interview}`, matched the expected one exactly.
- **Settings window**: the gear opened one window, and a second click
  focused it rather than opening another. Open sheet and Reconnect
  worked from it.
- **Live chip on the real sheet**: the first try missed. A Status Ryan
  changed by hand showed in the popup only after he clicked Reconnect.
  The re-test, with a fresh sign-in, showed a hand-changed Status on a
  normal popup open with no Reconnect. That points at a lapsed Google
  sign-in, not the chip code: `withAuth` doesn't catch a failing
  non-interactive `getAuthToken`, so the read failed and the popup
  quietly kept the saved status. The same state silently stops logging;
  the "needs reconnect" work is the follow-up.

Not yet checked live: the restyled notification Edit window (and a
blank band the headless render showed after the input scrolled into
view), left for Ryan's next real application; the first-install
auto-open and the "Not connected" notification's Open Settings, left for
the extension-ID switch (a reinstall wipes storage).

**Updated 2026-09-14 (decided by Ryan): popup and Settings polish**, from
the approved mockups (direction A):
- **Rows:** 368px wide, every row 79px (nothing wraps). The company links
  to the job posting, only for `https:`/`http:` URLs (`lib/safeUrl.ts`:
  the URL comes from the page and the sanitizer only caps length). The
  title takes the ellipsis and the location stays whole. One Open sheet,
  in the header.
- **Status chip:** a dropdown of the five statuses. `STATUS_VALUES` is now
  one list in `lib/sheetTemplate.ts`, shared with the sheet's dropdown
  and colour rules (the new sheet's dropdown now lists them in workflow
  order). Picking one sends `SET_STATUS`, below.
- **The row's ⋯ menu:** Change resume version and Open job posting. The
  popup's Undo button is gone: Cancelled is set from the status dropdown,
  one place for status. The notification keeps Undo and Edit, its short
  correction window.
- **Keyboard:** the menu and the dropdown follow the ARIA menu-button and
  listbox patterns (`popup/Dropdown.tsx`): arrows, Home/End, Enter/Space,
  and Esc returns focus to the button. They're positioned fixed, above
  the button when there's no room below, or growing the popup when
  neither fits. Fixed after review, 2026-09-14: they close on any scroll
  (the list's or the window's, caught in the capture phase) or resize,
  since a fixed menu would otherwise float over a different row after a
  scroll; focus returns to the button only if it was in the menu, and
  without scrolling the list back. No control is `disabled` while it may
  have focus (the chip while its save runs, the editor's input and
  buttons while saving): Chrome drops focus from a focused control that
  becomes disabled, so they use `aria-disabled` or read-only instead.
- **One resume editor** (`popup/ResumeVersionEditor.tsx`): the popup's
  editor view (focus returns to the row's ⋯ afterwards) and the whole
  notification Edit window, now a focused 380×404 dialog instead of the
  list. Sized from the rendered page: 308px of content, 367px with the
  longest error, plus about 28px of macOS title bar and a 9px margin. The
  phase B "blank band" note above no longer applies.
- **Settings:** when healthy, Reconnect is a quiet "Having trouble?
  Reconnect" link; it stays the primary button when sign-in is needed.
- **`SET_STATUS`** (a flagged addition to the internal messages) checks
  Company/Title like `SAVE_RESUME_VERSION`, then writes the Status cell
  and the cached entry through `setApplicationStatus`
  (`lib/recentApplications.ts`), which the notification's Undo also uses
  (`cancelApplication` calls it). A mismatch or a failure writes nothing
  and shows an inline error on the row. While signed out the chip and the
  resume action are disabled, and a sign-in failure returns the new
  `AUTH_REQUIRED` code. Status changes are never queued. It replaces
  `CANCEL_APPLICATION`, whose only sender was the popup's Undo.

**Verified 2026-09-14 in Node and headless renders only:**
- Node test, 27 of 27: the 18 earlier cases, plus `SET_STATUS` writing
  exactly "Interview" to `Sheet1!G5` and updating the cache; a
  hand-edited Company returning `STALE_ROW` with no write; an unknown or
  non-string status refused before any request, and an unknown entry
  refused; signed out returning `AUTH_REQUIRED` with the flag set and no
  write; a failing Status write returning an error with the cache
  unchanged; `CANCEL_APPLICATION` no longer handled; a resume save while
  signed out returning `AUTH_REQUIRED`; the notification's Undo writing
  "Cancelled" to `G5` through the shared setter; and `safeJobUrl` keeping
  https/http while refusing `javascript:`, `data:`, empty and junk.
- A scripted keyboard test on the built popup with stand-in data, 14 of
  14: the menu opens on its first item, arrows move and wrap, Home/End
  jump, Esc closes it with focus back on ⋯; the status list opens on the
  current status, Enter picks one and returns focus to the chip, Esc
  changes nothing; the editor opens with focus in its input, and Esc
  returns to the list with focus on that row's ⋯. Added with the review
  fix: scrolling the list with the ⋯ menu or the status list open closes
  it, with focus back on its button and the list still scrolled (80px).
  Those two steps set `scrollTop` and then dispatch the scroll event
  themselves: headless `--dump-dom` renders no frames and delivered 0
  native scroll events. The same test caught the disabled-while-focused
  chip (focus fell to the page after a status change).
- The Edit window at its 376px inner height, with and without the error:
  scrollHeight 376 of 376, no scrolling.

Not run live; web-store-deploy step 6 has the checks for the new-ID
build. Not checkable headless: whether Esc inside Chrome's real toolbar
popup also closes the popup itself.

**Updated 2026-09-15 (decided by Ryan): dark mode, waiting applications,
notes and a summary line** (branch `ui-polish`, from the approved mockups):
- **Dark mode:** every colour is a token in `src/ui/tokens.css`, light on
  `:root` and dark under `prefers-color-scheme: dark`, and `popup.css` and
  `options.css` use only tokens, so the popup, the Edit window, both editors
  and Settings follow the system theme. The blue primary buttons (white on
  `#2563EB`) are the same in both. Input and row borders stay below 3:1 in
  both themes, as before.
- **Waiting applications:** the popup lists queued applications (offline,
  signed out, the sheet in the trash or deleted, or no sheet yet) at their
  dates among the saved ones, with a dashed "Waiting" chip, no status menu
  and no ⋯, since they have no row yet; the banner still says why. The
  saved list keeps its cap of 20, and every waiting application is shown
  on top of it. Recent entries now keep their row's Log ID (`logId`, from a
  direct log and from the drain), and a waiting application whose Log ID
  already has an entry is left out, since the drain writes the list and the
  queue in two storage writes (`lib/popupList.ts`). With no sheet
  connected, they're listed under the Connect prompt.
- **Add note** in the row's ⋯ menu (`GET_NOTE` and `SAVE_NOTE`, flagged
  additions to the internal messages): the editor opens with the row's
  Notes cell, read with the same Company/Title check as `SET_STATUS`, and
  saves the edited text as an edit of that cell, never an append, only if
  the cell still holds what it opened with. Otherwise it's `NOTE_CHANGED`,
  "This note changed in your sheet; reopen to see it.", and nothing is
  written. Refused while the sheet is flagged (`SHEET_UNAVAILABLE`),
  `AUTH_REQUIRED` when signed out, never queued, at most 1000 characters,
  written RAW. The popup's error texts moved to `popup/messages.ts`. On the
  `workday` branch the popup's identity check uses the Log ID
  (`rowStillMatches`); the note messages follow it at that merge.
- **Summary line** under the header, "N this week · M interviews". This
  week is the current calendar week, Monday 00:00 to the end of Sunday, in
  local time. It counts saved and waiting applications dated in it, except
  those shown as Cancelled (the live status when read, else the cached
  one); interviews are saved entries shown as Interview, whatever their
  date. Counted from the list and the live statuses, with no extra reads;
  "20+" when all 20 saved entries are from this week.

**Verified 2026-09-15 in Node and headless Chrome only** (`npm test` 185
of 185 on `ui-polish`, `npm run test:node` 145 of 145):
- `tests/tokens.test.ts`: 39 text/background, focus-ring and border pairs
  in both themes (text 4.5:1, focus rings and the Waiting chip's border
  3:1; the lowest text pair is 4.63:1 light and 5.17:1 dark); both themes
  define the same tokens; no colour literal left in `popup.css`,
  `options.css` or the rules of `tokens.css`, and every token used exists.
- `tests/popupList.test.ts`: every moment from Monday 00:00 to Sunday
  23:59:59 maps to that Monday, and a minute earlier to the week before;
  the count takes this week's saved and waiting applications and leaves out
  Cancelled ones by the shown status; "20+" only when all 20 are this week;
  waiting rows sort among the saved ones, one whose Log ID has an entry is
  left out, and 20 saved plus 3 waiting show 23.
- `tests/background.test.ts`: `GET_NOTE` returns the Notes cell;
  `SAVE_NOTE` writes the whole note RAW to `'Sheet1'!H5` (a note starting
  with `=` included) when the cell is unchanged, returns `NOTE_CHANGED`
  with no write when it changed, `STALE_ROW` after a hand-edited Company,
  `SHEET_UNAVAILABLE` before any request when trashed, and `AUTH_REQUIRED`
  signed out; a non-string or 1001-character note, or no `expected`, is
  refused before any request; a direct log and a drained row both get the
  row's Log ID.
- `tests/dom/popup.test.mjs`: the page background and an Applied chip in
  each theme; offline with 2 queued, 2 Waiting rows with no status menu or
  ⋯, in date order among the saved rows; the summary line; ⋯ > Add note
  prefilled from `GET_NOTE`; `NOTE_CHANGED` shown inline with the editor
  open; a save closing it; Settings at a real 440px viewport (a 440px
  iframe, since headless windows can't be narrower than 500px) with no
  horizontal scroll, healthy, signed out and trashed, in both themes; the
  keyboard steps with the three-item menu.
Not run live; web-store-deploy step 6 has the checks.

**Fixed 2026-09-10 (fresh-install UX, found during a test pass):**
a genuinely fresh install had several real, silent gaps — no
onboarding, a popup that just said "No recent applications yet"
with no indication a sheet needed connecting, no statement anywhere
in the product of which sites/flows are supported, and the
"connect a sheet first" guidance reaching only `console.warn` in
the background worker, where no real user would ever see it. Four
narrowly-scoped fixes, not an onboarding redesign:
- **Auto-open the options page on a genuine first install.**
  `chrome.runtime.onInstalled` also fires on `'update'` and
  `'chrome_update'`, not just a real install — checked Chrome's own
  documented behavior before gating on it, not assumed. Gated
  strictly on `details.reason === 'install'` so this never re-opens
  after a routine extension auto-update, a real, known pitfall of
  this API otherwise.
- **Popup's empty state** now distinguishes "still loading" from
  "confirmed not connected" (a new `sheetRefChecked` flag, since
  `sheetRef` itself is `undefined` in both cases) and shows *"Connect
  a spreadsheet to start tracking applications automatically"* with
  a real "Open Settings" button (`chrome.runtime.openOptionsPage()`)
  instead of the plain empty-list message, whenever nothing is
  connected yet.
- **Supported-sites disclosure** — one static line on the options
  page, shown regardless of connection state: *"Currently supports:
  LinkedIn (Easy Apply) and Greenhouse-hosted job postings."*
  Deliberately not itemizing every documented scope boundary
  (off-site LinkedIn redirects, custom-domain Greenhouse boards) —
  that level of detail stays in this file for developers; the
  product's own UI only needs enough to stop a user wondering why
  nothing happened on an unsupported site.
- **A real notification for "applied while disconnected,"** not
  just the pre-existing `console.warn` (kept alongside it, still
  useful for debugging) — reuses the exact `chrome.notifications`
  pattern already built for the "Logged" toast, with one "Open
  Settings" button. Two deliberate differences from that toast: no
  auto-clear alarm (this is a heads-up the user still needs to act
  on, not a self-expiring correction window), and a **fixed**
  notification id (`'not-connected'`), not a fresh id per call.
  Checked Chrome's own documented `notifications.create` behavior
  before deciding this, not assumed: reusing an existing id "first
  clears that notification before proceeding with the create
  operation" — a fixed id means a second disconnected application in
  quick succession replaces this notification in place rather than
  stacking a duplicate, confirmed real evidence of a real risk
  (rapid-fire applications were already the exact scenario the
  offline-queue concurrency bugs came from), not a hypothetical.

**Verified 2026-09-10** by actually removing and reinstalling the
unpacked extension (a plain reload doesn't reliably fire
`reason: 'install'` or reset storage the way a real reinstall
does): the options page auto-opened on its own, the supported-sites
line rendered, the popup's disconnected empty state showed the
connect prompt with a working "Open Settings" button, and a real
queued-while-disconnected application produced the real notification
with the correct title, message, and a working "Open Settings"
button.

### Logging behavior (locked decision)

Fully automatic. The moment the site's Apply button is clicked, the
row is written immediately — no confirmation dialog blocking the
user's flow. The 5-second popup toast is purely a correction window
(Undo / Edit resume version), not a gate. Resume version defaults to
whichever version was last used for that role type (SWE vs DE),
inferred from job title keywords, and is editable from the toast.

**Updated 2026-09-12 (decided by Ryan): Greenhouse logs on a confirmed
submission, not at the click.** Its Submit click can fail Greenhouse's
own JavaScript validation ("First Name is required.") and stay on the
form, and fixing the fields and resubmitting used to log a second row
(the duplicate Arclight row of 2026-09-11). Now the click records the
job as pending (`lib/pendingApplications.ts`, `chrome.storage.session`,
keyed by `{board}/{jobId}` from the URL and scoped by origin), and the
row is written when Greenhouse's `/confirmation` page loads for the same
application within 30 minutes. It's still fully automatic with no
dialog; the row just lands about a second later. See Site parsers,
Greenhouse, for the evidence.

**LinkedIn reviewed 2026-09-12 and kept at the Easy Apply click.** An
abandoned application leaves a row, but that row is visible and one
Undo marks it Cancelled. Logging on the final Submit inside LinkedIn's
multi-step modal would need a second selector on English labels in
markup LinkedIn changes often (a label change already broke detection
silently once), could only be tested with real applications, and a
missed final Submit would be an invisible lost row, which is worse than
an extra visible one.

**Updated 2026-09-14 (the reviewer's audit; Ryan hasn't vetoed it, and
the reviewer relays it if he does): a reopened Easy Apply isn't logged
twice.** Closing the Easy Apply dialog and opening it again for the
same job logged a second row. `handleJobApplicationLogged`
(`background/index.ts`) now skips a payload whose URL matches a
recent-list entry from the last 24 hours whose status isn't
`Cancelled`, with a console line. After an Undo (Cancelled) the job
can be logged again. It runs for every logged payload, so a second
Greenhouse confirmation of the same posting within 24 hours is skipped
too. Known gap: it checks the recent list only, which holds rows
already saved, so two clicks on one job while offline or signed out
still queue two rows (with different Log IDs). **Verified 2026-09-14 in
Node only** (`tests/background.test.ts`): the same job twice gave 1
append, 1 row and 1 "Logged" notification with nothing queued; a
different job still logged; after the entry was set to Cancelled the
job logged again; an entry 25 hours old didn't block it. Not yet verified
live: in the 2026-09-14 session the browser tool's later clicks never
reached the page (a tool issue, not the extension's); Ryan is checking it
by hand.

**Updated 2026-09-01 (Phase 4):** the "toast" is a real
`chrome.notifications` system notification, not the extension's
toolbar popup rendering something proactively — a popup can't open
itself without a user gesture, so nothing could ever surface a timely
"correction window" if it only lived inside the popup (the user isn't
clicking the toolbar icon at the moment they click Apply on a job
site). This is a deliberate, flagged deviation from the literal
"Popup: shows a toast-style confirmation" architecture text above —
the popup's own job is now just the scrollable recent-applications
list plus the Edit UI (opened as a standalone window from the
notification's Edit button), not the proactive alert itself. Known
platform limits: needs the `notifications` permission; on macOS, the
notification is routed through native Notification Center, so exact
5-second timing isn't fully controllable by the extension — Chrome
force-clears it around then, but the OS ultimately owns the banner's
on-screen duration.

**Corrected 2026-09-14:** "Chrome force-clears it around then" held
only for the unpacked build. The clear was a `chrome.alarms` alarm of
5/60 minutes, and the alarms doc says a `delayInMinutes` under 0.5
"will not be honored and will cause a warning"; only an unpacked
extension has no limit. So in the store build the "Logged" notification
would have stayed up to 30 seconds or more. Now a `setTimeout` clears it
after 5 seconds while the worker is alive, which it normally is (the
apply's own work has just run), and cancels the alarm; a 0.5-minute
alarm stays as the fallback for a worker stopped first. **Verified
2026-09-14 in Node only** (`tests/background.test.ts`): a logged apply
creates the 0.5-minute alarm and a 5000 ms timer, and doesn't clear the
notification before the timer runs; the timer clears it and cancels the
alarm; the alarm on its own clears it too. Not checked live yet
(web-store-deploy step 6).

Undo marks the row `Status: Cancelled` rather than deleting it —
safer against the row having shifted if the user has since
sorted/edited the sheet by hand; a wrong cell getting mislabeled is
recoverable, a wrong row getting deleted is not. `Cancelled` is a
fifth `Status` value alongside the four in the Status field section
below.

**Verified 2026-09-01 (Phase 4):** all of the above confirmed against
real applications, not just a clean build — real screenshot of the
`chrome.notifications` toast appearing after a real Apply click
(the "Logged" title with a real application's company and job title,
Undo/Edit buttons present); Undo confirmed setting
`Status: Cancelled` in the real sheet; Edit confirmed opening the
standalone popup window, saving a new Resume Version to the real
sheet cell, and closing itself; the last-used-per-role-type default
confirmed by a subsequent same-role-type application prefilling with
the version just saved via Edit, not just accepting the write in
isolation.

**Updated 2026-09-09:** Edit and Undo are no longer only reachable
from the notification's ~5-second window — both are now available
on every entry in the popup's own recent-applications list
(up to the stored 20), at any time the popup is opened. No time or
state limit beyond that 20-entry cap: neither action is destructive
(Undo is a status change, Edit overwrites one cell), and Status is
already documented above as something the user can set "directly in
the spreadsheet or via the extension UI" — this is that same
capability from a second entry point, not a new one. Undo hides
itself once an entry's cached status is already `Cancelled`, since
there's nothing left to undo.

Because this makes the underlying blind-positional-write real risk
(a stale `rowNumber` pointing at a row the user has since
reordered/renamed by hand) reachable far later than the original
short window ever allowed, both popup actions now verify the target
row's `Company`/`Title` still match the cached entry (via the new
`readRow`, above) before writing — on mismatch, the write is
refused and an inline error tells the user they can still make the
same change directly in their spreadsheet, rather than leaving them
at a dead end. The notification's own Undo (background worker,
short window) deliberately keeps its original no-check behavior
unchanged — the risk this addresses is specific to the "reachable
indefinitely" popup path, not the immediate one.

Editing a different row than the one a standalone Edit window
opened for (the window still renders the full list underneath the
edit box) also gets the real check and does not auto-close the
window on save — only saving the exact entry the window was opened
for skips the check and closes, preserving the original notification
-Edit behavior exactly for that one case.

`cancelApplication()` (`lib/recentApplications.ts`) is shared between
the notification's background-worker handler and the popup's new
Undo button — one implementation of "mark Cancelled," not two
copies that could drift.

**Verified 2026-09-09:** both the legitimate and the deliberate-
mismatch case confirmed with real evidence, not just a working
build. Legitimate case: Undo and Edit from the popup list both
correctly updated the real spreadsheet cell. Mismatch case: a real
row's `Company` cell was hand-edited directly in the spreadsheet,
then Undo/Edit was retried on the now-stale cached entry — the
inline error appeared, and a real re-read of that cell afterward (not
just trusting the UI) confirmed zero write occurred.

**Updated 2026-09-13 (decided by Ryan): live status chips.** The popup
shows each entry's status from the sheet, so a status the user changed
there (Interview, Offer...) shows up in the popup too. It renders the
cached list first, then sends `GET_LIVE_STATUSES`: the background
worker reads Company, Title and Status for the stored rows in one
`values:batchGet` (the provider's `readCells`, below) and returns a
status only for rows whose Company and Title still match the cached
entry, the same identity rule Edit and Undo check
(`lib/liveStatuses.ts`). A mismatched row, an empty Status cell or a
failed read (offline, signed out) keeps the cached status. Read-only:
nothing is written to the sheet, and the cached list isn't updated from
it. (Until 2026-09-14 the popup's Undo hid itself when the displayed
status was `Cancelled`; the popup now sets status through its status
dropdown, see the popup polish note.)

**Updated 2026-09-13 (decided by Ryan): "needs reconnect".** A lapsed or
revoked Google sign-in used to be silent: `appendRow` failed, the row
was queued, every 5-minute drain failed again, and nothing in the UI
said so (found when the popup's live chip only updated after a
Reconnect). The likely cause of that lapse: the OAuth consent screen was
in Testing, where Google issues refresh tokens that expire after 7 days
(external user type, and `drive.file` isn't one of the exempt
name/email/profile scopes); it goes to In production in web-store-deploy
step 5. Now:
- **Detection** (`googleSheets.ts`, `withAuth`): a failing
  non-interactive `getAuthToken` while `navigator.onLine`, or a 401
  that survives the one retry, throws `AuthRequiredError` (Spreadsheet
  backend, below). Offline, a failing `getAuthToken` stays an ordinary,
  retried failure.
  Known limitation: `navigator.onLine` is still true on a network with
  no internet (a captive portal), so a `getAuthToken` failing there
  shows a false "sign-in needed". The next successful call clears it;
  no code change.
- **The flag** (`lib/authStatus.ts`, `authStatus` in
  `chrome.storage.local`, with the original error text as `reason`):
  set by `getActiveProvider()`'s wrapper when any provider call throws
  `AuthRequiredError`, cleared by any call that succeeds, so every
  caller is covered. Setting and clearing run under `withStorageLock`
  (no provider call runs inside that lock anywhere, checked), so
  concurrent failures notify once.
- **Notification**: fixed id `needs-reconnect`, with a Reconnect
  button. Shown when the flag is first set, whatever call hit it, and
  again for each application queued while it's set; later drains never
  show it. The first application after sign-in lapses shows it twice in
  a row (the first failure, then the apply with the count), the second
  replacing the first in place.
  A popup open can also be the first failure: its `GET_LIVE_STATUSES`
  read sets the flag, so the notification appears alongside the popup's
  banner. Expected.
- **Badge**: a "!" on the toolbar icon (`#B45309`, 5.02:1) and an
  action title saying sign-in is needed, re-applied on browser startup.
- **Popup**: an amber "Google sign-in needed" banner with the queued
  count and Reconnect; when the queue isn't empty without the flag, a
  neutral "waiting to be saved" banner. The list keeps the saved
  statuses, since the live read needs sign-in too.
- **Settings**: the connected card turns amber with Reconnect. Reconnect
  from the popup banner or the notification opens the Settings window at
  `?reconnect=1` (`OPEN_SETTINGS` with `reconnect: true`; an open window
  is reloaded there), which starts Google's sign-in on load, since the
  popup closes as soon as Google's window opens. `RECONNECT_PROVIDER`
  then drains the queue immediately (`background/offlineQueue.ts`, the
  drain moved out of `index.ts` unchanged, returning the rows saved) and
  Settings shows "Saved N waiting applications to your sheet."
  inline, with no notification for it.

**Verified 2026-09-13 in Node only:** the real `withAuth`,
`activeProvider` wrapper, `authStatus`, offline queue, message router and
background listeners against mocked `chrome`/`fetch`/`navigator`, 12 of
12: a rejected `getAuthToken` while online sets the flag, the badge and
one notification; a 401 that survives the retry sets it; a 401 then
success, a 500, a timeout and a `getAuthToken` failure while offline
don't; 5 concurrent failures notify once; a success clears the flag,
badge and notification; 3 failing drains notify once and keep the
queue; 2 applications while signed out queue 2 and notify with the
count, and a later drain adds none; `RECONNECT_PROVIDER` saves both
(`{saved: 2, waiting: 0}`) and clears everything; `OPEN_SETTINGS` with
`reconnect: true` opens `?reconnect=1`. Not run live: a cleared cached
token, a real revoke, and offline. Real Chrome's error text and
behaviour are unverified until the extension-ID switch, where the
re-verify step covers them.

**Updated 2026-09-13 (decided by Ryan): saved queue rows reach the
popup, Connect saves the queue, and a failed notification Undo shows.**
- A row the offline-queue drain saves now gets a recent-list entry,
  built from the queued row and the append's row number, with no
  "Logged" toast. This replaces the Phase 4 boundary where a row saved
  later by the drain never reached the list; with "needs reconnect"
  every application made during a lapse would otherwise be missing from
  the popup after Reconnect, with no Edit, Undo or live chip. The drain
  adds them in one locked write (`addRecentApplications`), re-sorts the
  whole list by the date the user applied, newest first, then keeps 20.
  During a lapse nothing else is logged, so saved rows are normally the
  newest; a row queued hours earlier lands at its date, and one older
  than the 20th entry is saved to the sheet but doesn't enter the list.
- `CONNECT_PROVIDER` drains the queue right after creating the sheet,
  like `RECONNECT_PROVIDER`, instead of waiting up to 5 minutes, and
  Settings shows the same "Saved N waiting applications" line. That
  drain never fails either message (`drainAfterSignIn`): a throw outside
  its per-row catch (a storage read or write, the recent-list update) is
  logged and counts as saved 0, and the rows stay queued for the next
  alarm. Otherwise Connect would report an error after creating the
  sheet, and its "Try again" would create and swap in a second one.
- The notification's Undo used to fail silently (a console warning only,
  and the "Logged" notification closed either way). Now an
  `AuthRequiredError` shows "Sign-in needed" again (the wrapper only
  shows it on the first failure), and any other failure shows a fixed-id
  `undo-failed` notification, with no button: "{Company} — {Title} is
  still logged. Use Undo in the extension's popup."

**Verified 2026-09-13 in Node only**, in the same test as above, now 18
of 18: 3 queued rows drained into a list of 19 came out sorted by
applied date and capped at 20 (the oldest queued row and the oldest
existing entry dropped, the middle one at position 13 with its real row
number, no toast); `CONNECT_PROVIDER` returned the new sheet with
`saved: 1, waiting: 0` and the entry at the top of the list, and one
whose drain threw (its queue write failing) still returned ok, with the
new sheet kept and `saved: 0, waiting: 1`; a
notification Undo failing with a 500 showed `undo-failed` with the
entry still Applied, one failing signed out with the flag already set
showed "Sign-in needed", and a successful one marked it Cancelled with
no failure notification. Not run live.

### Spreadsheet backend (Google Sheets only since 2026-09-13)

A `SpreadsheetProvider` interface decouples the rest of the extension
from the backend. See `src/providers/types.ts` for the current
interface.

**Reversed 2026-09-13 (decided by Ryan): Excel/OneDrive support
removed.** This was the locked "support both" decision, flagged before
changing it. Why: Ryan uses Google Sheets only; the Excel path was
never tested for the store (two Excel questions were still open); and
removing it drops two host permissions (`login.microsoftonline.com`,
`graph.microsoft.com`) and the only credential the extension stored
itself, a Microsoft refresh token.
- Removed: `providers/excel.ts`, `providers/msAuth.ts`,
  `lib/msTokenLock.ts`, `lib/pkce.ts`,
  `public/templates/blank-workbook.xlsx`, the Excel-only `SheetRef`
  fields (`tableId`, `webUrl`), the options page's Excel button, and
  the stored provider choice.
- An extension update deletes the leftover `msToken` and
  `activeProvider` keys (`REMOVED_EXCEL_KEYS`, background
  `onInstalled`).
- Kept: the `SpreadsheetProvider` interface, with
  `providers/activeProvider.ts`'s `getActiveProvider()` as the one
  place callers get the provider, so another backend can still be
  added without touching them.
- The Excel findings (Graph auth and scopes, the AppFolder, its
  formula-injection fix) are in git history up to `c469bbd`.

**Updated 2026-09-09:** `readRow` added — reads an entire row back as
a header-keyed record, same shape as `appendRow`'s `row` parameter.
Not part of the original interface; added specifically so the
popup's Edit/Undo-from-the-recent-list feature (see Logging
behavior, below) could verify a row still matches its cached
identity before overwriting it — `updateCell`/`cancelApplication`
are blind positional writes by `rowNumber` with no built-in
verification, which was an acceptable, explicitly-accepted risk for
the notification's ~5-second window but not for a popup action
reachable indefinitely. Implemented by reading the row's current
headers first (for column order), then a single range read across that
row — `googleSheets.ts` mirrors `readHeaders`' own `1:1`-style range
exactly, just targeting `rowNumber:rowNumber`. A row number past the
sheet's actual filled extent doesn't error — the API just returns
empty values, which naturally fails the identity check downstream rather than needing separate not-found handling.

**Updated 2026-09-13:** `readCells(sheetRef, rowNumbers, columnNames)`
added, for the popup's live status chips (Logging behavior, above): the
named columns of several rows in one read, in `rowNumbers`' order. Not
in the original interface; flagged as an addition. Google implements it
as one `values:batchGet` after `readHeaders`: one range per column
spanning the lowest to the highest requested row (e.g. `G2:G21`), with
`majorDimension=COLUMNS`, so the number of requests doesn't grow with
the number of rows. The recent list is the latest rows, so the span
stays close to their count.

**Updated 2026-09-13:** `AuthRequiredError` added to
`providers/types.ts`, a flagged addition to the provider contract: a
provider throws it when it can't get authorization without the user
signing in again, and `getActiveProvider()`'s wrapper turns it into the
"needs reconnect" flag (Logging behavior, above). The wrapper lists
every `SpreadsheetProvider` method, so a new method is a type error there
until it's tracked too.

**Updated 2026-09-14:** `readLogIds(sheetRef)` added, a flagged addition
to the provider contract: each logged application's Log ID and the row
it's on, for the offline-queue drain's duplicate check, or null when the
sheet has no Log ID column (Sheet setup, below). Google implements it as
the header read plus one `values:get` of that column from row 2 down.

**Fixed 2026-09-14 (a renamed sheet tab):** every A1 range used
`sheetRef.sheetName` unquoted, and the name was never refreshed. A tab
renamed to anything with a space or an apostrophe didn't parse, and any
rename at all left every call failing with 400 "Unable to parse range"
(every log queued, retried and failing again). Now every range quotes
the name (`'Name'!A1`, any `'` doubled; `parseAppendedRange` reads that
form back), and each public provider method runs through `withSheetRef`
(`googleSheets.ts`): on that 400 it looks the tab's current title up by
the stored numeric `sheetId` (`spreadsheets.get?fields=sheets.properties`,
a rename keeps the id), stores it (`updateStoredSheetName` in
`lib/sheetRef.ts`, only if that spreadsheet is still the connected one;
`setSheetRef` now takes the storage lock too, so a Connect can't land in
between) and retries once. A deleted tab, an unchanged title or a
sheetRef without a `sheetId` keeps the original error. Retrying is safe,
since a range that didn't parse wrote nothing; the append's retry stays
inside the append lock. **Verified 2026-09-14 in Node only**
(`tests/background.test.ts`, the fake Sheets API answering any other
tab name with that 400): with the tab renamed to "Bob's Jobs", an apply
made one tab lookup, appended at `'Bob''s Jobs'!A1`, stored the new name
and logged; the next apply made no lookup; every range sent was quoted;
with the tab deleted, one lookup, no loop, the row queued and the stored
sheetRef unchanged. The existing assertions now expect `'Sheet1'!G5`.

**Added 2026-09-14 (decided by Ryan): a sheet in Drive's trash or
deleted.** Before, nothing handled a stored sheet that no longer existed:
every call failed with an error that wasn't `AuthRequiredError`, rows
queued forever behind "waiting to be saved (offline?)", Settings still
said Connected, and no UI path could create a new sheet. Measured first
with `scripts/sheet-probe.js` (`7bdaa07`), Ryan's run on a throwaway
sheet: moving it to Drive's trash changed no Sheets API answer
(`spreadsheets.get`, `values.get` and `values.append` all 200 before, in
trash and after restore; appends still land), while Drive's
`files.get?fields=trashed,explicitlyTrashed` said `trashed=true` in trash
and `false` after the restore; that Drive call worked from the service
worker with no new `host_permissions` (Google's APIs send CORS headers),
so detecting trash needs no permission change. A permanently deleted file
is expected to return 404 (not measured). So:
- **Two states in one flag** (`lib/sheetStatus.ts`, `sheetStatus` in
  `chrome.storage.local`: `{state, since, reason}`): 'trashed' from Drive
  (`isTrashed`, a flagged addition to the provider contract), cleared only
  by a later `trashed=false`; 'missing' from a 404 that a second read of
  just the spreadsheet also answers 404, online (`SheetMissingError`, a
  flagged addition), cleared by any call that reaches the sheet. The
  provider wrapper sets and clears both, like the sign-in flag; a Drive 401
  that survives the retry is "sign-in needed", not trashed; a 500 or a
  timeout changes nothing.
- **When Drive is asked:** after each application logged directly (after
  the row is written, not holding up the log), when the popup opens (next
  to `GET_LIVE_STATUSES`, not awaited), and on a retry-alarm tick, before
  the drain, only while applications are waiting or the flag is set
  (decided in review: no Drive call every 5 minutes on an idle
  extension).
- **While flagged nothing is written:** new applications and the drain
  wait in the queue, and `SET_STATUS`, `SAVE_RESUME_VERSION` and the
  notification's Undo are refused (`SHEET_UNAVAILABLE`). Rows appended in
  the gap before the trash was noticed stay in the trashed sheet and come
  back with a restore; the UI says so.
- **UI, wording per state:** a "!" badge with the state in its tooltip
  (`lib/badge.ts`, now shared with sign-in); a fixed-id notification with
  Open Settings, on the first report and for each queued application; the
  popup banner; the Settings card, amber, with "Create a new sheet" (and
  "Open Drive's trash" when trashed).
- **"Create a new sheet"** (`CREATE_NEW_SHEET`, a flagged addition to the
  internal messages): the one path that replaces the connected sheet, and
  only when it's trashed or deleted; refused (`SHEET_HEALTHY`) while it's
  reachable and not trashed. It creates the sheet, connects it, clears the
  flag, empties the recent list (its rows were in the old sheet) and
  drains the queue into the new one. It runs one at a time with Connect.
- **Connect with a stored sheet** now checks it (the header read, then
  Drive): kept while it exists, in the trash too (flagged); replaced
  through the same path when it's deleted; any other failure fails the
  Connect and creates nothing.

**Verified 2026-09-14 in Node and headless Chrome only** (`npm test` 112
of 112 on the `sheet-missing` branch; the fake Sheets API follows the
probe: a trashed sheet answers every Sheets call as usual, only Drive
says trashed, and a deleted one answers 404):
- trashed: a direct log still lands, then the Drive check after it sets
  "trashed", the badge and one notification; the next application is
  queued with no append and the notification repeats with the count; a
  retry tick asks Drive again and writes nothing; a Sheets success doesn't
  clear "trashed"; after a restore the next tick clears the flag, badge
  and notification and the drain writes the queue; `SET_STATUS`,
  `SAVE_RESUME_VERSION` (`SHEET_UNAVAILABLE`) and the notification's Undo
  write nothing, before any request;
- deleted: the append's 404, confirmed by a second read, sets "missing",
  queues the row and notifies "Your sheet was deleted"; a tick keeps it;
  a 404 the second read doesn't confirm is an ordinary failure, no flag;
- Drive: a 401 surviving the retry is "sign-in needed", not trashed; a
  500 or a timeout sets nothing;
- `CREATE_NEW_SHEET`: trashed -> a new sheet, connected, flag cleared,
  recent list emptied, the queue saved into it; healthy -> refused
  (`SHEET_HEALTHY`), nothing created; deleted -> a new sheet;
- Connect: a deleted stored sheet is replaced; a trashed one is kept and
  flagged;
- opening the popup asks Drive (`GET_LIVE_STATUSES`); a retry tick with
  nothing queued and no flag doesn't, and with an application queued it
  does, before the drain;
- the popup, rendered headless: per state, the banner's title, "2
  applications are waiting" and Open Settings, with every status chip
  disabled.
Not run live: the trash, restore and "Create a new sheet" flow is in
web-store-deploy step 6.

**Updated 2026-09-17 (decided by Ryan): "Start a new sheet", the way back,
and one flagged change to `SheetRef` and the sheet's naming.** Settings
could neither say which sheet was connected nor replace a healthy one, so
a new job search meant hand-editing storage. Now, in the healthy card and
below a hairline that keeps it away from Reconnect (that fixes access to
*this* sheet; this leaves it behind):
- **Which sheet is connected.** The card reads "Connected to {name}", with
  the existing Open sheet link. `SheetRef` gained `title?: string`, a
  flagged addition to the provider contract, set by `createSheet`, which
  already knows it. A ref stored before this (and a file renamed in Drive)
  is filled in lazily on the next Settings open by `REFRESH_SHEET_TITLE`
  (one `spreadsheets.get?fields=properties.title`, through the new
  `readTitle`), stored only if that spreadsheet is still the connected one;
  a failed read leaves the card saying "your sheet". Nothing else depends
  on the field.
- **Naming, a change to the locked sheet template's name.** The first
  sheet is still `Job Applications`. Every sheet after it — "Start a new
  sheet" *and* the trashed/deleted recovery path — is
  `Job Applications (from YYYY-MM-DD)`, the date taken at creation in
  local time (`lib/sheetTitle.ts`). Both paths leave a second file in
  Drive, so neither can reuse the plain name.
- **"Start a new sheet"** is a quiet link with an inline confirm (no
  modal: the Settings window is small), saying the old sheet stays in
  Drive untouched, that new and waiting applications go to the new one,
  and that the popup's recent list is cleared. Confirming sends
  `CREATE_NEW_SHEET` with `payload.replaceHealthy: true`, the only way to
  get past the `SHEET_HEALTHY` guard — absent, or anything but `true`, and
  the guard still refuses, so a flaky read can never swap out a good
  sheet. It then does exactly what the recovery path does: create, connect,
  clear the flag, empty the recent list, drain the queue into the new
  sheet. The old spreadsheet is never deleted, trashed or written to.
- **The way back.** The sheet being left is remembered
  (`previousSheetRef`, id, tab, `sheetId` and title), and Settings offers
  "Switch back to the previous sheet" for as long as one is remembered —
  permanently, not just right after the swap, since a mistaken swap may
  only be noticed days later, and it costs one storage key. It's offered
  in the trashed/deleted card too, where it's a recovery that keeps the
  old rows. `SWITCH_TO_PREVIOUS_SHEET` checks that sheet is reachable and
  not in the trash first and refuses with `PREVIOUS_UNAVAILABLE` (wording
  per state) otherwise; a successful switch mirrors a swap — the sheet
  being left becomes the remembered one, the recent list is cleared, and
  the queue drains into the sheet returned to. Both new messages run one
  at a time with Connect, with overlapping requests sharing one run.

**Verified 2026-09-17 in Node and headless Chrome only** (`npm test` 217
of 217; 12 Node cases and 8 headless ones added):
- naming: the first Connect creates "Job Applications" and the ref carries
  it; a swap and the trashed recovery path both create the dated name;
  swap -> switch back -> swap again dates the second new sheet too;
- `CREATE_NEW_SHEET` with `replaceHealthy: true` on a healthy sheet: a
  dated new sheet connected, the old one remembered, **no request sent to
  the old spreadsheet at all**, the recent list cleared and the queue
  saved into the new sheet; without it (absent, `{}`, or the string
  `'yes'`) still `SHEET_HEALTHY` with nothing created; two at once create
  exactly one sheet;
- `SWITCH_TO_PREVIOUS_SHEET`: with the old sheet healthy, connected back
  to it, the sheet left remembered, the list cleared and the queue drained
  into the old sheet; with it in the trash or deleted, refused
  (`PREVIOUS_UNAVAILABLE`) saying which, nothing swapped and the list
  kept; with nothing remembered, refused;
- `REFRESH_SHEET_TITLE`: fills a ref stored before titles existed in one
  read, picks up a rename, and on a failed read leaves the stored title
  alone;
- Settings, rendered headless at its 440px width in both themes: the card
  names the connected sheet (and the lazily filled one), the confirm's
  question, its three lines and both buttons, Cancel changing nothing,
  confirming naming the new dated sheet, the way back named after the
  previous sheet, a successful switch, and the refusal's reason shown
  in the card.
**Not verified against the real API. Ryan declined the real-sheet run
(2026-09-17),** as with the step-6 live checks above. `scripts/new-sheet-check.ts`
stays in the repo and is paste-ready for whenever it's run; until then these
five are unverified, not passed:
- the plain name and the dated name as **Drive** stores them (the Node tests
  only see the title we send in the create call);
- two distinct files, with the first one still there, still named
  `Job Applications` and not trashed after the second is created;
- rows landing in the new sheet after a swap, with the old sheet unchanged;
- switching back: rows landing in the first sheet again, with Drive's
  `trashed` flag — the check that gates the switch — answering false, and
  answering true once that sheet is in the trash, which is what makes the
  refusal;
- `readTitle` picking up a file renamed by hand in Drive, the lazy fill
  behind Settings' "Connected to ...".

Test waits on main (2026-09-14, review): the background tests' fixed
`settle()` wait (60 ms) is replaced by five event-loop turns, and the fake
Sheets API answers with plain promise-based objects (`fakeResponse`)
instead of real `Response`s, as on the `workday` branch (`f4e6bd6`),
where the reviewer's first cold run had failed 2 tests: a real
`Response`'s first use in a process costs 21-34 ms, longer than such a
fixed wait. No test on main depends on wall-clock time now.

**Updated 2026-09-09:** `SheetRef` gained `sheetId?: number`, the
numeric grid id (not the string `sheetName`),
captured at `createSheet` time. Needed because `batchUpdate`'s
formatting requests (`repeatCell`, `addConditionalFormatRule`,
`setDataValidation`, `updateDimensionProperties` — see "Sheet
setup" below) all address ranges by this numeric id, which nothing
had needed to capture before new-sheet formatting existed.

**Updated 2026-09-08:** `mapColumns` removed — it existed only for
existing-sheet linking (Phase 7), which was permanently descoped
(see "Sheet setup" below); it had no remaining caller.

**Updated 2026-09-01 (Phase 4):** two changes from the original
locked shape above, both flagged and confirmed before implementing:
- `appendRow` now returns `AppendedRow` (`{ sheetName, rowNumber }`)
  instead of `void` — Undo/Edit need to know exactly which row was
  just written, and the Sheets API's own append response is the only
  race-free source for that (an extra read-after-write to infer the
  last row would race against concurrent edits).
- `updateCell(sheetRef, rowNumber, columnName, value)` added —  not
  part of the original interface at all. Needed so Undo (mark
  `Status`) and Edit (overwrite `Resume Version`) can update one cell
  of an already-written row without providers leaking into
  provider-agnostic code (background worker) branching on which
  backend is active.

The implementation: `GoogleSheetsProvider` — Sheets API v4, OAuth via
`chrome.identity`, scope limited to `drive.file` (extension can only
touch files it created — required for a clean Web Store review).

The rest of the extension gets the provider through
`providers/activeProvider.ts`'s `getActiveProvider()`; the background
worker is its only caller (see Trust boundary).

Detection/parsing logic must never branch on which provider is
active — only the provider implementation differs. This is the main
thing that avoids having to redo the architecture later if a third
backend is ever added.

### Sheet setup (locked decision)

Default: **auto-create** a new sheet on first install/auth, from a
fixed template (Date, Company, Title, Location, URL, Resume Version,
Status, Notes). Zero setup required to get working.

**Updated 2026-08-27:** added `Location` (8th column) — the LinkedIn
parser built in Phase 2 extracts it, and the original 7-column list
above had no column for it, so it was being silently discarded at
write time. Column order: Date, Company, Title, Location, URL, Resume
Version, Status, Notes.

**Updated 2026-09-14 (decided by Ryan), a change to this locked
template:** a 9th, hidden "Log ID" column after Notes. `buildRow` gives
each logged application a random id (`crypto.randomUUID()`), kept
through `sanitizeRow`, the offline queue and the drain, and `appendRow`
writes it like any other column. Why: an append can succeed at Google
while its response times out (`lib/fetchWithTimeout.ts`), which queues
the row anyway, and the next drain used to append it a second time (the
"appendRow isn't idempotent" note under Deferred). Now the drain reads
the sheet's Log IDs once per pass (`readLogIds`: the header read plus one
read of that column) and skips a queued row whose id is already there,
counting it as saved so it leaves the queue, with its recent-list entry
taken from the row found. The normal log path makes no extra calls.
`createSheet` hides the column (60px) and leaves it out of the banding;
no other formatting targets it. It's never shown in the popup
(`RecentApplication` has no Log ID). Only new sheets get it: on a sheet
without the column `readLogIds` returns null and the drain appends as
before. Ryan gets a new sheet at the extension-ID switch.

**Verified 2026-09-14 in Node only** (`tests/background.test.ts`, with
the fake Sheets API storing appended rows and able to let an append
succeed and then time out), 6 cases, plus the existing 60 still passing
(`npm test`: 66 of 66):
- `buildRow` gives each row a random Log ID, and `sanitizeRow` keeps it.
- An append that succeeded but timed out is queued, and the next drain
  finds its Log ID: 1 copy in the sheet, no second append, the queue
  empty, and the recent-list entry at the row found.
- An append that really failed (a 500) is still appended by the drain.
- Two applications with the same Date and Company but different Log IDs
  stay 2 rows.
- On a sheet without the column there's no column read, and the row is
  appended as before (8 columns, no id).
- `createSheet` writes Log ID as the 9th header, hides that column at
  60px, and bands only the first 8 columns.

Not run live; the new sheet at the extension-ID switch is the first real
one with the column.

**Updated 2026-09-17:** a logged row's Status cell starts at `Applied`
rather than blank — see Status field for the reasoning and what it doesn't
change.

**Updated 2026-09-16 (decided by Ryan), a second change to this locked
template: a "Summary" tab.** `createSheet` adds a second tab whose cells
are formulas over the applications tab — totals by status, a Pace block
(this week, last week, the 8-week average), and the last 8 weeks with a
count and a bar. New sheets only: an existing sheet is never modified, and
a user who deletes the tab loses nothing.
- **It costs no extra API calls.** `createSheet` still makes three: the
  create, the header write, and the formatting batch. The tab is requested
  with an `addSheet` in that same batch (with a fixed `sheetId`, free on a
  one-request-old spreadsheet, so the cell requests can name it without a
  round trip to learn it), and its cells go in as `updateCells` with
  `userEnteredValue.formulaValue`. The batch grows from about 18 requests
  to 30. No value write anywhere becomes `USER_ENTERED`, so the RAW-only
  formula-injection defence is untouched: only our own literals are ever
  parsed as formulas.
- **Formulas** take their column letters from the `templateColumns` passed
  in, never hardcoded, and use open-ended ranges so rows added later count
  themselves: `=COUNTIF('Sheet1'!$G$2:$G,"Applied")`,
  `=COUNTA('Sheet1'!$B$2:$B)`, a week start of
  `=TODAY()-WEEKDAY(TODAY(),3)-7*(ROW()-13)`, and a week count of
  `=COUNTIFS(dates,">="&$A13,dates,"<"&$A13+7,statuses,"<>Cancelled")`.
- **Cancelled is counted in the totals by status and left out of the
  weekly numbers** (decided by Ryan), which matches the popup's summary
  line. C10 and C12 say so on the sheet, and both cells carry the same
  text as a note.
- **The bar is `=REPT("█",MIN($B13,20))`**: a busy week doesn't paint a
  bar across the sheet, and the count beside it stays exact.
- **The applications tab stays first** — `createSheet` reads
  `created.sheets[0]` for the name and id — and the hidden Log ID column
  is irrelevant to the formulas, which name Date, Company and Status only.
- **The spreadsheet's locale is pinned to `en_US` at creation**, so the
  comma-separated arguments in those formulas parse as written whatever
  the account's own locale is. The Date column's display format is set
  explicitly either way.
- **Nothing writes there again:** every other provider method addresses
  `sheetRef.sheetName`, and a rename resolves through the applications
  tab's numeric id. `tests/summaryTab.test.ts` asserts that: it drives
  every other provider call and fails if any request names the tab.

**Verified 2026-09-16 in Node only** (`tests/summaryTab.test.ts`, 8 cases):
three requests, with the tab added and filled in the one batch; the status
totals, the total, the Pace block and the week rows as written above; each
week row addressing its own Monday; the bar capped at 20; the Cancelled
labels and their notes; a reordered template moving every range; and no
other provider call naming the tab.
**Verified 2026-09-16 on a real throwaway sheet.** Ryan ran
`scripts/summary-check.ts` in the extension's service worker; his paste,
trimmed only of the sheet URL and the DONE lines:

```
1_formulas_landed: locale "en_US", tabs ["0:Sheet1","1:Summary"],
 appliedCell =COUNTIF(Sheet1!$G$2:$G,"Applied"),
 weekCountCell =COUNTIFS(Sheet1!$A$2:$A,">="&$A13,Sheet1!$A$2:$A,"<"&$A13+7,Sheet1!$G$2:$G,"<>Cancelled"),
 barCell =REPT("█",MIN($B13,20)), appliedValue 0, weekCountValue 0,
 verdict "PASS: stored as formulas and evaluating to numbers"
2_appends_update: statusTotals {Applied 0, Interview 0, Offer 0,
 Rejected 0, Cancelled 1}, totalLogged 4, thisWeek 2,
 weeks [{46279,2,2},{46272,1,1},{46265,0,0}],
 verdict "PASS: totals, weeks and bars moved"
3_cancelled: cancelledInTotals 1, thisWeek 2, verdict "PASS"
4_rename: appliedCell =COUNTIF('Bob''s Applications'!$G$2:$G,"Applied"),
 totalLogged 4, thisWeek 2, verdict "PASS: references rewritten,
 numbers unchanged"
5_delete_summary: deletedSheetId 1000001, appendedRow {"Bob's
 Applications", row 6}, verdict "PASS: append still works with no
 Summary tab"
trashed: yes
```

So: the cells hold formulas, not text, and the sheet's locale (`en_US`,
pinned at creation) parses them; four appends moved the totals, the week
counts and the bars; the Cancelled row counted in the totals and not in the
week; renaming the applications tab rewrote the references with every number
unchanged; deleting the Summary tab left the next append working; and the
throwaway sheet went to Drive's trash.

**The zero status totals in that run are what exposed the blank-Status gap**
(Status field, 2026-09-17): every total was 0 except the one Cancelled cell
`updateCell` had set, so the By status block couldn't sum to `totalLogged: 4`.
Note what that run does and doesn't prove about the fix: the script wrote its
own literal row then, with `Status: ''` — the same thing `buildRow` did, which
is why the zeros matched the product's behaviour, but it means the run
exercised the script's row, not `buildRow`. The script builds its rows through
`buildRow` + `sanitizeRow` since 2026-09-17 (the earlier bundle contained
neither function), so the re-run below is what shows the totals summing.

**Re-verified 2026-09-17 on a second throwaway sheet**, with the script
appending what `buildRow` returns. Ryan's paste, trimmed of the sheet URL and
the DONE lines:

```
1_formulas_landed: locale "en_US", tabs ["0:Sheet1","1:Summary"],
 appliedCell =COUNTIF(Sheet1!$G$2:$G,"Applied"), weekCountCell
 =COUNTIFS(Sheet1!$A$2:$A,">="&$A13,Sheet1!$A$2:$A,"<"&$A13+7,Sheet1!$G$2:$G,"<>Cancelled"),
 barCell =REPT("█",MIN($B13,20)), appliedValue 0, weekCountValue 0,
 verdict "PASS: stored as formulas and evaluating to numbers"
2_appends_update: statusTotals {Applied 3, Interview 0, Offer 0,
 Rejected 0, Cancelled 1}, totalLogged 4, thisWeek 2, weeks
 [{46279,2,2},{46272,1,1},{46265,0,0}], statusTotalsSum 4, verdict
 "PASS: totals sum to Total logged (3 Applied + 1 Cancelled), weeks
 and bars moved"
3_cancelled: cancelledInTotals 1, thisWeek 2, verdict "PASS"
4_rename: appliedCell =COUNTIF('Bob''s Applications'!$G$2:$G,"Applied"),
 totalLogged 4, thisWeek 2, verdict "PASS"
5_delete_summary: deletedSheetId 1000001, appendedRow {"Bob's
 Applications", row 6}, verdict "PASS"
trashed: yes
```

So the By status block now sums to Total logged — three rows logged through
the shipped path carry `Applied`, the fourth was set to `Cancelled` through
`updateCell` — and `thisWeek` counts 2, the Cancelled row still left out. The
formulas, the rename and the delete-tab checks passed again, and this sheet
was trashed too.

**Updated 2026-09-09:** `createSheet` applies visual formatting to
the new sheet — `createSheet`-only, never touches an
already-existing one. Column indices for all of the below are
computed from the actual `templateColumns` array passed in
(`indexOf('Status')`, etc.), never hardcoded, so this doesn't
silently break if the template's shape ever changes.

- **Header row**: bold white Roboto on the brand blue `#2563EB` (the
  icon's), vertically centred, 32px tall, and frozen.
- **Sheet**: gridlines hidden and a brand-coloured tab.
- **Data rows**: Roboto, vertically centred, long text clipped rather
  than spilling over; Notes wraps instead, and Status is centred.
  Alternating white/`#F5F7FB` banding on the data rows.
- **Column widths**: a pixel width for every column (Date 130, Company
  180, Title 280, Location 170, URL 200, Resume Version 140, Status
  120, Notes 280).
- **Status conditional formatting**: real, persistent
  `addConditionalFormatRule` rules (`TEXT_EQ` per value: `Offer` →
  green, `Interview` → blue, `Applied` → yellow, `Rejected` → red,
  `Cancelled` → grey with grey text), so the colour keeps re-evaluating
  live even if a value is changed by hand later, with no code involved
  at all.
- **Status dropdown (data validation)**: restricts `Status` to exactly
  the five values above via `setDataValidation` (`ONE_OF_LIST`,
  `strict: true`, `showCustomUi: true` for the actual dropdown
  chevron). `strict` was chosen over warn-only because the colour
  rules above do an exact `TEXT_EQ` match — a typo or wrong case would
  silently get no colour at all, so rejecting invalid input protects
  that feature too.

**Verified 2026-09-09:** both features confirmed with real evidence
against real newly-created sheets, not just successful API
responses. Header formatting and column widths visually confirmed
rendered correctly on a real Google Sheet. The dropdown chevron
actually renders on Status cells; selecting a value from it works;
typing a non-matching value is actually rejected (not just shown a
warning); and the conditional-formatting colors correctly fire off
dropdown-driven selections, not just typed text.

**Updated 2026-09-13 (decided by Ryan):** the formatting above grew from
a blue header, two widened columns and the Status rules to the full set
listed (frozen header, hidden gridlines, banding, Roboto, vertical
centring, clip/wrap, a width per column, Cancelled grey). Only new
sheets get it; Ryan gets a fresh sheet at the extension-ID switch.
Previewed on a throwaway sheet before building, per the 2026-09-11
lesson below: the real `createSheet`, then the candidate formatting,
then 7 rows through the real `appendRow` with the grid shrunk to 5 rows
so the last 3 appends extended it, and statuses and a long note through
the real `updateCell`. Checked via the script's JSON: frozen row 1,
gridlines hidden, the banding and all 5 Status rules extended to row 8,
header 32px, and row 2 and row 8 (past the original grid) formatted
identically (date `2026-09-13 14:29`, Roboto, centred, clipped, Notes
wrapping, Status centred with its dropdown). Checked visually: Cancelled
grey, and the long note wrapped over three lines with its row grown to
fit.

**Verified 2026-09-13** on the shipped code, checked via the script's
JSON output: an esbuild bundle of the real `googleSheets.ts` run in the
extension's service worker. The real `createSheet` built the sheet with
all of the formatting in its own batch; the grid was shrunk to 5 rows,
and 7 rows logged through the real `appendRow` grew it to 8. Frozen
row 1, gridlines hidden, tab `#2563EB`, the banding and all 5 Status
rules extended to row 8 (Cancelled `#E5E7EB` with `#4B5563` text,
Rejected still `#F4C6C6`), header 32px and data rows 21px, widths
130/180/280/170/200/140/120/280, and the header bold Roboto on
`#2563EB`. Row 2 and row 8 formatted identically: date
`2026-09-13 15:00`, still `yyyy-mm-dd hh:mm` (the data-row field mask
left the date format alone), Roboto, vertically centred, clipped, Notes
wrapping, Status centred with its dropdown. Checked visually at 100%
zoom: white header text and a readable grey Cancelled cell. The sheet
was moved to Drive trash.

**Corrected 2026-09-11:** the verification above was real but too
narrow. It tested Status cells on a freshly created sheet by typing
into, and picking from the dropdown in, empty cells. It never tested
rows the extension actually logs, and on those neither feature
worked. `appendRow` used `insertDataOption=INSERT_ROWS`, which
inserts each new row directly under the header. So every logged row
(a) inherited the header's formatting (blue fill, bold white text),
and (b) pushed the Status dropdown and all five colour rules, which
`createSheet` anchors at row 2, down one row. After N appends the
rules started at row N+2, below every logged application: no dropdown
and no colour on any real entry. Found during Phase 9 screenshot prep
on the real sheet (rules at `G5:G1003` after 3 logged rows, data cells
bold). Reproduced on a throwaway sheet built by the same
`createSheet` calls: rules at row 5, A2 header-styled, no G2 dropdown.

`OVERWRITE` alone was tested and rejected. It fixed the formatting
(rules stayed at row 2, A2 clean, dropdown present), but it lost data
under concurrency: only 13 of 20 rows landed when appends were fired
3–5 at a time, because concurrent requests were handed the same
target row and silently overwrote each other. Silent row loss is
worse than the formatting bug.

Fix (approved 2026-09-11): `OVERWRITE` plus a dedicated in-memory
lock, `lib/sheetAppendLock.ts`, wrapping `readHeaders` + the append
inside `GoogleSheetsProvider.appendRow`. That's enough because the
background worker is the only caller of `appendRow`
(`handleJobApplicationLogged`, `drainOfflineQueue`), and each install
only ever writes to the sheet its own Connect created. Known remaining
limitation: if the user is mid-edit (cell editor still open) in the
first empty row, that edit can land after an append and overwrite that
one cell of the logged row. It's the user's own client, so no lock can
prevent it.

**Verified 2026-09-11**, both on throwaway sheets:
- **Shipped code**, checked via the script's JSON output: an esbuild
  bundle of the real `googleSheets.ts`, run in the extension's service
  worker. The real `createSheet` built the sheet, and two real
  `appendRow` calls fired together with `Promise.all` landed in
  separate rows (2 and 3). The real `readRow` returned both (A and B).
  The rules started at row 2, A2 wasn't bold, and G2 had the dropdown
  (`VERDICT_separateRows_bothLanded: true`).
- **Concurrency under the lock**, checked visually in the sheet itself,
  not from the script's JSON. The JSON didn't print before the console
  was copied. This used a copy of the lock textually identical to
  `sheetAppendLock.ts`, with the same 20-row plan that lost 7 rows
  without it: five rounds of 3 simultaneous appends, then one round of
  5. All 20 rows landed, T1R1 through T6R5 in order, with no gaps,
  blanks or duplicates. The data rows were unstyled, and every Status
  cell had its dropdown.

**Updated 2026-09-11 (Date column, Google only):** `buildRow` writes
Date as an ISO string, and through the RAW append Sheets stored it as
text (`2026-09-11T20:26:32.390Z`), not a date. `GoogleSheetsProvider.
appendRow` now converts it to a real date value, a date serial from
`lib/dateSerial.ts`. `createSheet` formats column A from row 2 down as
`yyyy-mm-dd hh:mm`. Only the provider converts: `buildRow`, the offline
queue and the recent list all keep the ISO string. Still RAW: a JSON
number stays a number, and every scraped string is still stored
literally, so the formula-injection defense is unchanged. The serial is
the browser's local time, using the offset of the timestamp being
written, not the current one, so a row queued before a DST change and
drained after it still shows the time the user applied. It's floored to
the minute because Sheets rounds an `hh:mm` display to the nearest
minute: 12:00:59.9 showed as 12:01, and 23:59:30 or later would show
the next day. Sheets created before this change have no date format on
column A, so new rows there show a bare number (e.g. `46276.68`) until
column A is given a date format once by hand. Rows logged before the
change stay ISO text.

**Verified 2026-09-11** on a throwaway sheet, checked via the script's
JSON output: an esbuild bundle of the real `googleSheets.ts` run in the
extension's service worker, browser timezone America/Toronto. Real
`createSheet`, then three real `appendRow` calls:
- `2026-09-11T20:26:32.390Z` landed as `numberValue` 46276.685 with
  format `DATE_TIME yyyy-mm-dd hh:mm`, displayed `2026-09-11 16:26`.
- Same row, formula-injection regression: `=1+1`, `+SUM(1,1)`, `@A1`
  and `-2-3` all landed as literal text with no `formulaValue`.
- A row the append added past a grid shrunk to 3 rows (a real sheet
  hits this after 999 applications) kept the format:
  `2026-10-31 12:00`.
- 12:00:59.9 displayed as `12:01`. That's how the rounding was found.
  The floor was added after this run and not rerun live. It's covered
  by a pure-function check of the real `dateSerial.ts` in Node
  (`TZ=America/Toronto`): that timestamp now converts to exactly
  46328.5 (12:00), 23:59:45 local stays on the same day, and one
  timestamp on each side of both 2026 DST changes converts to the
  right local noon.

~~Alternative: **link an existing sheet.** The extension reads the
existing header row and auto-maps it to the known fields above using
fuzzy matching (case-insensitive, ignores punctuation/whitespace
differences). Any known field with no confident match is shown to
the user once, in a simple mapping UI, to confirm or manually assign.
Any known field missing entirely from the existing sheet is appended
as a new column — the user never needs to have pre-formatted
anything correctly.~~

**Descoped, not deferred (confirmed 2026-09-08):** existing-sheet
linking is off the table permanently, not paused. Root cause, found
during Phase 7 implementation and confirmed with real evidence
before this call was made: `drive.file` (the locked OAuth scope —
see Security) has exactly one path to accessing a file the extension
didn't create — a real, user-driven Google Picker selection; a
pasted URL/ID never goes through that grant flow and 404s
(`GET .../spreadsheets/{id}` against a real second sheet, confirmed
via added request/response logging). Picker integration was then
independently confirmed non-viable inside this extension's own
bundle: it requires `allow-same-origin`, which Chrome's MV3 sandboxed
extension pages are hard-forbidden from granting (real error
reproduced against
[a chromium-extensions thread](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/dLPOAHwigB8)
hitting the identical failure). The only working pattern is running
Picker on a page hosted on a real external domain, not bundled
extension code at all — genuine new hosting infrastructure to
build and maintain, for what is currently a personal-use convenience
feature layered on top of a tracker that already works end-to-end
via auto-create. Auto-create is the sheet-setup path, full stop.

### Status field

Manual. Status (Applied / Interview / Rejected / Offer) is set and
updated by the user directly in the spreadsheet or via the extension
UI — no auto-detection of status changes in v1. This was deliberately
descoped as a rabbit hole not worth the reliability cost.

**Updated 2026-09-01 (Phase 4):** added a fifth value, `Cancelled` —
set automatically (the one exception to "manual" above) when the user
clicks Undo on the toast notification within its ~5-second window.

**Updated 2026-09-14:** the popup's status dropdown can set any of the
five values (`SET_STATUS`, with the Company/Title check). It's still
manual: nothing detects a status change on its own.

**Updated 2026-09-17 (decided by Ryan), a flagged change to the rule
above: a logged row starts at `Applied`,** where `buildRow` used to write
an empty Status. Why: a blank cell showed no colour and no dropdown value
until the user set one; the Summary tab's totals by status couldn't sum to
Total logged (the 2026-09-16 real-sheet run read `totalLogged: 4` with
every status 0); and the popup already showed those same entries as
Applied from its cached list, so the sheet and the popup disagreed.
- It stays manual in the sense that matters: nothing detects a status
  change, and the cell is an ordinary editable one. `Applied` is one of
  the five values the strict dropdown accepts, and the sheet's `TEXT_EQ`
  rule colours it, so a logged row now looks the same as one the user set
  by hand.
- Nothing read a blank Status: `matchLiveStatuses` skips a falsy cell (so
  a fresh row's live read used to return nothing and the popup fell back
  to its cached Applied — now they agree), `recentEntryFor` already
  defaulted `row.Status || 'Applied'`, and `SET_STATUS` and the popup's
  chip never depended on it.
- A queued row keeps it: the row is built once and appended later, so a
  drained application lands with `Applied` too.
- Notes stays blank.
- **Rows already logged with a blank Status are left exactly as they are.**
  Nothing rewrites existing rows; those cells stay empty until the user
  picks a value, and the Summary tab's totals will be short by that many
  until then.

---

## Site parsers (v1 scope)

Start with three, in this order:
1. **LinkedIn** — highest volume, SPA, needs `MutationObserver`.
2. **Indeed** — second highest volume, also largely dynamic.
3. **Greenhouse** — common ATS with a comparatively consistent DOM
   structure across companies using it, good third site to prove the
   parser abstraction generalizes beyond the two biggest sites.

Each parser lives in its own file (`parsers/linkedin.ts`,
`parsers/indeed.ts`, `parsers/greenhouse.ts`) implementing a shared
`JobPageParser` interface (`detect(): boolean`,
`extract(): JobPostingData`, `getApplyButtonSelector(): string`).
Adding a fourth site later means adding one file, not touching
existing ones.

Do not consider a parser "done" until it has been verified against
multiple real postings on that site, not one — per the working
agreement above.

**Locked scoping decision (confirmed 2026-08-27):** v1 only catches
applications completed without leaving LinkedIn (Easy Apply). Some
postings' "Apply now" button redirects entirely off linkedin.com to
the employer's own career site — that's outside `host_permissions`
by design, and this extension cannot and will not follow the user
off-site to catch it. Those applications stay manual. This is a
scope boundary, not a bug to eventually fix by widening permissions.

**Updated 2026-09-14 (flagged: a content-script scope change):** the
LinkedIn content script matches `https://www.linkedin.com/*`, not
`*://www.linkedin.com/jobs/*`. LinkedIn is a single-page app: going from
`/feed/` to `/jobs/` in the app is a pushState, not a page load, so a
script matched only to `/jobs/*` was never injected and the Easy Apply
click wasn't logged. The script still acts only on job pages: it does
nothing until a click matches the Easy Apply selector, and `detect()`
checks the path is `/jobs/` at that moment. `host_permissions` is
unchanged, and the install warning names the same host
(www.linkedin.com). Both content-script matches are https only (the
Greenhouse one was `*://` too); `TRUSTED_ORIGINS` was already https
only. crxjs's `web_accessible_resources` origins follow (Permissions,
below). **Verified 2026-09-14 in Node only**
(`tests/contentScripts.test.ts`, the real `content/linkedin.ts` on a
fake page): loaded on `/feed/`, an Easy Apply-shaped click sends
nothing; after an in-app move to `/jobs/view/4460524353/` the same
instance sends one `JOB_APPLICATION_LOGGED` with the right title,
company and URL; an untrusted click, a click elsewhere, and a click back
on `/feed/` send nothing; the manifest's two matches are exactly the
https patterns. The real check, from `/feed/` click Jobs and then Easy
Apply, is in web-store-deploy step 6.

**Known v1 gap (updated 2026-09-11):** Easy Apply detection is only
fully supported with LinkedIn set to English, and the store listing
says so (`store-assets/listing.md`). The original selector,
`a[aria-label^="LinkedIn Apply"]`, had silently stopped matching
anything, in English too, because LinkedIn renamed the label to "Easy
Apply to …". A read-only inspection of 6 live pages (5 Easy Apply, 1
off-site) found three Easy Apply markups:
- `/jobs/view/` (3 of 4): `<a aria-label="Easy Apply to this job">`
  with href `/jobs/view/{id}/apply/`. The href isn't translated, so
  this one is matched in any UI language.
- `/jobs/view/` (1 of 4): `<button aria-label="Easy Apply to this
  job">`, no href, only hashed classes and a random `componentkey`.
  Only the English label identifies it.
- Split-pane search: `<button id="jobs-apply-button-id"
  aria-label="Easy Apply to {title} at {company}">`. The id can't be
  used: the split pane's off-site Apply button shares it (2 matches on
  one off-site posting, both "Apply to {title} on company website").
  English label only.

The selector is now `a[href*="/jobs/view/"][href*="/apply/"],
[aria-label^="Easy Apply to"]`. The Easy-Apply-only scope still holds:
the off-site "Apply on company website" link goes through `/safety/go/`
with a percent-encoded target, and off-site labels never start with
"Easy Apply to".

**Verified 2026-09-11** by Ryan with real Easy Apply clicks, closing
the modal without applying. In English, on a `/jobs/view/` posting
(the button variant), the content script's "apply logged" line fired
with the correct company, title and location. The split-pane id check
above is his console output. That English click landed as a real row
(deleted afterwards). With LinkedIn set to French, Ryan reported that a
click on a link-variant posting worked, but no console output was
captured and no row from it reached the sheet, so the non-English path
is not verified.

**Fixed 2026-09-11 (split pane):** split-pane applications were never
logged, for two separate reasons.
- The content script bound only the first match (`querySelector`), and
  the split pane renders the Easy Apply button twice, so a click on the
  second copy was ignored. Now one delegated, capture-phase listener
  (see Three components, Content scripts) catches every copy.
- Even the first copy logged nothing: `extract()` took the title from
  `document.title`, which on the split pane stays the search page's
  title ("(20) software engineer intern Jobs | LinkedIn") while a job's
  detail pane is showing, so extraction returned null.

The split pane (`?currentJobId=` on a non-`/jobs/view/` path) now reads
the detail pane instead: the title from its `<h1>` linking to
`/jobs/view/{id}/`, the company from the nearest ancestor with a company
link that has text (stopping at results cards), and the location from
the "ago" row. Checked read-only on 3 live jobs, all correct. A pane
that hasn't loaded, or shows a different job, returns null rather than a
wrong row. `/jobs/view/` extraction is unchanged.

**Verified 2026-09-11** on the reloaded build, by the reviewer in Ryan's
browser, with two real clicks through the browser tool. These are
trusted events, so they pass the `isTrusted` filter. Each Easy Apply
window was closed without applying and the draft discarded:
- A `/jobs/view/` posting (button variant), one Easy Apply click: one row,
  `2026-09-11 22:35`, with the company, title and location of that real
  LinkedIn Easy Apply posting, all correct.
- A split-pane search posting (`/jobs/search/?currentJobId=…`), one
  click on the visible Easy Apply button: one row, `2026-09-11 22:40`,
  with that real posting's company, title and location, all correct.

Exactly one row per click, with no duplicates; both rows were deleted
afterwards. An earlier split-pane click on the build before the reload
logged nothing, while the new extraction, run as a copy in the page,
read that posting correctly, so that miss was the old build. Ryan's own 7-step
sitting produced no rows and isn't counted. Not separately evidenced:
a click on the second Easy Apply copy (in this layout it sat offscreen,
at y = -859, and a click on it did nothing), keyboard activation, the
off-site Apply, and the Save/card negative checks.

**Fixed 2026-09-14 (LinkedIn's /jobs/search-results/ layout):** found by
the reviewer, live in Ryan's Chrome on the new-ID build: on
`/jobs/search-results/?currentJobId=4464201438&...&f_AL=true`, the layout
LinkedIn's main job search now serves, a trusted Easy Apply click logged
"apply clicked but extraction failed — no row logged". Read-only DOM
evidence from that page: no `<h1>` anywhere (the split-pane extraction
required the detail pane's `<h1>`); the title a
`<p><a href="/jobs/view/4464201438/">`; several company links to
`/company/galenthq/life/`; the location as one `<p>` "Mississauga, ON · 3
days ago · Over 100 applicants"; Easy Apply `<a aria-label="Easy Apply to
this job" href="/jobs/view/4464201438/apply/">`, which the selector
already matched; `document.title` now "{Title} | {Company} | LinkedIn" for
the selected job. Now, for any `?currentJobId=` page (the old split pane
and this layout), `extractLinkedInJob` (`parsers/linkedin.ts`) takes the
rendered link to `/jobs/view/{id}/` that isn't the `/apply/` link or in a
results card; its pane is the nearest ancestor that also holds the Easy
Apply control, and the link with the innermost pane wins (a results-list
link for the same job has a much higher one). Company and the "location ·
age" row come from inside that pane only. `document.title` is a fallback
for the company, used only when its title part is exactly the link's text.
Still null when the pane shows a different job (an Easy Apply link for
another id, or results cards inside it). `/jobs/view/` extraction is
unchanged. The parser now takes the document and address as arguments
(`linkedinParser.extract()` passes the page's), so fixtures can run at any
LinkedIn address.
**Verified 2026-09-14 in headless Chrome only**
(`tests/dom/linkedin.test.mjs`, each case in its own iframe; fixtures in
`tests/fixtures/linkedin/`, the new layout built from the reviewer's
structure, the other two from the structures recorded above, placeholders
beyond the one public posting): the old parser returned null on the new
fixture, reproducing the live failure, and the new one returns Galent /
the title / Mississauga, ON / `https://www.linkedin.com/jobs/view/4464201438/`;
with no company link in the pane, the matching `document.title` supplies
it, and with a stale search-page title there's no row; a pane showing
another job gives no row; the old split pane still extracts (the `<h1>`
link, the span location row, the stale title ignored) and gives no row for
a job whose pane isn't showing; `/jobs/view/` still extracts, URL without
the query. `npm test` 94 of 94. The same live session passed the
content-script scope check: from `/feed/`, LinkedIn's own Jobs navigation
(a page marker survived, so no reload) then an in-app move to a search
result, the script caught the trusted Easy Apply click; and a full-load
`/jobs/view/4464201438/` click logged. **Passed live 2026-09-14** on the
new-ID build with `8f18d83`: a `/jobs/search-results/?currentJobId=`
Easy Apply click logged ("apply logged, sent to background") and its row
reached the sheet with the right fields.

**Spot-checked 2026-09-10 (test-pass follow-up):** a real risk was
flagged during a broader test pass but never actually verified live
at the time — `findLocationSiblingSpans` (`parsers/linkedin.ts`)
picks "the first sibling span whose text isn't 'ago' and doesn't
contain 'applicant'" as the location, with no defense against a
third kind of decorative content (a salary range, an "Actively
recruiting" badge) occupying that same position ahead of the real
location. Couldn't test this myself at the time — the parser
targets the authenticated SPA's client-rendered DOM, which no
fetch-based tool can reproduce without a real logged-in session.
Spot-checked directly now via a temporary, read-only debug export
(`content/linkedin.ts`, since removed) against several real, live
postings, including at least one with other visible metadata near
the location — the real field extracted correctly every time, no
salary/badge contamination observed in practice. Leaving this noted
as a known theoretical edge case, not resolved and closed — a clean
sample now isn't a permanent guarantee against LinkedIn changing
its DOM structure later, and there's no live regression test
watching for it. Worth revisiting only if it's ever actually seen
to happen, not before.

**Locked scoping decision (confirmed 2026-09-01):** the Greenhouse
parser only catches postings that stay on Greenhouse's own hosted
domains (`job-boards.greenhouse.io`, `boards.greenhouse.io`).
Greenhouse also supports "embedded" boards where a company hosts the
same job listing on its own domain (e.g. a raw `boards.greenhouse.io`
link redirecting to `careers.company.com/...?gh_jid=...`) — confirmed
via real testing that this is common, not an edge case (3 of 3
initial test postings redirected this way). There is no Chrome
manifest syntax to scope `host_permissions`/`content_scripts` to "any
domain, if the URL happens to contain `gh_jid=`," and broadening to
`<all_urls>` or a wildcard is explicitly forbidden by the Permissions
section below. Applications on a custom-domain-embedded Greenhouse
board stay manual, same as LinkedIn's off-site-redirect boundary —
this is a real, likely significant coverage gap for this parser, not
a hidden one, and not something to fix by widening permissions.

**Checked 2026-09-14:** `boards.greenhouse.io` only 301s to the same
path on `job-boards.greenhouse.io`, which is what the manifest matches,
so both hosts above are covered; Figma's board then forwards to its own
careers site, the custom-domain case that's already out of scope. Status
codes from real requests, following redirects:

| `boards.greenhouse.io` URL | Result |
|---|---|
| `/planetscale/jobs/4107018009` | 301 to `job-boards.greenhouse.io`, same path; 200 |
| `/planetscale/jobs/4107018009/confirmation` | 301 to `job-boards.greenhouse.io`, same path; 200 |
| `/anthropic/jobs/5183044008` | 301 to `job-boards.greenhouse.io`, same path; 200 |
| `/anthropic/jobs/5183044008/confirmation` | 301 to `job-boards.greenhouse.io`, same path; 200 |
| `/discord` (board) | 301 to `job-boards.greenhouse.io/discord`; 200 |
| `/figma` (board) | 301 to `job-boards.greenhouse.io/figma`, then 302 to `www.figma.com/careers/` |

**Verified 2026-09-07 (Phase 5):** `document.title` parsing,
`og:description`-as-location, and the `button[type="submit"]`
selector were all confirmed against real, live, independently
rendered postings (Figma, PlanetScale) before implementation, per the
working agreement. Post-implementation, two things were verified with
real evidence without ever touching a real company's application
form: (1) `getEventListeners()` in DevTools confirmed exactly one
`click` listener bound to the real submit button; (2) a synthetic
`JOB_APPLICATION_LOGGED` message sent from the real Greenhouse
content-script context (so `sender.origin` was genuinely
`https://job-boards.greenhouse.io`, exercising the real
trust-boundary check) produced a correct real row in the sheet.
**Deliberately not tested: an actual click on the real submit
button** — done by choice, to avoid the risk of accidentally
submitting a real application to Figma. The binding and the full
message pipeline are verified independently instead; the remaining
gap is purely "does a real user click dispatch the same way a
DevTools-confirmed listener does," which is the same native
`addEventListener` mechanism already proven working on LinkedIn and
not expected to behave differently here.

**Fixed 2026-09-12 (double-log):** a Submit click logged even when
Greenhouse then rejected the form with its own "is required" errors,
so fixing the fields and resubmitting logged a second row. Evidence,
read-only, from a blank form with a probe blocking every outgoing
POST: one trusted click on PlanetScale posting 4107018009 fired no
`submit` event and no native `invalid` events, sent nothing, showed
"First Name is required." plus three more, and still logged a row
through the old click listener (deleted afterwards).
- The form has no native `required` fields, only `aria-required`, so
  the browser never blocks it.
- Greenhouse's bundle attaches one handler to both the form's
  `onSubmit` and the button's `onClick`, and it calls
  `preventDefault()` first. So a `submit` event never fires, even on
  success, and a `submit` listener would miss every real application.
- On success Greenhouse posts the application itself, then calls
  `window.location.assign(confirmationPath)`: a full page load of
  `/{board}/jobs/{id}/confirmation` ("Thank you for applying"), which
  names the company but not the title or location.
- Checked on PlanetScale, Anthropic and Discord: all three serve the
  byte-identical `entry.client-B5kjVA5a.js`.

So Greenhouse now uses two-phase logging (Logging behavior, Updated
2026-09-12) through the optional `JobPageParser.applicationState()`
method, added 2026-09-12. Its content script already matched the
confirmation URL, so the manifest didn't change.

**Verified 2026-09-12** live on the reloaded build
(`greenhouse.ts-CClCJobb.js`), on PlanetScale posting 4107018009, with
a probe blocking every outgoing POST during the click:
1. A blank Submit click: Greenhouse showed its 4 "is required"
   messages, fired 0 `submit` events and sent nothing. The page console
   logged `submit clicked, application recorded as pending`, and no row
   appeared.
2. Opening that posting's `/confirmation` URL: exactly one row,
   `2026-09-12 21:22 | PlanetScale | Software Engineer - Insights | San
   Francisco…`, carrying the data from the click.
3. Reloading the confirmation page: no second row.
4. Anthropic posting 5183044008's `/confirmation`, with nothing
   pending: no row.

The test row was deleted afterwards. Opening the confirmation URL by
hand stands in for Greenhouse's own `window.location.assign`, which the
bundle shows; Ryan's next real Greenhouse application is the final
check of that navigation. Also a Node test of the real
`pendingApplications.ts` and `applicationState()` against a
deep-cloning mock storage: 13 of 13 pass, including a pending write and
a confirmation fired together, and two confirmations at once logging
exactly once.

---

## Security (required, not optional — this is going on the Web
Store)

**Secrets & credentials**
- No API keys, client secrets, or tokens hardcoded in bundled
  extension code. Use PKCE for OAuth flows so no client secret ships
  client-side at all.
- `.gitignore` covers any local `.env`/config from the first commit;
  add a pre-commit check so a token can never land in a commit.
  (Added 2026-09-11: `.githooks/pre-commit`, a dependency-free shell
  script, activated by `npm install` through the `prepare` script.)
- OAuth tokens stored only in `chrome.storage.local`, never
  `localStorage`, never synced to `chrome.storage.sync` in plaintext.

**Updated 2026-08-27 (Phase 3):** `GoogleSheetsProvider` uses
`chrome.identity.getAuthToken()`, not a hand-rolled PKCE flow — no
client secret exists for this client type at all (Google doesn't
issue one for a "Chrome Extension" application), and the OAuth token
itself is never written to `chrome.storage.local` or anywhere else by
this extension's own code — Chrome caches it internally against the
extension, and `chrome.identity.removeCachedAuthToken()` forces a
refresh on failure. Strictly safer than the literal "stored in
chrome.storage.local" text above; that instruction still applies as
written to any future provider that doesn't have an equivalent
built-in cache. The OAuth **client ID** (not a
secret — public by design for this client type) is hardcoded in
`manifest.config.ts`'s `oauth2` key; that's expected and fine to
commit.

**Updated 2026-09-13:** no provider stores a token now. With Excel
removed, Google is the only provider and Chrome caches its token; the
extension's own storage holds no credential (the "needs reconnect"
`authStatus` flag is a timestamp and an error message). The PKCE and
"tokens only in `chrome.storage.local`" lines above apply only to a
future provider that has to handle its own tokens.

**Trust boundary**
- The background service worker is the only component allowed to
  hold tokens or call spreadsheet APIs. Content scripts only ever
  send data to it — they cannot write directly.
- Every message from a content script to the background worker must
  have its sender/origin verified before being acted on.

**Updated 2026-09-10 (centralization):** the rule above now applies
literally, not just to content scripts — `popup/App.tsx` and
`options/App.tsx` never import `providers/*` directly; every provider
call (`authenticate`, `createSheet`, `readRow`, `readCells`,
`updateCell`, `setApplicationStatus`/`cancelApplication`) is a message to the background worker, which is
the sole caller of the `SpreadsheetProvider`. This closed a real
finding: `options/App.tsx` previously called
`authenticate()`/`createSheet()` directly from the options page's own
realm, out of reach of the background worker's in-memory locks (it
also closed a cross-realm race on the since-removed Excel token). As a
side effect, Undo/Edit
from the popup are now robust to the popup closing mid-action — the
write is already in motion in the background worker and completes
independent of the popup's own lifetime, where before, closing the
popup mid-request killed the in-flight call along with it.
- Extension pages (popup, options) reach the background worker
  through one shared internal-RPC contract, validated by
  `sender.origin === chrome-extension://<this extension's own id>`,
  checked separately from the content-script `TRUSTED_ORIGINS` check
  above — see `background/messageRouter.ts` for the message list
  (`CONNECT_PROVIDER`, `RECONNECT_PROVIDER`, `SAVE_RESUME_VERSION`,
  `SET_STATUS` (which replaced `CANCEL_APPLICATION` on 2026-09-14),
  `GET_LIVE_STATUSES`, `GET_NOTE` and `SAVE_NOTE` (the note editor,
  2026-09-15), `SWITCH_TO_PREVIOUS_SHEET` and `REFRESH_SHEET_TITLE`
  (Settings' sheet actions, 2026-09-17), and `OPEN_SETTINGS`, which
  opens the Settings window rather than calling a provider) and envelope shape (`{ ok: true, data } |
  { ok: false, error, code? }`). Two other fields were tried first and
  found not to actually test this, confirmed live against a real
  Chrome instance with a real loaded extension rather than assumed:
  `sender.id` identifies which *extension* sent a message, not what
  *kind* of context sent it — this extension's own content scripts
  share the same id. `sender.tab` is set for both a content script
  *and* this project's own options page, since `options_page` opens
  as a genuine browser tab rather than an embedded surface — a real
  test confirmed the options page's `sender.tab` was populated just
  like a content script's, which would have made a `!sender.tab`
  check reject every real `CONNECT_PROVIDER`/`RECONNECT_PROVIDER`
  message from it. `sender.origin` is the field that actually
  differs: an extension's own page always reports its own
  `chrome-extension://<id>` origin, while a content script's
  `sender.origin` is the origin of the *web page* it's injected into
  — not something a compromised page script can forge, same trust
  basis the `TRUSTED_ORIGINS` check already relies on.
- **Convention, not just architecture: popup/options never import
  `providers/*` directly — always message background.** No lint rule
  enforces this yet; it's a discipline convention until/unless one is
  added.

**Data going into the spreadsheet**
- **Formula injection is the top real risk here.** Any scraped field
  (job title, company name, etc.) that starts with `=`, `+`, `-`, or
  `@` must be neutralized (force plain-text cell formatting, or
  prefix with a safe character) before being written — otherwise a
  malicious or malformed page could inject a formula that executes
  when the user opens their sheet.
- All scraped fields are validated and length-capped before being
  passed to the provider's structured API request format — never
  string-concatenate raw scraped text into a request body.

**Fixed 2026-09-14 (payload validation):** the background trusted a
content script's payload shape once its origin passed; `sanitizeRow`
only trimmed and capped strings, and a non-string would have thrown
there. Now `parseJobPostingData` (`lib/jobPayload.ts`) checks
`JOB_APPLICATION_LOGGED` and `JOB_APPLICATION_PENDING` payloads before
anything is queued, recorded or written: title and company non-empty
strings of at most 500 characters, location a string of at most 500 or
null, url an `https://` string of at most 2048; anything else is
rejected with a console line, and only those four fields are kept.
`SAVE_RESUME_VERSION` refuses a `resumeVersion` that isn't a string of
at most 500 characters (the popup's input stops at 500) before reading
or writing. **Verified 2026-09-14 in Node only**
(`tests/background.test.ts`): 11 malformed `JOB_APPLICATION_LOGGED`
payloads (null, a string, a numeric title, a blank company, a numeric
or 501-character location, a missing location, `http:` and `javascript:`
URLs, a 501-character title, a 2066-character URL) and a malformed
pending one made no request and no queue, pending or notification
write, and a valid payload then logged; a numeric and a 501-character
`resumeVersion` were refused with no request, and a string was saved.

**Verified 2026-08-28 (Phase 3):** `GoogleSheetsProvider.appendRow`'s
`RAW`-input-mode-only formula-injection defense (no character-
prefixing) was confirmed against a real write, checked via the
formula bar (not just cell display) for all four dangerous prefixes
(`=`, `+`, `-`, `@`) — every cell held the literal text, none
evaluated. No character-prefixing needed on top of `RAW` mode.

**Excel-era history (removed 2026-09-13):** in Phase 8 the Excel
provider turned out to have no `RAW`-mode equivalent: `=1+1`,
`+2+3`, `-4-5` and `@SUM(1,1)` were evaluated as live formulas until a
leading-apostrophe `neutralizeFormulaPrefix()` was added. The lesson
that stays: each backend needs its own, verified formula-injection
defense; one write path's guarantee doesn't carry over to another.

**Permissions**
- `host_permissions` scoped only to the specific job-site domains
  supported — never `<all_urls>` or broad wildcard grants. This is
  the most common reason extensions get flagged or rejected in Web
  Store review.
- OAuth scope minimal: `drive.file` only (files the extension
  creates).

**Updated 2026-09-09 (Phase 8):** removed `*://www.linkedin.com/*`
and `*://job-boards.greenhouse.io/*` from `host_permissions` —
confirmed via grep that neither content script makes any `fetch()`,
`chrome.scripting`, or `chrome.tabs` call needing host-level access;
`content_scripts.matches` alone is sufficient for injection. The
narrowest-scope principle already applied to OAuth scopes now
applies to the manifest itself — re-add only when a real feature
actually needs it, not speculatively ahead of time.

**Updated 2026-09-13:** the build plugin (crxjs 2.7.1) adds
`web_accessible_resources` to the production manifest: one entry per
content script, exposing only that script's own bundled file to its
site's origin (`https://www.linkedin.com/*`,
`https://job-boards.greenhouse.io/*` since the https-only matches of
2026-09-14, checked in the built manifest; `*://` before),
`use_dynamic_url: false`). No plugin
option turns it off, and it's accepted: a page on those two sites can
detect the extension is installed if it knows the hashed file path, and
nothing else is exposed. A Vite dev-server build instead exposes every
file to every site (`<all_urls>`, `**/*`), so upload zips come only from
`npm run package` (`scripts/package.mjs`), which pins exactly those two
entries.

**Manifest / build**
- Manifest V3 from day one.
- No `eval()`, no remotely hosted or inline scripts — required for
  Web Store approval, not just best practice.
- All API calls over HTTPS via the official SDKs — no manual
  `http://` fallbacks anywhere.

**Supply chain**
- `npm audit` run regularly; Dependabot enabled on the repo once
  it's on GitHub. A compromised dependency in a browser extension is
  a real, checked-for risk, not a theoretical one. Configured
  2026-09-11: `.github/dependabot.yml` (npm, weekly). Dependabot
  security alerts are a separate switch in the GitHub repo's settings.
- **Dependabot hold (2026-09-13):** don't merge the open PRs #1-#5
  without approval. #5 is React 19 (`react`, `react-dom` and their
  types), which is shipped code; #1, #2 and #4 are major lint upgrades
  (eslint 10, eslint-plugin-react-refresh 0.5, @eslint/js 10); #3 is
  @types/chrome 0.2.9 (types only). A vite 5 to 6 PR, if one opens, is
  held too (crxjs compatibility unchecked).

**Explicitly not applicable** (would apply if this had its own
backend/database, which it deliberately does not): login rate
limiting, bot protection, password hashing, row-level DB security,
session cookie handling, file upload restrictions. Identity is
delegated entirely to Google OAuth by design.

---

## Tech stack

- TypeScript, Vite + `crxjs`, React (see `package.json`) — same
  Vite-based toolchain as the existing stat-tracker frontend, for
  consistency with other projects.
- `chrome.storage.local` for the offline write queue and cached
  recent-applications list.
- No custom backend server — Google's APIs are the only external
  service this talks to. (Not a Python project — no `venv`
  involved; isolation is the standard Node `package.json` /
  `node_modules` boundary.)
- Tests (added 2026-09-14), with no extra dependencies: `npm test`
  bundles `tests/*.test.ts` with the esbuild that comes with Vite and runs
  them with `node:test` (the background worker against faked chrome,
  fetch and navigator; Greenhouse pending applications; since 2026-09-15 the
  popup's list and summary line, and the colour tokens in both themes), then
  `tests/dom/popup.test.mjs`, which builds the extension and drives the
  built popup in headless Chrome through a stand-in chrome API (keyboard,
  scroll and Edit-window fit; since 2026-09-15 both themes, waiting rows,
  the note editor and Settings at 440px). It skips itself when Chrome isn't
  found.
  `npm run test:node` runs only the Node parts. The storage fakes
  deep-clone on every get and set, per the 2026-09-09 lesson. Since
  2026-09-16 the DOM tests' stub waits for the condition each step needs
  (the menu open, focus moved, the editor gone, the stub's answers all in)
  rather than for a number of milliseconds, with one 4-second deadline and
  a message naming what it waited for: a fixed 80 ms wait for a dropdown to
  open had failed about once in four runs. Same lesson as `f4e6bd6` for the
  background tests: no test depends on wall-clock timing.

---

## Deployment path (Chrome Web Store)

See the `web-store-deploy` skill (`.claude/skills/web-store-deploy/SKILL.md`)
for the submission steps and current status (privacy policy: done,
published 2026-09-09).

**Store item (2026-09-14):** Ryan uploaded the no-key zip as a draft.
Item ID `mhldoocgadblnnelahaplfdnaoiehafj`, listed Public once
submitted. Its public key is `manifest.config.ts`'s `key` (public by
design), which pins every build, unpacked ones too, to that ID; the old
unpacked ID `hopcbbifbonofhibjgdkogmbnocaghmg` is retired once Ryan
removes that install. `scripts/package.mjs` fails a `--allow-key` build
whose key doesn't derive this ID (SHA-256 of the DER key, the first 32
hex digits mapped to a-p), and every upload from now on uses
`npm run package -- --allow-key`. Sign-in on the new ID passed live on
2026-09-14, so the OAuth client's Item ID points at it (web-store-deploy
step 5).

**Live on the new ID (2026-09-14, web-store-deploy step 6, first
pass):** the reviewer drove LinkedIn in Ryan's Chrome; Ryan did Connect.
Google sign-in worked; an Easy Apply click made before Connect was queued,
and Connect saved it ("Saved 1 waiting application"); from `/feed/`,
LinkedIn's own Jobs navigation (no reload) to an in-app search result, the
content script was present and caught the trusted click; `/jobs/view/`
and `/jobs/search-results/` clicks logged; the sheet held exactly the 2
expected rows, fields correct, formatting intact. The 24-hour repeat skip
wasn't verified live (see Logging behavior). The `dist/` Ryan's Chrome
loaded had been built from the `workday` branch (`4f51b92`, which includes
main's `8f18d83`) by one of my test runs: `npm test`'s popup test and
`npm run package` both rebuild `dist/` in the working directory, and Chrome
loads the unpacked extension from there. Lesson: while Ryan runs a build
from this directory, builds and tests run in a separate copy, and `dist/`
is rebuilt from main on purpose, not as a side effect.

**Declined 2026-09-16 (Ryan): the rest of step 6's live checks weren't
run.** He chose not to run the popup's status and resume changes, the
stale-row refusal, the notification's Edit window, the 24-hour repeat
skip, the sheet trash/restore/create flow, the sign-in-lost flow, or
offline. So those paths are **verified in Node and headless renders only**
— not live — and this file's notes on them say as much where they were
written. They stay on web-store-deploy's step 6 list rather than being
struck off, and step 8 runs them again on the installed store build,
which is the first live run they would get.

**Fixed 2026-09-14 (one sheet per Connect):** two "Job Applications"
sheets were created that day, 20 minutes apart. Checked every path: a
double click on Connect in one Settings page can't send two (the click
swaps Connect for a disabled "Connecting…" button in the same render); a
Settings window plus the options tab from chrome://extensions could each
send one at once, and a page opened before a Connect kept showing Connect
afterwards, so a later click there created a second sheet and swapped it
in (`CONNECT_PROVIDER` always created one); a Connect whose spreadsheet was
created but whose header write or formatting then failed leaves that sheet
orphaned when "Try again" creates another (not fixed, no evidence it
happened); and removing and re-adding the unpacked extension wipes its
storage, so the next Connect creates a new sheet (expected). Now
overlapping Connects share one run, and a Connect with a sheet already
connected signs in and keeps that sheet (`background/messageRouter.ts`).
Which path made the second sheet isn't known; the 8:07 PM sheet's contents
would tell (formatted with headers: a completed Connect, from a stale page
or a re-add; no header row: a failed one).

**Fixed 2026-09-17 (four-agent audit of `9a215e8`).** Findings 1-6 of that
audit, in the order they were fixed. Each has a Node or headless test that
fails without its fix (checked by reverting the fix and re-running):
- **Checking another sheet flagged the connected one** (the high one, and a
  real bug reachable from the UI). `getActiveProvider()`'s wrapper sets and
  clears `sheetStatus`, which describes *the connected sheet*, for whatever
  sheet the call was made on — so a switch back to a previous sheet that had
  been trashed marked the sheet the user was actually using as trashed:
  writes froze, `SET_STATUS`/`SAVE_NOTE` were refused and a notification and
  banner fired, until the next 5-minute tick cleared it. `sheetHealth` now
  takes `{ connected }`, and a check on any other sheet goes through
  `otherSheetProvider` (`providers/activeProvider.ts`), which reports a
  sign-in failure — that's account-wide — and nothing else.
- **A swap in flight could send a row to the abandoned spreadsheet.** A
  write picks its sheet and then spends a real round trip on it; a swap
  landing in that window wrote the row to the file the user had just left,
  with its recent-list entry pointing at a row number there, while Settings
  said "saved 0". Now `background/sheetSwap.ts` marks a swap in progress and
  both writers check it and the stored id before appending: a direct log
  queues the row (the drain writes it to the new sheet), and a drain stops
  the pass and leaves the rest queued. Known remaining window, recorded in
  that file: a writer already past the check can still have a swap complete
  during its append.
- **A failing Drive call broke three features.** `sheetHealth` threw
  anything that wasn't a 404, so an unreachable Drive (a 500, a timeout)
  failed Connect, "Create a new sheet" and the switch back entirely. A
  failure of the trash check alone now reads as healthy — trash detection is
  what's lost for that call, not the feature, and the next check notices.
  A failure to *reach* the sheet still throws, so nothing is replaced on a
  network failure, and a sign-in failure still throws, since Settings offers
  Reconnect for it.
- **Crash-safety around a swap.** `previousSheetRef` was written before
  `sheetRef`, so a worker killed between the two writes came back with
  previous === connected, and Settings offered a "switch back" that would
  clear the recent list to arrive where it already was. Both refs now move
  in one `chrome.storage.local.set` with the new sheet first
  (`setSwappedSheetRefs`), a switch to the sheet already connected is
  refused, and a Settings request that fails re-reads storage before
  offering "Try again": if a sheet is connected now, the card shows it
  instead. **That last one is the likely cause of the two sheets of
  2026-09-14** above: a Connect that created a sheet and then lost its
  answer (a killed worker answers with a rejected `sendMessage`) left
  Settings showing an error whose "Try again" created a second one.
  Still open: a worker killed *inside* `createSheet`, between the create
  call and the header write, leaves an orphan sheet nothing knows about.
- **The Summary tab's grid id was hardcoded and sent blind.** `addSheet`
  fails the whole batch if the id is taken, which would take the header row
  and formatting with it; the id is now derived from the id the
  applications tab actually came back with (`summarySheetIdFor`).
- **`CREATE_NEW_SHEET`'s in-flight sharing ignored `replaceHealthy`,** so a
  plain request — which must be refused while the sheet is healthy — could
  be answered with a deliberate swap's brand new sheet. The run is now
  shared only with a request that asked for the same thing.

**Also 2026-09-17, from the same audit:**
- **The notification Edit window's skipped identity check expires.** That
  window is opened from a notification that lives about five seconds, but
  nothing closes the window, and its Save skipped the Company/Title check
  forever — a blind positional write to a row the user may have sorted
  since. The skip is now honoured only within 10 minutes of the application
  being logged; past that the write still goes through, it just has to
  prove the row first.
- **Settings discloses what the extension reads, in the product.** One line
  above Connect ("the job's title, company, location and link from the page
  you apply on"), and the same under Supported sites once connected:
  Google's Limited Use guidance wants that disclosure where access is
  granted, not only in the privacy policy.
- **The store summary is derived from the supported sites.**
  `manifest.config.ts` builds the description's site list from the
  `SITES` array that also defines the content scripts, and
  `scripts/package.mjs` fails a build whose description names a site with
  no matching content script (or a name it has no host for). The audit
  found `ats-lever-ashby`'s manifest promising Workday, which that branch
  doesn't implement; the check is on `main` so every branch inherits it.
- **Store screenshots rebuilt full bleed** (`store-assets/listing.md` has
  how): the page fills 1280x800 with no card, border, shadow or margin.

**Two of the audit's low findings were considered and not taken:**
- **Verifying the tab's title by `sheetId` before every write.** With a
  second tab in the spreadsheet, a user who renames the applications tab
  *and* gives its old name to the Summary tab would have rows written into
  the Summary tab, silently — the rename recovery only fires on a 400 that
  no longer happens once some tab answers to the stored name. Not fixed:
  it needs the tab list read before writes (an extra API call per apply, or
  a per-session cache and a new storage key), the precondition is two
  deliberate renames that swap two names, and the damage is visible in the
  sheet and recoverable (the Summary tab is disposable by design). Recorded
  under Deferred.
- **Dropping `locale: 'en_US'` from the created spreadsheet.** It's pinned
  so the Summary tab's comma-separated formula arguments parse as written,
  and it also forces US dates and decimals on the user's own file. Whether
  `userEnteredValue.formulaValue` is locale-independent isn't something
  this project can settle without a real API run in a non-US-locale
  account, and Ryan has declined the real-sheet runs. Kept, with the
  trade-off recorded under Deferred: the cost is a US default in a file the
  user can change themselves (our Date column carries its own explicit
  format), and the risk of guessing wrong is broken formulas in every new
  sheet.

---

## Build phases (propose and confirm each before starting)

1. **Scaffold** — Vite + crxjs + TS project skeleton, Manifest V3
   config with minimal permissions, empty background worker/popup/
   options page that build and load in Chrome.
2. **LinkedIn parser** — detection, field extraction, Apply-click
   listener. Verified against multiple real postings.
3. **SpreadsheetProvider interface + GoogleSheetsProvider** — auth
   flow, auto-create sheet, append row. End-to-end: LinkedIn apply
   click → real row in a real Google Sheet.
4. **Popup toast + Undo/Edit** — the 5-second correction window.
5. ~~**Indeed parser**~~, then **Greenhouse parser** — prove the
   abstraction generalizes.
6. ~~**ExcelProvider**~~ — built 2026-09-08, removed 2026-09-13 (see
   Spreadsheet backend).
7. ~~**Existing-sheet linking + column auto-mapping.**~~ Descoped
   2026-09-08 — see "Sheet setup" above. Auto-create-only confirmed
   working end-to-end since Phase 3; nothing shipped from this phase.
8. **Security pass** — formula-injection sanitization, permission
   audit, `npm audit`, manifest CSP check — before any Web Store
   submission. Started 2026-09-09; see Security section's Phase 8
   notes above for the `host_permissions` cleanup (the Excel
   formula-injection fix left with Excel). `npm audit`
   (2 findings, both `vite`/`esbuild`, dev-only, don't ship; re-run
   2026-09-11: `npm audit --omit=dev` finds 0, and the full audit's 1
   high is `vite` and 1 moderate is `esbuild`, both build tooling that
   isn't in the shipped extension) and
   manifest CSP (no override at all — Chrome's own MV3 minimum
   applies, already the strictest possible outcome) reviewed with no
   action needed. Privacy policy page (Phase 9 prerequisite) done
   2026-09-09 — see Deployment path above for the live URL.
9. **Web Store prep** — listing assets, submission. Privacy policy
   already done (see Phase 8/Deployment path above). Status
   2026-09-11: listing text, screenshots and privacy-practices answers
   are in `store-assets/`; the privacy policy was updated 2026-09-11.
   A pre-submission audit is in progress (promo tile, store icon
   padding, full-bleed screenshots, Dependabot, pre-commit secret
   check, public logging, version). Submission follows the
   extension-ID sequence in the `web-store-deploy` skill.
   Status 2026-09-13: Excel/OneDrive support removed (`7727a9a`); new
   sheets get the fuller formatting (`d2735ff`); the popup and Settings
   restyled, with the Settings window and live status chips
   (`9d6fbbb`); the "needs reconnect" sign-in warning (`88816bf`,
   verified in Node only); minimum Chrome 110; and the privacy policy
   and listing rewritten for Google Sheets only. Still to do before
   submission: queued rows into the recent list plus a drain on Connect,
   a visible notification-Undo failure, the store screenshots rebuilt
   for the new popup and sheet, and a packaging script (a zip with no
   `key`, plus a contents check). Then the extension-ID sequence, which
   waits on Ryan's developer account.
   Later 2026-09-13, that list is done: queued rows into the recent
   list, the drain on Connect and the visible Undo failure (`ec2600e`);
   `npm run package` (`11f95ef`); and the store screenshots, two
   rendered ones of the popup and Settings (`078e7cf`, `9273876`), with
   a sheet screenshot optional. What's left is the extension-ID
   sequence in the `web-store-deploy` skill.
   Status 2026-09-14: Ryan wants Workday in v1, so the submission (step
   8) waits for the `workday` branch to be merged, after his observed
   application pins its Submit selector (Site parsers, Workday, on the
   `workday` branch until it merges). The extension-ID steps continue on
   `main`. The zip built at `838aa00` has no Workday and isn't the one to
   submit: the final zip is built from `main` after the merge
   (`npm run package -- --allow-key`), at version 1.0.0 unless the
   dashboard refuses a second upload at that version (then 1.0.1). Step 8
   lists what changes at the merge.

**Deferred, not abandoned:**
- **A write can land in the wrong tab after two deliberate renames
  (2026-09-17, audit):** every range names `sheetRef.sheetName`, and the
  recovery that re-reads the tab's title by `sheetId` only fires on the
  400 a name that matches nothing produces. Rename the applications tab and
  give its old name to the Summary tab and writes go to the Summary tab
  with no error. The fix is verifying the title by `sheetId` before a write
  — one extra API call per apply, or a per-session cache with a new storage
  key. Not done: the precondition is two deliberate renames, and the damage
  is visible and recoverable.
- **`locale: 'en_US'` on the user's new spreadsheet (2026-09-17, audit):**
  pinned at creation so the Summary tab's formulas parse, and it also sets
  US dates and decimals in a file that's the user's own. To settle it:
  create two throwaway sheets from a non-US-locale account, one pinned and
  one not, and see whether the Summary formulas land in both. Until then
  the pin stays.
- **The background test fake only answers open-ended column ranges
  (2026-09-17):** its `columnRead` matches `!X2:X`, while `readCells` asks
  for a bounded range (`B2:B2` for a single row), so a live-status read
  through the message router comes back empty in tests. That's why the
  Status-default check asserts on `matchLiveStatuses` directly rather than
  through `GET_LIVE_STATUSES`. Teaching the fake to answer bounded ranges
  would let those paths be tested end to end; noted, not fixed.
- **Indeed parser (2026-09-01):** every fetch attempt (curl and
  WebFetch) was blocked outright by Cloudflare bot-detection, unlike
  LinkedIn and Greenhouse — meaning literally zero pre-implementation
  selector verification was possible, only live DevTools work from
  scratch. Deprioritized in favor of Greenhouse, which had real,
  fetchable, multi-company evidence available immediately. Revisit
  when there's appetite for a parser built entirely from live
  browser inspection with no pre-verification step at all.
  **Retried 2026-09-16 with headless Chrome** (the renderer the DOM tests
  use), and it changes nothing: the search page, `viewjob`, `ca.indeed.com`
  and `smartapply.indeed.com` all answer `HTTP/2 403` from Cloudflare's
  edge, before any page renders, serving a static `PAGE_TYPE:"waf_block"`
  page titled "Blocked - Indeed.com" ("Your request has been blocked.").
  It's a WAF block, not a solvable challenge, and not headless detection.
  `job-boards.greenhouse.io` and `jobs.lever.co` resolved from the same
  machine in the same minutes, so it's Indeed, not the network. Nothing
  was proxied around the block. So still **zero selectors confirmed**;
  the ones in third-party scraping guides are hearsay, which is what the
  working agreement rejects. Four unknowns block a parser: every
  title/company/location/`jk` selector and whether the DOM is hashed;
  whether Apply navigates, opens a modal or iframes smartapply; whether
  `/beta/indeedapply/form/post-apply` (publicly indexed as the
  post-submission step) is a real navigation or an SPA pushState, which
  decides whether a content script can see it at all; and that the click
  would be on `www.indeed.com` while the confirmation is on
  `smartapply.indeed.com` — cross-origin two-phase logging, which
  `lib/pendingApplications.ts` can't express today (it scopes pending
  entries by origin), so that's an architecture change, not a new parser
  file. Indeed's `robots.txt` also disallows `/viewjob?` and
  `/applystart` for all agents. The only honest way in is a read-only DOM
  dump Ryan captures himself in his own Chrome on one public posting,
  which sidesteps the IP block; even then the final submit control and
  the confirmation signal stay unverifiable until a real application, the
  same residual gap Greenhouse had.
- **appendRow isn't idempotent (logged 2026-09-11):** if `appendRow`
  succeeds on Google's side but the client times out
  (`lib/fetchWithTimeout.ts`, 30s then, 20s since 2026-09-14), `handleJobApplicationLogged`'s catch
  queues the same row and the next `drainOfflineQueue` appends it again.
  Not observed in practice, but the path is real. A queue retry reuses
  the row, so the duplicate has the same Date. Since 2026-09-11 Sheets
  stores Date floored to the minute, so an identical Date no longer
  proves a retry: two clicks in the same minute look the same. Needs a
  design decision before any fix (e.g. a per-message id checked before
  re-appending). Pick up after Phase 9. Fixed 2026-09-14 for new sheets
  by the hidden Log ID column (Sheet setup); a sheet without it keeps
  this behaviour.
