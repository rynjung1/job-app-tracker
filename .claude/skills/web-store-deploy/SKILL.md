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
- Store listing screenshots/description come after the extension is
  functionally complete and tested across all three v1 site parsers.
