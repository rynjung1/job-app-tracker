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
  host_permissions: [],
})
