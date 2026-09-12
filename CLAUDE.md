# Job Application Tracker — Browser Extension

## What this is

A Chrome extension (Manifest V3) that detects when the user submits a job
application on a supported job site, automatically extracts the relevant
data (title, company, URL, date), and logs it to the user's spreadsheet
(Google Sheets or Microsoft Excel/OneDrive) with no manual data entry.
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
- **Commit and push regularly.** Repo:
  https://github.com/rynjung1/job-app-tracker. Commit at meaningful
  checkpoints as work progresses (e.g. after each build phase below,
  or after any working, testable increment) — not just once at the
  end of a session. Push after each commit so the remote stays
  current.

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
   - Passively extracts title / company / location / posting URL as
     soon as the page (or SPA route) settles — use a
     `MutationObserver`, not a fixed timeout, since LinkedIn/Indeed
     render content dynamically.
   - Listens for a click on that site's real "Apply"/"Submit
     application" button (site-specific selector, defined per
     parser) as the logging trigger.
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
background worker's own realm; no popup/options caller exists for it
(contrast the still-cross-realm `MS_TOKEN_KEY` question below, where
the same kind of flag would not be sufficient).

Paired with a real fetch timeout, added because it didn't exist at
all — confirmed via grep of `googleSheets.ts`/`excel.ts`/`msAuth.ts`
before writing `lib/fetchWithTimeout.ts`. 30 seconds: comfortably
above any real Sheets/Graph/token-endpoint call this project has
actually observed, and comfortably below both `RETRY_ALARM_NAME`'s
5-minute period and Chrome's own documented 5-minute single-request
service-worker kill threshold — a deliberate margin under both
ceilings, not a number picked to match either one. This shrinks the
window the `isDraining` guard needs to cover, it doesn't replace it —
a stalled request now fails within 30s instead of indefinitely, but
the guard is still what actually prevents the double-append during
that window.

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
  `apiFetch`/`graphFetch` checks `res.ok` on the very first line
  after every call, this would have broken every Google Sheets and
  Excel write in production — worse than the bug the fix existed to
  close. Missed by three initial verification passes because all
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

A separate, still-open finding from the same investigation:
`msAuth.ts`'s `MS_TOKEN_KEY` read-modify-write has no locking either,
and — unlike `drainOfflineQueue` — it's called from multiple JS
realms (background *and* any extension page), so an in-memory flag
like `isDraining` would not fix it; `withStorageLock` wouldn't either,
since its `tail` promise chain is module-scope and each realm gets
its own independent instance. Reproduced concurrently: two realms
racing to refresh the same Excel refresh token both succeed today
(Microsoft's own docs: refresh tokens aren't revoked on reuse) but
silently orphan one of the two newly-issued refresh tokens — not a
hard failure currently, but correctness resting on an external,
changeable API behavior rather than anything this codebase controls.
Not fixed here — the real fix is collapsing every provider call
(popup, options, background) into the one realm that already holds
the lock pattern, tracked as separate follow-up work, not something
this commit's guard extends to.

**Fixed 2026-09-10 (later the same day, after centralization):** the
`MS_TOKEN_KEY` race above is now actually closed, not just made
closeable. Centralizing every provider call into the background
worker's one realm (see Trust boundary, below) removed the
*cross-realm* instantiation problem, but a single realm can still
race — two concurrent message handlers (e.g. `CANCEL_APPLICATION`
arriving while `drainOfflineQueue`'s alarm is mid-flight) are two
independent async chains that can still interleave at their own
`await` points. Fixed with a new dedicated `lib/msTokenLock.ts`
(`withMsTokenLock`) — deliberately not a reuse of `withStorageLock`:
that lock's own design comment justifies one shared lock specifically
because `OFFLINE_QUEUE_KEY`/`RECENT_APPLICATIONS_KEY` operations are
fast (a few ms of storage I/O); Excel token refresh is a real network
round trip, up to `FETCH_TIMEOUT_MS` (30s) in a slow case, and sharing
the existing lock would let a slow Excel refresh stall an unrelated,
fast `queueRow`/`addRecentApplication` call for no reason. Both
`getValidExcelToken` and `forceRefreshExcelToken` wrap their **entire**
body in the lock, including the fast path (cached token still valid) —
not just the refresh-and-write branch, a real distinction caught during
review: the race is two callers each *deciding* whether to refresh
from their own independent read, not just an unsynchronized write, so
every caller needs to go through one serialized queue and re-read
the token once it acquires the lock, rather than each deciding from
whatever it happened to read first. Verified against the real,
bundled `msAuth.ts` (not a re-derivation), mocked Microsoft token
endpoint honoring the real documented reuse-doesn't-invalidate
behavior: two concurrent `getValidExcelToken()` calls on an expired
token now produce exactly one real exchange, both callers converging
on the same resulting access token, where the pre-fix version
produced two independent exchanges and silently orphaned one refresh
token. A second, mixed-pair check (`getValidExcelToken` +
`forceRefreshExcelToken` concurrently) confirmed the lock serializes
correctly with no deadlock — two exchanges there is the *correct*
outcome, not a bug, since `forceRefreshExcelToken`'s whole contract is
unconditional refresh regardless of current validity.

3. **Popup + options page**
   - Popup: shows a toast-style confirmation for ~5 seconds after an
     auto-log ("Logged: Shopify — Data Engineer Co-op — [Undo]
     [Edit]"), plus a scrollable list of recent applications.
   - Options page: choose spreadsheet backend, authenticate,
     auto-create a sheet (the only supported setup path — see "Sheet
     setup" below), enable/disable individual site parsers.

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

Undo marks the row `Status: Cancelled` rather than deleting it —
safer against the row having shifted if the user has since
sorted/edited the sheet by hand; a wrong cell getting mislabeled is
recoverable, a wrong row getting deleted is not. `Cancelled` is a
fifth `Status` value alongside the four in the Status field section
below.

**Verified 2026-09-01 (Phase 4):** all of the above confirmed against
real applications, not just a clean build — real screenshot of the
`chrome.notifications` toast appearing after a real Apply click
("Logged / Kepler Communications Inc. — Embedded Software Engineering
Intern...", Undo/Edit buttons present); Undo confirmed setting
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

### Spreadsheet backend (locked decision: support both)

A `SpreadsheetProvider` interface decouples the rest of the extension
from which backend is active. See `src/providers/types.ts` for the
current interface.

**Updated 2026-09-09:** `readRow` added — reads an entire row back as
a header-keyed record, same shape as `appendRow`'s `row` parameter.
Not part of the original interface; added specifically so the
popup's Edit/Undo-from-the-recent-list feature (see Logging
behavior, below) could verify a row still matches its cached
identity before overwriting it — `updateCell`/`cancelApplication`
are blind positional writes by `rowNumber` with no built-in
verification, which was an acceptable, explicitly-accepted risk for
the notification's ~5-second window but not for a popup action
reachable indefinitely. Implemented in both providers by reading the
row's current headers first (for column order/width), then a single
range read across that row — `googleSheets.ts` mirrors `readHeaders`'
own `1:1`-style range exactly, just targeting `rowNumber:rowNumber`;
`excel.ts` computes the row's full column span from `readHeaders`'
length and reads `A{rowNumber}:{lastCol}{rowNumber}`. A row number
past the sheet's actual filled extent doesn't error on either API —
both just return empty values, which naturally fails the identity
check downstream rather than needing separate not-found handling.

**Updated 2026-09-09:** `SheetRef` gained `sheetId?: number`,
Google-only — the numeric grid id (not the string `sheetName`),
captured at `createSheet` time. Needed because `batchUpdate`'s
formatting requests (`repeatCell`, `addConditionalFormatRule`,
`setDataValidation`, `updateDimensionProperties` — see "Sheet
setup" below) all address ranges by this numeric id, which nothing
had needed to capture before new-sheet formatting existed. Same
additive, optional pattern as the Excel-only fields below.

**Updated 2026-09-08:** `mapColumns` removed — it existed only for
existing-sheet linking (Phase 7), which was permanently descoped
(see "Sheet setup" below); it had no remaining caller. `SheetRef`
also gained two optional, Excel-only fields not shown above:
`tableId` (the Excel Table's id, captured at `createSheet` time)
and `webUrl` (the driveItem's real web URL — unlike Sheets'
predictable `docs.google.com/spreadsheets/d/{id}/edit`, OneDrive/
SharePoint URLs are account-specific and can't be constructed from
the item id alone). Both are additive and optional;
`GoogleSheetsProvider` never sets them, and every provider-agnostic
caller treats `SheetRef` as an opaque token.

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

Two implementations:
- `GoogleSheetsProvider` — Sheets API v4, OAuth via `chrome.identity`,
  scope limited to `drive.file` (extension can only touch files it
  created — required for a clean Web Store review).
- `ExcelProvider` — Microsoft Graph API, scope limited to
  `Files.ReadWrite.AppFolder` (folder-scoped, not per-file like
  Google's `drive.file` — the app can only see its own
  `Apps/Job Application Tracker` OneDrive folder).

**Verified 2026-09-08 (Phase 6):** `ExcelProvider` implemented and
tested end-to-end against a real personal Microsoft account. Real
findings, not assumptions:
- **Not literally MSAL.** "OAuth via MSAL" in earlier notes meant
  the MSAL *protocol pattern*, not the `@azure/msal-browser` SDK —
  that library's browser-feature-detection assumes a `window`
  global and does not run inside an MV3 service worker (confirmed
  against a real open issue on the library). Implemented instead as
  a hand-rolled PKCE authorization-code flow
  (`providers/msAuth.ts`) driven by `chrome.identity.launchWebAuthFlow`
  — same small, auditable, fetch-based shape as `googleSheets.ts`,
  no new SDK dependency.
- **Authority is `consumers`, not the tenant ID.** The app is
  registered "Personal Microsoft accounts only"; the Directory
  (tenant) ID shown in the Azure portal's Overview blade is never
  used at runtime — a tenant-ID authority explicitly does not
  support personal accounts. `/authorize` and `/token` both use
  `https://login.microsoftonline.com/consumers/...`.
- **Platform type is "Mobile and desktop applications," not "SPA."**
  A redirect URI registered under SPA gets a hard 24-hour
  refresh-token expiry requiring genuine daily interactive re-auth —
  incompatible with the silent-background-refresh architecture this
  extension already relies on. "Mobile and desktop applications"
  (public client, "Allow public client flows" = Yes) gets a 90-day
  rolling refresh token as long as it's used at least once every 24
  hours, which the existing 5-minute `chrome.alarms` retry loop
  satisfies for free. `offline_access` must be in the requested
  scope string for a refresh token to be issued at all — it's a
  standard OIDC scope, not a Graph permission, so it does not appear
  under API permissions in the portal.
- **`Files.ReadWrite.AppFolder` does cover `tables/rows` writes on
  a personal account**, despite Microsoft's own permissions
  reference table listing that specific endpoint as "Not supported"
  for delegated personal accounts. Confirmed empirically with a real
  201 and a real appended row before trusting the docs either way —
  the docs may be stale or incomplete here.
- **The AppFolder must be lazily initialized before path-addressed
  file operations work.** A `GET /me/drive/special/approot` call is
  what creates `Apps/<app name>` on a OneDrive that's never used
  this app before (confirmed both via Microsoft's own docs and a
  real 404 without it); `createSheet` always makes this call first.
- **`createSheet` uses a timestamped filename**
  (`Job Applications ${Date.now()}.xlsx`), not a fixed one — Graph's
  conflict-behavior handling for the content-upload-by-path PUT
  endpoint specifically was unclear/contradictory in what was found
  researching it, so this sidesteps the question by guaranteeing the
  path never collides, matching `GoogleSheetsProvider.createSheet`'s
  own guarantee of never silently overwriting an existing file.
- **`appendRow`'s `rowNumber = index + 2` conversion is empirically
  verified, not just derived.** Graph's `rows/add` response returns
  an `index` 0-based within the table's data rows, not an absolute
  worksheet row; since `createSheet` always anchors the table's
  header at row 1, data row 0 sits at worksheet row 2. Tested against
  3 real sequential appends (indexes 0, 1, 2 → rows 2, 3, 4, all
  correct), then `updateCell` was tested against one of those real
  rows with a separate, independent range read afterward (not
  reusing `readHeaders`/`appendRow`/`updateCell` internals) — the
  correct row's correct cell changed, adjacent rows untouched.
- **Fresh personal OneDrive accounts can need provisioning first.**
  A never-used personal Microsoft account's OneDrive can return a
  503 `itemDisabledDueToPendingProvisioning` error until the drive
  has been opened at least once via onedrive.com — noted here as a
  known setup step, not independently re-verified against Microsoft
  docs (found via direct testing, not a documentation citation).

**Fixed 2026-09-09 (auth parity, found during a test pass):**
`ExcelProvider` previously had only proactive, clock-based token
refresh (`getValidExcelToken`, refreshing ahead of its local
`expiresAt`) — no reaction to an actual 401 from Graph, unlike
`GoogleSheetsProvider`'s `withAuth`. A server-side revocation the
local clock couldn't predict (the user revokes access in their
Microsoft account) failed identically and permanently on every
subsequent call until the user happened to hit Reconnect for an
unrelated reason. Fixed by adding a `withAuth` to `excel.ts`
mirroring Google's exactly: one retry on a literal 401, forcing a
token refresh via a new `forceRefreshExcelToken()` in `msAuth.ts`
(the refresh-token exchange itself was already fully built for the
proactive path — extracted into a shared `refreshExcelToken()` both
call, nothing new needed for the actual HTTP call). Not caught if
the refresh token itself is also revoked — that throw (a real
`invalid_grant` from Microsoft) propagates straight out, same as
any other unrecoverable failure, rather than looping.

**Design choice**: every individual `graphFetch` call site gets its
own `withAuth` wrapper — not one token threaded through a whole
multi-step method like `createSheet`'s 7 calls. Matches the
granularity `googleSheets.ts` already uses, and is cheap to repeat
per call since `getValidExcelToken`'s common case is just a local
`chrome.storage.local` read, no network round trip.

**Verified 2026-09-09** against a real revoked grant, not a mocked
one — the extension's access was actually revoked from the
Microsoft account's own security settings, then a real `appendRow`
was triggered through the normal pipeline. Full real evidence
chain: the revoked token produced a real 401, `withAuth`'s retry
called `forceRefreshExcelToken`, which itself failed with a real
`invalid_grant` from Microsoft's token endpoint (revoking access
invalidates the refresh token too, not just the access token) —
that propagated cleanly into `appendRow`'s catch and the row queued
(`offlineQueue: Array(1)`), confirmed via a real
`chrome.storage.local` read, not assumed. A subsequent periodic
drain retry hit the same real error and failed clean again — no
loop, no silent hang. After reconnecting for real (a fresh
interactive `authenticateExcel()`), a real application succeeded
normally, and the previously-queued row was separately confirmed to
have drained on its own — `offlineQueue: Array(0)` — not left
stuck.

Backend selection lives in `providers/activeProvider.ts` — a stored
preference (`ACTIVE_PROVIDER_KEY`, defaulting to `'google'` for
installs that predate this existing) resolves to the active
`SpreadsheetProvider`. The options page's two "Connect" buttons set
it at connect time; the background worker and popup resolve it
per-call rather than importing either provider directly.

**Verified 2026-09-08 (Phase 6, end-to-end):** the findings above
came from direct diagnostic calls into `excelProvider`'s own
methods — real, but not proof the UI wiring or the message pipeline
actually route to it. Separately confirmed all four real paths with
Excel selected as the active provider, through the actual UI and
message pipeline, not diagnostics: clicking "Connect Excel /
OneDrive" on the options page correctly set `activeProvider` to
`"excel"` and persisted a real `sheetRef` (real `spreadsheetId` and
`tableId`); a real `JOB_APPLICATION_LOGGED` message through the
actual content-script → background → `getActiveProvider()` →
`appendRow` path landed a real row with correct values in the real
Excel file; clicking Undo on the resulting real notification set
that row's `Status` cell to `Cancelled` in the real file; clicking
Edit and saving a new Resume Version updated that row's real cell
too. No known gaps in this phase.

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

**Updated 2026-09-09:** `createSheet` applies visual formatting to
the new sheet/workbook — `createSheet`-only, never touches an
already-existing one. Column indices for all of the below are
computed from the actual `templateColumns` array passed in
(`indexOf('Status')`, etc.), never hardcoded, so this doesn't
silently break if the template's shape ever changes.

Both providers get the same real, documented treatment for:
- **Header row**: bold, white text on a `#3366CC` background —
  Sheets via one `repeatCell` request; Excel via `PATCH
  .../range/format/font` (`bold`, `color`) and `.../format/fill`
  (`color`), both confirmed exact shapes from Microsoft's own docs.
- **Column widths**: `URL`/`Notes` widened so they aren't crushed —
  Sheets via `updateDimensionProperties` (`pixelSize: 250`); Excel
  via `PATCH .../range/format` (`columnWidth: 200`). Not a
  pixel-matched value between the two — Sheets' unit is real pixels,
  Excel's `columnWidth` is its own internal width unit — confirmed
  "wide enough" by real visual inspection on both, not assumed
  equivalent from the numbers alone.

**Google-only, confirmed real capability gaps mean these do not
exist on the Excel side at all — not a corner cut, a checked fact:**
- **Status conditional formatting** — Sheets gets real, persistent
  `addConditionalFormatRule` rules (`TEXT_EQ` per value: `Offer` →
  green, `Interview` → blue, `Applied` → yellow, `Rejected`/
  `Cancelled` → red), so the color keeps re-evaluating live even if
  a value is changed by hand later, with no code involved at all.
  Checked Microsoft's own "Working with Excel in Microsoft Graph"
  reference — it exhaustively covers worksheets, tables (including
  sort/filter), charts, ranges, named items, and functions, and
  never mentions conditional formatting once. It's a real
  Excel-JS-API/Office-Scripts-only capability
  (`Excel.ConditionalFormat`) with no Graph REST endpoint. The only
  approximation would be painting a cell's fill color procedurally
  at write time inside `appendRow`/`updateCell` — rejected, since
  it'd go stale the moment a user edits Status by hand (no live
  rule watching it) and would turn this from a `createSheet`-only
  change into an ongoing write-path one. Skipped for Excel
  entirely, deliberately, not deferred.
- **Status dropdown (data validation)** — Sheets restricts the
  `Status` column to exactly the five values above via
  `setDataValidation` (`ONE_OF_LIST`, `strict: true`,
  `showCustomUi: true` for the actual dropdown chevron). `strict`
  was chosen over warn-only specifically because the conditional-
  format rules above do an exact `TEXT_EQ` match — a typo or wrong
  case would silently get no color at all, so rejecting invalid
  input outright protects that feature too, not just this one.
  Confirmed via a real Microsoft Q&A thread asking this exact
  question: *"the dataValidation endpoint is not yet implemented in
  the Graph API"* — Office.js is the only way to touch it, not
  reachable from Graph REST. Skipped for Excel entirely.

**Verified 2026-09-09:** both features confirmed with real evidence
against real newly-created sheets, not just successful API
responses. Header formatting and column widths visually confirmed
rendered correctly on both a real Google Sheet and a real Excel
workbook. On the Google side specifically: the dropdown chevron
actually renders on Status cells; selecting a value from it works;
typing a non-matching value is actually rejected (not just shown a
warning); and the conditional-formatting colors correctly fire off
dropdown-driven selections, not just typed text.

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

**Open Excel questions, to test together in one Excel session before
submission** (no Microsoft token was available on 2026-09-11):
- Whether `tables/rows` appends have the same formatting problem
  (untested).
- The Date column. `ExcelProvider` still writes the ISO string, which
  is today's behaviour, so nothing regressed. What Excel does with that
  string was never checked, and neither was the fix: writing the same
  serial through Graph with a column `numberFormat`, and whether an
  Excel table carries that format onto new rows. Not shipped untested:
  the Phase 8 formula-injection bug showed Excel's Graph write path
  doesn't behave the way the Sheets path does.

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

**Known v1 gap:** the LinkedIn Apply-button selector matches on the
English aria-label text ("LinkedIn Apply..."); a non-English LinkedIn
UI language will silently fail to detect it. Acceptable for the
single-user personal-use target — revisit before any Web Store push.

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

---

## Security (required, not optional — this is going on the Web
Store)

**Secrets & credentials**
- No API keys, client secrets, or tokens hardcoded in bundled
  extension code. Use PKCE for OAuth flows so no client secret ships
  client-side at all.
- `.gitignore` covers any local `.env`/config from the first commit;
  add a pre-commit check so a token can never land in a commit.
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
written to any future provider (e.g. Microsoft/MSAL) that doesn't
have an equivalent built-in cache. The OAuth **client ID** (not a
secret — public by design for this client type) is hardcoded in
`manifest.config.ts`'s `oauth2` key; that's expected and fine to
commit.

**Trust boundary**
- The background service worker is the only component allowed to
  hold tokens or call spreadsheet APIs. Content scripts only ever
  send data to it — they cannot write directly.
- Every message from a content script to the background worker must
  have its sender/origin verified before being acted on.

**Updated 2026-09-10 (centralization):** the rule above now applies
literally, not just to content scripts — `popup/App.tsx` and
`options/App.tsx` never import `providers/googleSheets.ts`/
`providers/excel.ts`/`providers/msAuth.ts` directly; every provider
call (`authenticate`, `createSheet`, `readRow`, `updateCell`,
`cancelApplication`) is a message to the background worker, which is
the sole caller of both `SpreadsheetProvider` implementations. This
closes two separate, real findings, not one: `options/App.tsx`
previously called `authenticate()`/`createSheet()` directly from the
options page's own realm, and `msAuth.ts`'s `MS_TOKEN_KEY`
read-modify-write had no cross-realm locking — two independent JS
realms (background and any extension page) could both refresh the
same Excel refresh token concurrently (real repro confirmed this
doesn't hard-fail today only because Microsoft doesn't invalidate a
refresh token on reuse, per their own docs — an external behavior
this codebase shouldn't rely on as a safety net). Centralizing
collapses every provider call into one realm, where a lock actually
works — see the Background service worker section's Fixed 2026-09-10
note for `lib/msTokenLock.ts`, the dedicated (not reused) lock this
made possible. As a side effect, Undo/Edit
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
  `CANCEL_APPLICATION`) and envelope shape (`{ ok: true, data } |
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

**Verified 2026-08-28 (Phase 3):** `GoogleSheetsProvider.appendRow`'s
`RAW`-input-mode-only formula-injection defense (no character-
prefixing) was confirmed against a real write, checked via the
formula bar (not just cell display) for all four dangerous prefixes
(`=`, `+`, `-`, `@`) — every cell held the literal text, none
evaluated. No character-prefixing needed on top of `RAW` mode.

**Fixed 2026-09-09 (Phase 8):** `ExcelProvider` had no equivalent
protection, and this was a real found-and-fixed vulnerability, not
a check that confirmed it was already safe. Graph's plain `values`
write path has no `RAW`-mode equivalent — a live test writing
`=1+1`, `+2+3`, `-4-5`, and `@SUM(1,1)` through the real `appendRow`
pipeline into a real connected file confirmed all four were
evaluated as live formulas (`values` returned the computed results
`2`, `5`, `-9`, `2`; `valueTypes` returned `Double`, not `String`).
Fixed with `neutralizeFormulaPrefix()` in `excel.ts`, scoped to that
file only (not `lib/sanitize.ts`, not `googleSheets.ts`) — it
prepends a leading apostrophe, Excel's own "force literal text"
convention, to any value starting with `=`, `+`, `-`, or `@` before
`appendRow`/`updateCell` send it. Re-verified with the same four
values afterward: `values` now matches `formulas` as the literal
input text and `valueTypes` reads `String` for all four. The two
providers need different defenses here because they have different
underlying safety guarantees, not because one was built more
carefully than the other.

**Permissions**
- `host_permissions` scoped only to the specific job-site domains
  supported — never `<all_urls>` or broad wildcard grants. This is
  the most common reason extensions get flagged or rejected in Web
  Store review.
- OAuth scopes minimal per provider (`drive.file` for Google;
  `offline_access Files.ReadWrite.AppFolder` for Microsoft Graph —
  see Spreadsheet backend, Phase 6 note, for why `offline_access` is
  required and why it doesn't appear under the portal's API
  permissions).

**Updated 2026-09-09 (Phase 8):** removed `*://www.linkedin.com/*`
and `*://job-boards.greenhouse.io/*` from `host_permissions` —
confirmed via grep that neither content script makes any `fetch()`,
`chrome.scripting`, or `chrome.tabs` call needing host-level access;
`content_scripts.matches` alone is sufficient for injection. The
narrowest-scope principle already applied to OAuth scopes now
applies to the manifest itself — re-add only when a real feature
actually needs it, not speculatively ahead of time.

**Manifest / build**
- Manifest V3 from day one.
- No `eval()`, no remotely hosted or inline scripts — required for
  Web Store approval, not just best practice.
- All API calls over HTTPS via the official SDKs — no manual
  `http://` fallbacks anywhere.

**Supply chain**
- `npm audit` run regularly; Dependabot enabled on the repo once
  it's on GitHub. A compromised dependency in a browser extension is
  a real, checked-for risk, not a theoretical one.

**Explicitly not applicable** (would apply if this had its own
backend/database, which it deliberately does not): login rate
limiting, bot protection, password hashing, row-level DB security,
session cookie handling, file upload restrictions. Identity is
delegated entirely to Google/Microsoft OAuth by design.

---

## Tech stack

- TypeScript, Vite + `crxjs`, React (see `package.json`) — same
  Vite-based toolchain as the existing stat-tracker frontend, for
  consistency with other projects.
- `chrome.storage.local` for the offline write queue and cached
  recent-applications list.
- No custom backend server — Google/Microsoft APIs are the only
  external services this talks to. (Not a Python project — no `venv`
  involved; isolation is the standard Node `package.json` /
  `node_modules` boundary.)

---

## Deployment path (Chrome Web Store)

See the `web-store-deploy` skill (`.claude/skills/web-store-deploy/SKILL.md`)
for the submission steps and current status (privacy policy: done,
published 2026-09-09).

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
6. **ExcelProvider** — second backend implementation against the
   same interface. Done 2026-09-08; see Spreadsheet backend, Phase 6
   note, for the real auth/scope/provisioning findings.
7. ~~**Existing-sheet linking + column auto-mapping.**~~ Descoped
   2026-09-08 — see "Sheet setup" above. Auto-create-only confirmed
   working end-to-end since Phase 3; nothing shipped from this phase.
8. **Security pass** — formula-injection sanitization, permission
   audit, `npm audit`, manifest CSP check — before any Web Store
   submission. Started 2026-09-09; see Security section's Phase 8
   notes above for the real found-and-fixed Excel formula-injection
   vulnerability and the `host_permissions` cleanup. `npm audit`
   (2 findings, both `vite`/`esbuild`, dev-only, don't ship) and
   manifest CSP (no override at all — Chrome's own MV3 minimum
   applies, already the strictest possible outcome) reviewed with no
   action needed. Privacy policy page (Phase 9 prerequisite) done
   2026-09-09 — see Deployment path above for the live URL.
9. **Web Store prep** — listing assets, submission. Privacy policy
   already done (see Phase 8/Deployment path above).

**Deferred, not abandoned:**
- **Indeed parser (2026-09-01):** every fetch attempt (curl and
  WebFetch) was blocked outright by Cloudflare bot-detection, unlike
  LinkedIn and Greenhouse — meaning literally zero pre-implementation
  selector verification was possible, only live DevTools work from
  scratch. Deprioritized in favor of Greenhouse, which had real,
  fetchable, multi-company evidence available immediately. Revisit
  when there's appetite for a parser built entirely from live
  browser inspection with no pre-verification step at all.
- **appendRow isn't idempotent (logged 2026-09-11):** if `appendRow`
  succeeds on Google's/Microsoft's side but the client times out
  (`lib/fetchWithTimeout.ts`, 30s), `handleJobApplicationLogged`'s catch
  queues the same row and the next `drainOfflineQueue` appends it again.
  Not observed in practice, but the path is real. A queue retry reuses
  the row, so the duplicate has the same Date. Since 2026-09-11 Sheets
  stores Date floored to the minute, so an identical Date no longer
  proves a retry: two clicks in the same minute look the same. Needs a
  design decision before any fix (e.g. a per-message id checked before
  re-appending). Pick up after Phase 9.
