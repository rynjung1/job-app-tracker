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

3. **Popup + options page**
   - Popup: shows a toast-style confirmation for ~5 seconds after an
     auto-log ("Logged: Shopify — Data Engineer Co-op — [Undo]
     [Edit]"), plus a scrollable list of recent applications.
   - Options page: choose spreadsheet backend, authenticate,
     auto-create a sheet (the only supported setup path — see "Sheet
     setup" below), enable/disable individual site parsers.

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

### Spreadsheet backend (locked decision: support both)

A `SpreadsheetProvider` interface decouples the rest of the extension
from which backend is active:

```
interface SpreadsheetProvider {
  authenticate(): Promise<void>
  createSheet(templateColumns: string[]): Promise<SheetRef>
  readHeaders(sheetRef: SheetRef): Promise<string[]>
  appendRow(sheetRef: SheetRef, row: Record<string, string>): Promise<AppendedRow>
  updateCell(sheetRef: SheetRef, rowNumber: number, columnName: string, value: string): Promise<void>
}
```

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

- TypeScript throughout.
- Vite + `crxjs` Vite plugin for Manifest V3 bundling and dev
  hot-reload (same Vite-based toolchain as the existing stat-tracker
  frontend, for consistency).
- React for the popup and options page UI (small surface area, but
  keeps a consistent pattern with existing projects).
- `chrome.storage.local` for the offline write queue and cached
  recent-applications list.
- No custom backend server — Google/Microsoft APIs are the only
  external services this talks to. (Not a Python project — no `venv`
  involved; isolation is the standard Node `package.json` /
  `node_modules` boundary.)

---

## Deployment path (Chrome Web Store)

- Manifest V3 required for any new listing.
- Register an OAuth client in Google Cloud Console (and an app
  registration in Azure AD for the Microsoft side) scoped as
  described above.
- Short privacy policy page required before submission, since the
  extension touches page content and a connected account — should
  state plainly what data is read, what's sent where, and that no
  data is sent to any server other than Google's/Microsoft's own
  APIs. **Status (2026-09-09): still outstanding, not drafted** —
  flagged during Phase 8 as a real prerequisite for this section's
  own goal, but drafting it is separate, not-yet-started work.
- Store listing screenshots/description come after the extension is
  functionally complete and tested across all three v1 site parsers.

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
   action needed. Privacy policy page (Phase 9 prerequisite) noted
   as still outstanding — see Deployment path above.
9. **Web Store prep** — privacy policy, listing assets, submission.

**Deferred, not abandoned:**
- **Indeed parser (2026-09-01):** every fetch attempt (curl and
  WebFetch) was blocked outright by Cloudflare bot-detection, unlike
  LinkedIn and Greenhouse — meaning literally zero pre-implementation
  selector verification was possible, only live DevTools work from
  scratch. Deprioritized in favor of Greenhouse, which had real,
  fetchable, multi-company evidence available immediately. Revisit
  when there's appetite for a parser built entirely from live
  browser inspection with no pre-verification step at all.
