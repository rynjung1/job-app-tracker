---
name: web-store-deploy
description: Steps and status for publishing this extension to the Chrome Web Store (OAuth client registration, privacy policy, listing submission).
---

## Deployment path (Chrome Web Store)

- Manifest V3 required for any new listing.
- Register an OAuth client in Google Cloud Console, scoped as
  described in this project's CLAUDE.md (Security section).
- Short privacy policy page required before submission, since the
  extension touches page content and a connected account — should
  state plainly what data is read, what's sent where, and that no
  data is sent to any server other than Google's own APIs.
  **Status (2026-09-09): done.** Published at
  https://rynjung1.github.io/job-app-tracker/privacy.html —
  confirmed live with a real fetch (HTTP 200, real content, not
  just a successful GitHub Pages API response) before being marked
  done here. Static HTML under `docs/`, served via GitHub Pages
  (`main` branch, `/docs` folder) — no new hosting infrastructure,
  consistent with this project's no-custom-backend approach.
  Content grounded in the real architecture (`drive.file` /
  `Files.ReadWrite.AppFolder` scoping, the exact `chrome.storage.local`
  data inventory, no backend/analytics/third-party sharing), approved
  before publishing. Contact is the repo's GitHub Issues page — no
  separate support email was set up for this project.
- **Blocker until done: the extension ID changes on first upload.**
  `manifest.config.ts` has no `key`, so the Web Store assigns a new ID,
  not the unpacked dev ID `hopcbbifbonofhibjgdkogmbnocaghmg`. Google
  sign-in is bound to it: the OAuth client is a "Chrome Extension"
  client whose Item ID is the extension ID. Storage is
  per-ID too: the new-ID build starts with no `sheetRef`, queue or
  recent list. Once `key` is in the manifest, dev builds share the store
  ID, so the unpacked build and a store install can't coexist.
  (R = only Ryan can do it.)
  1. **Done 2026-09-14.** R: register the developer account (one-time fee), and declare
     non-trader status (a free personal project, not a business).
     2-Step Verification must be on for that Google account: the policy
     says "2-Step Verification is required for all developer accounts
     prior to publishing an extension or updating an existing
     extension"
     ([2-Step Verification](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification)).
  2. Upload a zip with no `key` as a new item; don't submit it. The
     store rejects `key` only on the first upload; later updates may
     include it ([manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key),
     chromium-extensions threads
     [Su50pbNzRms](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/Su50pbNzRms)
     and [x_NBS6_-NKs](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/x_NBS6_-NKs)).
     R copies the Item ID and Package > View public key.
     **Done 2026-09-14:** Ryan uploaded the no-key zip as a draft. Store
     item ID `mhldoocgadblnnelahaplfdnaoiehafj`; its public key's SHA-256
     derives that ID (checked by the reviewer and again here). From now
     on every upload is built with `npm run package -- --allow-key`: the
     manifest carries the key, and the script fails unless it derives
     this ID.
  3. R: confirm the old ID's offline queue is empty before switching;
     rows still queued there would be stranded. Paste
     `scripts/health-check.js` into the old ID's service-worker console
     (read-only): its verdict must read "safe to switch". Decided 2026-09-11: the
     new ID starts fresh. Its Connect (step 6, once step 5 is done)
     creates a new sheet, and the old sheet stays in Drive untouched.
  4. Add the public key as `key` in `manifest.config.ts`; R loads the
     build and checks chrome://extensions shows the Item ID, then
     removes the old unpacked install.
     **Key added 2026-09-14** (one base64 line; the built manifest
     carries it and it derives `mhldoocgadblnnelahaplfdnaoiehafj`;
     `scripts/package.mjs` checks that with `--allow-key`, and CI's
     package step passes `--allow-key`). Still R's: load the build,
     check the ID, remove the old unpacked install. Until step 5 sets
     the OAuth client's Item ID to the new ID, Google sign-in on this
     build fails; that's expected.
  5. R (Cloud console), in two parts:
     - **Now, not waiting for the new ID** (Ryan, 2026-09-13): the
       consent screen to In production. In Testing, only listed test
       users can sign in, and Google's refresh tokens expire after 7
       days: "A Google Cloud Platform project with an OAuth consent
       screen configured for an external user type and a publishing
       status of 'Testing' is issued a refresh token expiring in 7 days"
       unless it only asks for name, email and profile
       ([OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)),
       and `drive.file` isn't one of those. `drive.file` is
       non-sensitive, so basic verification only. Don't add a logo or
       display name to the consent screen: that triggers brand
       verification (2-3 business days). Confirm it shows In production.
     - **After step 4:** set the OAuth client's Item ID to the new ID.
  6. Re-verify Google sign-in and a real logged row on the new-ID
     build. **First pass 2026-09-14** (the reviewer drove LinkedIn in
     Ryan's Chrome, Ryan did Connect; the loaded build came from the
     `workday` branch at `4f51b92`, which includes main's `8f18d83`):
     - PASS: Google sign-in on `mhldoocgadblnnelahaplfdnaoiehafj`, so
       step 5's Item ID is in place.
     - PASS: an Easy Apply click before Connect was queued, and Connect
       saved it ("Saved 1 waiting application").
     - PASS: `/feed/` → LinkedIn's Jobs navigation → an in-app search
       result, no reload: the content script was present and caught the
       trusted Easy Apply click.
     - PASS: a `/jobs/view/{id}/` click (full load) logs.
     - PASS: a `/jobs/search-results/?currentJobId=` click logs on
       `8f18d83`; it failed before that commit.
     - The sheet held exactly the 2 expected rows, fields correct,
       formatting intact.
     - Not verified: the 24-hour repeat skip (the browser tool's later
       clicks never reached the page); Ryan is checking it by hand.
     - Two sheets were created that day; the Connect paths and the fix
       are in CLAUDE.md (Deployment path).
     - Rebuild `dist/` from main once Ryan's checks are done, so his
       daily build matches what ships.
     **Declined 2026-09-16 (Ryan): the checks below were not run.** He
     chose not to run the remaining live checks — the popup's status and
     resume changes, the stale-row refusal, the notification's Edit
     window, the 24-hour repeat skip, the sheet trash/restore/create
     flow, the sign-in-lost flow and offline. They stay on this list and
     stay **unverified live**: each is verified in Node and headless
     renders only. Don't mark them passed. Step 8's post-install check
     covers the same ground on the store build, so they get a second
     chance there.
     Also check live:
     - `scripts/health-check.js` in the new ID's service-worker console,
       after Connect: the new extension ID and version, a spreadsheet
       id, an empty queue, no sign-in flag, no badge, and the retry
       alarm present.
     - Edit from the popup's recent list (never run since provider
       calls moved into the background worker), and Reconnect.
     - Undo and Edit from the "Logged" notification.
     - The "needs reconnect" sign-in warning (CLAUDE.md, Logging
       behavior), verified in Node only so far. Revoke the extension's
       access in the Google Account, then check the popup's amber
       banner, the "!" badge and the "Sign-in needed" notification.
       Make one Easy Apply click (close the modal) so a row queues, then
       Reconnect from the banner: Settings should show "Saved 1 waiting
       application", the row should land and the badge should clear.
       Before reconnecting, run
       `chrome.storage.local.get('authStatus')` in the service-worker
       console and record Chrome's real error text in that CLAUDE.md
       paragraph. Also: a cleared cached token
       (`chrome.identity.removeCachedAuthToken`) should show no warning,
       and an application made offline should show the neutral
       "waiting to be saved" banner, not the warning.
     - The `ec2600e` behaviour, also verified in Node only so far: the
       row the Reconnect above saves then appears in the popup with Edit
       and Undo; Connect saves waiting rows at once (make an Easy Apply
       click before connecting, then Connect: Settings shows "Saved 1
       waiting application" and the popup lists it); and a notification
       Undo that fails (for example with the network off) shows the
       "Undo didn't go through" notice.
     - The polished popup, verified in Node and in headless renders
       only: changing a status from a row's chip writes that row's
       Status cell in the sheet; after the row's Company is edited by
       hand in the sheet, a status change is refused with the inline
       "This row may have changed" error and nothing is written; and the
       "Logged" notification's Edit opens the new focused "Change resume
       version" window (not the list), with nothing clipped.
     - Added 2026-09-14 by the pre-submission audit (verified in Node
       only so far): open LinkedIn at `/feed/`, click Jobs in LinkedIn's
       own navigation (no page reload), open a posting with Easy Apply
       and click Easy Apply (close the dialog): one row is logged.
       Opening Easy Apply again on the same job logs nothing more (the
       24-hour repeat check); Undo that row from the popup's status
       chip, click Easy Apply again, and it logs.
     - The "Logged" notification clears after about 5 seconds (its
       timer; macOS may still list it in Notification Center). This
       step runs an unpacked build, where alarms have no minimum, so the
       30-second fallback alarm can't be seen here. After the store
       install (step 8), check the notification still clears after
       about 5 seconds.
     - Workday (the `workday` branch, CLAUDE.md, Site parsers, Workday),
       after it's merged: on one real Workday application, check a row
       lands at the final Submit with the tenant id as Company and the
       normalized URL, once, and that it appears in the popup. Before the
       merge, Ryan's first real Workday application is the observation
       instead, with any build loaded (or none): run
       `scripts/workday-observe.js` PARTs 0, A and B. The same
       `documentLoadedAt` in PART 0 and PART A means the extension's
       in-memory capture would survive to Submit.
     - A sheet in Drive's trash or deleted (CLAUDE.md, Spreadsheet
       backend, 2026-09-14), with a throwaway sheet connected: move it
       to Drive's trash, open the popup (the 5-minute tick only asks
       Drive while something is queued or already flagged): the
       banner, the "!" badge and the notification say it's in the trash;
       make one Easy Apply click, which is queued. Restore it: within 5
       minutes (or on opening the popup) the banner clears and the
       queued row lands. Trash it again, then Settings > Create a new
       sheet: a new sheet is connected and the queued rows land in it.
     - The `ui-polish` items (CLAUDE.md, Popup + Settings, 2026-09-15),
       verified in Node and headless renders only: with the system set to
       dark, the popup, Settings and the Edit window are dark and
       readable, and Tab shows a focus ring; with the network off, an
       Easy Apply click shows a Waiting row at its date with the banner,
       and it becomes a normal row once saved; ⋯ > Add note shows the
       row's Notes cell and Save writes it; edit that cell in the sheet
       while the editor is open, then Save: "This note changed in your
       sheet; reopen to see it." and the sheet's text stays; the summary
       line counts this week's applications (Monday to Sunday).
     - Left here by phase B (the new ID starts with empty storage, so
       it's a real first install): Settings opens on its own as a
       window, and the "Not connected" notification's Open Settings
       opens that window.
  7. **Done 2026-09-11** (`f4ab8c5`): CLAUDE.md's LinkedIn "Known v1
     gap" is resolved. The selector matches LinkedIn's current markup
     (the link variant in any UI language, the button variants in
     English), and the listing says Easy Apply detection is fully
     supported with LinkedIn set to English. `f3cb30a` also fixed
     split-pane applications not being logged.
  8. **Held until the `workday` branch is merged** (Ryan wants Workday
     in v1; decided 2026-09-14). The merge waits for Ryan's observed
     Workday application, which pins the final Submit selector. The zip
     built at `838aa00` has no Workday and isn't the one to submit: the
     final zip is built from `main` after the merge, with
     `npm run package -- --allow-key`. The version stays 1.0.0 (the
     step 2 draft's) for the first submission; only if the dashboard
     refuses a second upload at the same version, bump it to 1.0.1
     (`package.json`'s `version`, which the manifest reads).
     **What changes at the Workday merge** (prepared 2026-09-14, so the
     work after the observation is quick):
     - **The Submit selector:** replace the placeholder
       `WORKDAY_SUBMIT_SELECTOR_PLACEHOLDER` (`:not(*)`,
       `src/parsers/workday.ts`) with the control that PART A of
       `scripts/workday-observe.js` shows. If that Submit shares its
       `data-automation-id` with the earlier steps' Next button, the
       selector also needs whatever PART A shows marks the Review step
       (its label, or the progress step). Tests: the content-script
       test's test-only selector becomes the real one, and the DOM test
       checks it matches the observed Submit and not a Next button. The
       raw output is never committed; a fixture made from it is scrubbed
       first. CLAUDE.md's Workday note records the evidence.
     - **The listing and privacy text:** already on the branch (the
       summary, 126 of 132 characters; the description, single purpose,
       storage and content-script texts; privacy.html's Workday
       sentence). Re-read them against what the observation showed, keep
       the manifest `description` identical to the short description, and
       change privacy.html's "Last updated" if its text changes.
     - **Settings "Supported sites":** the Workday line is on the branch
       (`src/options/App.tsx`). The store screenshot `2-settings.png`
       shows that list without Workday, so re-render it (listing.md, "How
       both were made").
     - **The reviewer note:** the Test instructions tab's step 5, on the
       branch: Workday is logged only at the final Submit of a real
       application, so it can't be tested without applying.
     - **The install warning:** the two Workday matches make 5 warning
       hosts, which Chrome shows as "Read and change your data on a
       number of websites", listing "All myworkdayjobs.com sites" and "All
       myworkdaysite.com sites". Shipping them in the first submission
       means no update prompt later. `package.mjs` on the branch pins the
       four matches. An unpacked load shows no install dialog, so check
       the rebuilt manifest's matches there, and the dialog itself on the
       store install.
     - **One live Workday check on the rebuilt build:** rebuild Ryan's
       `dist/` from `main` after the merge (`npm run build`), confirm its
       manifest has the key and the two Workday matches, and on one real
       Workday application check a row lands at the final Submit with the
       tenant id as Company and the normalized URL, once, and appears in
       the popup (step 6's Workday bullet, on the branch).
     - The last bullet of this file ("both shipped v1 site parsers,
       LinkedIn and Greenhouse") gains Workday.
     Then upload the final build as a new version of the same item, fill in
     the listing (`store-assets/listing.md`, `store-assets/screenshots/`)
     and the privacy-practices tab; R submits, but only after step 6 has
     passed. The new popup UI, the status dropdown and "needs reconnect"
     have never run live, and the step 2 draft build can't sign in (its
     new ID isn't the OAuth client's Item ID until step 5). After the
     install, run the step 6 checks Ryan declined on 2026-09-16 (the
     popup's status and resume changes, the stale-row refusal, the
     notification's Edit window, the 24-hour repeat skip, the sheet
     trash/restore/create flow, the sign-in-lost flow, offline): on the
     store build they're still the first live run those paths get. In the
     dashboard, R also:
     - chooses to publish manually after approval, not automatically;
     - picks the publisher display name;
     - confirms the OAuth consent screen's app name doesn't contain
       "Google".
- Optional housekeeping (R): Excel/OneDrive support was removed
  2026-09-13, so the Azure app registration from that era is unused.
  Delete it in the Azure portal and revoke the extension's access in the
  Microsoft account's security settings.
- Store listing screenshots/description come after the extension is
  functionally complete and tested across both shipped v1 site
  parsers, LinkedIn and Greenhouse. Indeed is deferred, not part of
  this gate (see CLAUDE.md "Deferred, not abandoned").
