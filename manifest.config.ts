import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

export default defineManifest({
  manifest_version: 3,
  name: 'Job Application Tracker',
  description:
    'Automatically logs job applications to your spreadsheet when you apply on supported job sites.',
  version: pkg.version,
  // Paths are relative to the built dist/ root, not this source file —
  // files under public/ are copied verbatim to dist/ by Vite, dropping the
  // "public/" prefix, so "icons/icon16.png" here means public/icons/icon16.png.
  icons: {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
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
  // "notifications" added (Phase 4) — the auto-log toast is a real
  // chrome.notifications system notification, not literally "the popup"
  // rendering something proactively (a popup can't open itself without a
  // user gesture) — see CLAUDE.md Logging behavior, Phase 4 note.
  permissions: ['storage', 'identity', 'alarms', 'notifications'],
  // sheets.googleapis.com added (Phase 3) — the background worker calls the
  // Sheets API directly via fetch(); this genuinely needs host_permissions
  // to avoid a CORS/permission failure on that fetch.
  //
  // www.linkedin.com / job-boards.greenhouse.io removed (Phase 8 security
  // pass, 2026-09-09) — confirmed via grep that neither content script
  // (content/linkedin.ts, content/greenhouse.ts) makes any fetch(),
  // chrome.scripting, or chrome.tabs call that would need host-level
  // access; a statically declared content_scripts.matches pattern is
  // sufficient for injection alone. Narrowest-scope principle applied to
  // the manifest itself, not just OAuth scopes — re-add only when a real
  // feature actually needs it, not speculatively ahead of time.
  //
  // login.microsoftonline.com + graph.microsoft.com added for
  // ExcelProvider — the hand-rolled PKCE flow's token-endpoint fetch()
  // and the Graph API calls both need this to avoid a CORS failure, same
  // reasoning as sheets.googleapis.com above. This also means these
  // background-worker fetch() calls are NOT subject to CORS at all (a
  // privileged-context exemption once host_permissions is declared) —
  // irrelevant to whether Microsoft's SPA-vs-native platform distinction
  // matters for us; see CLAUDE.md ExcelProvider notes.
  host_permissions: [
    'https://sheets.googleapis.com/*',
    'https://login.microsoftonline.com/*',
    'https://graph.microsoft.com/*',
  ],
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
    {
      // job-boards.greenhouse.io only, not boards.greenhouse.io — the
      // latter unconditionally 301-redirects there before any page ever
      // renders (confirmed via curl -v), so a content script matched
      // against it would never get a chance to run. See CLAUDE.md Site
      // parsers, Greenhouse scoping decision, for the coverage gap this
      // leaves (custom-domain-embedded boards aren't reachable at all).
      matches: ['*://job-boards.greenhouse.io/*/jobs/*'],
      js: ['src/content/greenhouse.ts'],
      run_at: 'document_idle',
    },
  ],
})
