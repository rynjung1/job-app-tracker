---
name: web-store-deploy
description: Steps and status for publishing this extension to the Chrome Web Store (OAuth client registration, privacy policy, listing submission).
---

## Deployment path (Chrome Web Store)

- Manifest V3 required for any new listing.
- Register an OAuth client in Google Cloud Console (and an app
  registration in Azure AD for the Microsoft side) scoped as
  described in this project's CLAUDE.md (Security section).
- Short privacy policy page required before submission, since the
  extension touches page content and a connected account — should
  state plainly what data is read, what's sent where, and that no
  data is sent to any server other than Google's/Microsoft's own
  APIs. **Status (2026-09-09): done.** Published at
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
  not the unpacked dev ID `hopcbbifbonofhibjgdkogmbnocaghmg`. Both
  sign-ins are bound to it: the Google OAuth client is a "Chrome
  Extension" client whose Item ID is the extension ID, and `msAuth.ts`
  sends `chrome.identity.getRedirectURL()` (`https://<id>.chromiumapp.org/`)
  as the redirect URI, which Azure must have registered. Storage is
  per-ID too: the new-ID build starts with no `sheetRef`, queue or
  recent list. Once `key` is in the manifest, dev builds share the store
  ID, so the unpacked build and a store install can't coexist.
  (R = only Ryan can do it.)
  1. R: register the developer account (one-time fee).
  2. Upload a zip with no `key` as a new item; don't submit it. The
     store rejects `key` only on the first upload; later updates may
     include it ([manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key),
     chromium-extensions threads
     [Su50pbNzRms](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/Su50pbNzRms)
     and [x_NBS6_-NKs](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/x_NBS6_-NKs)).
     R copies the Item ID and Package > View public key.
  3. R: confirm the old ID's offline queue is empty before switching;
     rows still queued there would be stranded. Decided 2026-09-11: the
     new ID starts fresh. Its Connect (step 7, once steps 5-6 are done)
     creates a new sheet, and the old sheet stays in Drive untouched.
  4. Add the public key as `key` in `manifest.config.ts`; R loads the
     build and checks chrome://extensions shows the Item ID, then
     removes the old unpacked install.
  5. R (Cloud console): set the OAuth client's Item ID to the new ID,
     and the consent screen to In production (Testing only lets listed
     test users sign in; `drive.file` is non-sensitive, basic
     verification only).
  6. R (Azure): add `https://<new-id>.chromiumapp.org/` under the
     existing Mobile and desktop platform (not SPA).
  7. Re-verify Google and Excel sign-in and a real logged row on the
     new-ID build, and run the open Excel tests (CLAUDE.md, Sheet
     setup) in the same sitting.
  8. Resolve CLAUDE.md's LinkedIn "Known v1 gap" (the Apply selector
     only matches the English aria-label): a language-independent
     match, or keep English-only and say so in the listing.
  9. Upload the final build as a new version of the same item, fill in
     the listing (`store-assets/listing.md`, `store-assets/screenshots/`)
     and the privacy-practices tab; R submits.
- Store listing screenshots/description come after the extension is
  functionally complete and tested across both shipped v1 site
  parsers, LinkedIn and Greenhouse. Indeed is deferred, not part of
  this gate (see CLAUDE.md "Deferred, not abandoned").
