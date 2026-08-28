import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

export default defineManifest({
  manifest_version: 3,
  name: 'Job Application Tracker',
  description:
    'Automatically logs job applications to your spreadsheet when you apply on supported job sites.',
  version: pkg.version,
  action: {
    default_popup: 'src/popup/index.html',
  },
  options_page: 'src/options/index.html',
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  // "alarms" added for the offline-write-queue retry (Phase 3) — chrome.alarms
  // is what lets a retry survive the background service worker being
  // suspended, which setInterval would not.
  permissions: ['storage', 'identity', 'alarms'],
  // sheets.googleapis.com added (Phase 3) — the background worker calls the
  // Sheets API directly via fetch(); unlike the LinkedIn entry below (DOM-only,
  // no network call), this one genuinely needs host_permissions to avoid a
  // CORS/permission failure on that fetch.
  //
  // www.linkedin.com entry: redundant with content_scripts.matches below for
  // now — a statically declared content script's match pattern is enough for
  // injection, this isn't needed for the extension to also call a host's API
  // (chrome.scripting, fetch, etc). Do NOT assume this stays unnecessary
  // forever: if a later phase needs chrome.scripting or tab-info APIs against
  // linkedin.com, this will need to be added back for real, not just left as
  // documentation.
  host_permissions: ['*://www.linkedin.com/*', 'https://sheets.googleapis.com/*'],
  // Client ID is a public identifier for this client type — Google doesn't
  // issue a secret for "Chrome Extension" OAuth clients, so this is fine to
  // commit (see CLAUDE.md Security > Secrets & credentials, Phase 3 note).
  oauth2: {
    client_id: '735296444178-9g9p4hq4abfslhhsd33cjobtsptiqlbn.apps.googleusercontent.com',
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  },
  content_scripts: [
    {
      // Scoped to www.linkedin.com specifically, NOT *.linkedin.com — LinkedIn
      // doesn't use per-locale subdomains for the main product, everything is
      // www.linkedin.com/<locale-path>. This is deliberate narrowing, not an
      // oversight — don't "fix" it into a wildcard without re-checking that.
      matches: ['*://www.linkedin.com/jobs/*'],
      js: ['src/content/linkedin.ts'],
      run_at: 'document_idle',
    },
  ],
})
