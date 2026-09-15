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
     build. Also check live:
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
  8. Upload the final build as a new version of the same item, fill in
     the listing (`store-assets/listing.md`, `store-assets/screenshots/`)
     and the privacy-practices tab; R submits, but only after step 6 has
     passed. The new popup UI, the status dropdown and "needs reconnect"
     have never run live, and the step 2 draft build can't sign in (its
     new ID isn't the OAuth client's Item ID until step 5). In the
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
