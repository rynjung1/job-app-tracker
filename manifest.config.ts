import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

export default defineManifest({
  manifest_version: 3,
  name: 'Job Application Tracker',
  // The Chrome Web Store's summary comes from this field (plain text, 132
  // characters max), so it's the approved short description from
  // store-assets/listing.md, word for word.
  description:
    'Automatically logs job applications to Google Sheets when you apply on LinkedIn, Greenhouse or Workday — no manual data entry.',
  version: pkg.version,
  // Added 2026-09-13: chrome.action.setBadgeTextColor, used by the "sign-in
  // needed" badge (lib/authStatus.ts), needs Chrome 110. On older Chrome it
  // throws inside reportAuthRequired before the notification is created, so
  // the whole sign-in warning would fail. The next-newest API in use,
  // chrome.storage.session, needs 102.
  minimum_chrome_version: '110',
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
  // login.microsoftonline.com + graph.microsoft.com removed 2026-09-13,
  // with Excel/OneDrive support (CLAUDE.md, Spreadsheet backend).
  host_permissions: ['https://sheets.googleapis.com/*'],
  // Client ID is a public identifier for this client type — Google doesn't
  // issue a secret for "Chrome Extension" OAuth clients, so this is fine to
  // commit (see CLAUDE.md Security > Secrets & credentials, Phase 3 note).
  // The Chrome Web Store item's public key (added 2026-09-14,
  // web-store-deploy step 4): the base64 body of Package > View public key
  // for item mhldoocgadblnnelahaplfdnaoiehafj. A public key, public by design
  // (the pre-commit hook allows it). It pins this build's extension ID to the
  // store item's, so an unpacked build signs in with the same OAuth client.
  // scripts/package.mjs checks it derives that ID.
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3XBXChjiq2LRuh7dpEKQWL6IWYpelptICK4KWD/WfB9zKmksZsit2iG2V89ECSJshayddD3R6Jruvj5k7V2PYiILRtzwBHypKgDO66X9NWYg8HBTVw/GPHA2pqsRKy1foAVlSJ3aprWkUt1JxOW+acT30v278gq7Dcz7Q7aPt8ofk9VdugHmFOQjy038gh/3guQsxxhPCT8B3H9Vv6pCITabkxRxgj98Ou62kw9o0R2brgKI5PYDfdn70UMLeNQgXBeY9CPWMwBXTWJSgtgbjrTDdRnHTmBYN1GavcoTxpcX4Q008RQeoGnPNOXK+DbSTvnZsFY4KctsC/oAHCD9bwIDAQAB',
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
      //
      // Every www.linkedin.com page, not just /jobs/* (2026-09-14, flagged in
      // CLAUDE.md, Site parsers): LinkedIn is a single-page app, and going from
      // /feed/ to /jobs/ in the app is a pushState, not a page load, so a
      // script matched only to /jobs/* was never injected there. The script
      // acts only on job pages: it does nothing until an Easy Apply click, and
      // the parser's detect() checks the path is /jobs/ at that moment. The
      // install warning names the same host as before (www.linkedin.com), and
      // host_permissions is unchanged. https only, like the Greenhouse match.
      matches: ['https://www.linkedin.com/*'],
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
      // https only (2026-09-14): the background accepts messages only from
      // https origins anyway (TRUSTED_ORIGINS).
      matches: ['https://job-boards.greenhouse.io/*/jobs/*'],
      js: ['src/content/greenhouse.ts'],
      run_at: 'document_idle',
    },
    {
      // Workday career sites (2026-09-14, flagged in CLAUDE.md, Site parsers,
      // Workday: a new set of install-warning hosts). Every tenant runs on a
      // subdomain of these two domains, and the app moves from job search to
      // posting to application without page loads, so no narrower pattern
      // works. Never *.myworkday.com, Workday's employee HR app. The script
      // acts only on a job's Apply and final Submit clicks.
      matches: ['https://*.myworkdayjobs.com/*', 'https://*.myworkdaysite.com/*'],
      js: ['src/content/workday.ts'],
      run_at: 'document_idle',
    },
  ],
})
