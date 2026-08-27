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
  permissions: ['storage', 'identity'],
  // Redundant with content_scripts.matches below for now — a statically
  // declared content script's match pattern is enough for injection, this
  // isn't needed for the extension to also call a host's API (chrome.scripting,
  // fetch, etc). Do NOT assume this stays unnecessary forever: if a later
  // phase needs chrome.scripting or tab-info APIs against linkedin.com, this
  // will need to be added back for real, not just left as documentation.
  host_permissions: ['*://www.linkedin.com/*'],
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
