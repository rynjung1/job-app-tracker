// Builds the Chrome Web Store upload zip from a clean production build and
// checks it. Upload zips come only from here (CLAUDE.md, Permissions): a
// Vite dev-server build exposes every file to every site.
//
//   npm run package                   build, check, zip to release/
//   npm run package -- --allow-key    allow a manifest "key" (every upload
//                                     after web-store-deploy step 4, never
//                                     the first); the key must derive the
//                                     store item's ID
//   npm run package -- --allow-dirty  build from uncommitted changes
//   node scripts/package.mjs --check <dir>   only run the checks on an
//                                     unpacked directory
//
// No dependencies: Node plus macOS's zip and unzip.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'dist')
const RELEASE = join(ROOT, 'release')
const args = process.argv.slice(2)
const allowKey = args.includes('--allow-key')
const allowDirty = args.includes('--allow-dirty')
const checkIndex = args.indexOf('--check')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
// The OAuth client ID the manifest must carry: the one in manifest.config.ts.
const CLIENT_ID = readFileSync(join(ROOT, 'manifest.config.ts'), 'utf8').match(/client_id:\s*'([^']+)'/)?.[1]

const EXPECTED = {
  permissions: ['storage', 'identity', 'alarms', 'notifications'],
  // The Workday domains (2026-09-21) are for the background's job-JSON read
  // after Submit, which CORS blocks without them (manifest.config.ts).
  hostPermissions: [
    'https://sheets.googleapis.com/*',
    'https://*.myworkdayjobs.com/*',
    'https://*.myworkdaysite.com/*',
  ],
  scopes: ['https://www.googleapis.com/auth/drive.file'],
  minimumChromeVersion: '110',
  // The Chrome Web Store item (created 2026-09-14). A manifest key, allowed
  // with --allow-key, must derive exactly this ID.
  storeItemId: 'mhldoocgadblnnelahaplfdnaoiehafj',
  // https only (2026-09-14). LinkedIn is every page, not /jobs/*: moving
  // from /feed/ to /jobs/ is an in-app pushState, so a /jobs/*-only script
  // was never injected (CLAUDE.md, Site parsers).
  // Lever and Ashby (2026-09-15): Lever's apply pages on both of its hosts,
  // and Ashby's board host (a single-page app, so the whole host). Workday
  // (2026-09-14): every tenant subdomain of its two career-site domains,
  // never *.myworkday.com.
  contentScriptMatches: [
    'https://www.linkedin.com/*',
    'https://job-boards.greenhouse.io/*/jobs/*',
    'https://jobs.lever.co/*/*/apply*',
    'https://jobs.eu.lever.co/*/*/apply*',
    'https://jobs.ashbyhq.com/*',
    'https://*.myworkdayjobs.com/*',
    'https://*.myworkdaysite.com/*',
  ],
}

// The host each site the store summary can name is actually served from
// (2026-09-17, audit finding): a branch that named a site in the summary
// before its content script existed would have shipped a summary promising
// a site the build didn't support. A name that isn't in this table fails
// too, so the table can't quietly fall behind the summary.
const SITE_HOSTS = {
  LinkedIn: 'www.linkedin.com',
  Greenhouse: 'greenhouse.io',
  Lever: 'jobs.lever.co',
  Ashby: 'jobs.ashbyhq.com',
  Workday: 'myworkdayjobs.com',
}

// The sites named between "when you apply on" and the closing clause:
// "LinkedIn, Greenhouse, Lever, Ashby or Workday" -> the five names.
function sitesNamedIn(description) {
  const named = description.match(/when you apply on ([^—.]+)/)?.[1]
  if (!named) return []
  return named
    .split(/,| or /)
    .map((name) => name.trim())
    .filter(Boolean)
}

// Every file allowed in the package. Anything else (source maps, .ts
// sources, .env, .DS_Store, .vite/, store assets, docs) fails the check.
const ALLOWED = [
  /^manifest\.json$/,
  /^service-worker-loader\.js$/,
  /^icons\/icon(16|48|128)\.png$/,
  /^src\/(popup|options)\/index\.html$/,
  /^assets\/[\w.-]+\.(js|css)$/,
]

// The same token and private-key shapes .githooks/pre-commit blocks.
const SECRETS =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35}|GOCSPX-[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{20,}|1\/\/0[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/

function listFiles(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      return entry.isDirectory() ? listFiles(dir, path) : [path]
    })
    .sort()
}

// Chrome's extension ID for a manifest key: SHA-256 of the DER public key
// (the key's base64 body), the first 32 hex digits mapped 0-f to a-p.
function extensionIdOf(base64Key) {
  const hex = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

const sameSet = (a = [], b = []) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')
// crxjs exposes a content script's file to its match pattern's origin.
const originOf = (pattern) => pattern.replace(/^([^:]+:\/\/[^/]+)\/.*$/, '$1/*')

function checkDir(dir) {
  const errors = []
  const fail = (message) => errors.push(message)
  const files = listFiles(dir)

  for (const file of files) {
    if (!ALLOWED.some((re) => re.test(file))) fail(`unexpected file in the package: ${file}`)
  }
  if (!files.includes('manifest.json')) {
    fail('manifest.json is missing')
    return { errors, files }
  }

  const raw = readFileSync(join(dir, 'manifest.json'), 'utf8')
  const m = JSON.parse(raw)
  if (m.manifest_version !== 3) fail(`manifest_version is ${m.manifest_version}, expected 3`)
  if (m.version !== pkg.version) fail(`manifest version ${m.version} doesn't match package.json's ${pkg.version}`)
  if ('key' in m && !allowKey) {
    fail('manifest has a "key": the first Web Store upload must not (--allow-key is only for updates after web-store-deploy step 4)')
  }
  if ('key' in m && allowKey) {
    const id = typeof m.key === 'string' ? extensionIdOf(m.key) : null
    if (id !== EXPECTED.storeItemId) {
      fail(`manifest key derives extension ID ${id}, not the store item's ${EXPECTED.storeItemId}`)
    }
  }
  if (!sameSet(m.permissions, EXPECTED.permissions)) {
    fail(`permissions are ${JSON.stringify(m.permissions)}, expected ${JSON.stringify(EXPECTED.permissions)}`)
  }
  if (!sameSet(m.host_permissions, EXPECTED.hostPermissions)) {
    fail(`host_permissions are ${JSON.stringify(m.host_permissions)}, expected ${JSON.stringify(EXPECTED.hostPermissions)}`)
  }
  if (!sameSet(m.oauth2?.scopes, EXPECTED.scopes)) {
    fail(`oauth2 scopes are ${JSON.stringify(m.oauth2?.scopes)}, expected ${JSON.stringify(EXPECTED.scopes)}`)
  }
  if (!CLIENT_ID) fail('could not read oauth2 client_id from manifest.config.ts')
  else if (m.oauth2?.client_id !== CLIENT_ID) {
    fail(`oauth2 client_id ${m.oauth2?.client_id} doesn't match manifest.config.ts (${CLIENT_ID})`)
  }
  if (m.minimum_chrome_version !== EXPECTED.minimumChromeVersion) {
    fail(`minimum_chrome_version is ${m.minimum_chrome_version}, expected ${EXPECTED.minimumChromeVersion}`)
  }
  if (raw.includes('<all_urls>') || raw.includes('"**/*"')) {
    fail('manifest exposes files to every site (<all_urls> or **/*): that is a dev-server build, not npm run package')
  }

  const contentScripts = m.content_scripts ?? []
  // Every site the store summary names has a content script for it.
  const allMatches = contentScripts.flatMap((c) => c.matches ?? [])
  for (const site of sitesNamedIn(m.description ?? '')) {
    const host = SITE_HOSTS[site]
    if (!host) {
      fail(`the description names "${site}", which scripts/package.mjs doesn't know a host for (add it to SITE_HOSTS)`)
      continue
    }
    if (!allMatches.some((match) => match.includes(host))) {
      fail(`the description names "${site}" but no content script matches ${host}: ${JSON.stringify(allMatches)}`)
    }
  }
  if (!sameSet(allMatches, EXPECTED.contentScriptMatches)) {
    fail(`content_scripts matches are ${JSON.stringify(allMatches)}, expected ${JSON.stringify(EXPECTED.contentScriptMatches)}`)
  }
  // Pinned (CLAUDE.md, Permissions): one entry per content script, exposing
  // only that script's own built files to its site's origin, and never with
  // a dynamic url.
  //
  // "Files" rather than "file" since 2026-09-21: the Workday parser is now
  // imported by the background as well as by its content script, so Vite
  // splits it into a shared chunk and crxjs exposes that chunk alongside the
  // script's own. Still only this bundle's own JavaScript, still only to the
  // origins that script already runs on. The background's own entry must
  // never appear.
  const war = m.web_accessible_resources ?? []
  const origins = contentScripts.map((c) => JSON.stringify(c.matches.map(originOf).sort()))
  const background = m.background?.service_worker
  if (war.length !== contentScripts.length) {
    fail(`web_accessible_resources should have one entry per content script (${contentScripts.length}); found ${war.length}`)
  }
  for (const entry of war) {
    const matches = JSON.stringify([...(entry.matches ?? [])].sort())
    if (!origins.includes(matches)) {
      fail(`web_accessible_resources entry exposes files to ${matches}, which is not a content script's origin`)
    }
    if (entry.use_dynamic_url !== false) fail(`web_accessible_resources entry for ${matches} must set use_dynamic_url false`)
    for (const resource of entry.resources ?? []) {
      if (!/^assets\/[\w.-]+\.js$/.test(resource)) {
        fail(`web_accessible_resources exposes ${resource} to ${matches}; only this bundle's own assets/*.js may be exposed`)
      }
      if (resource === background) fail(`web_accessible_resources exposes the background service worker (${resource})`)
    }
  }

  const referenced = [
    ...Object.values(m.icons ?? {}),
    m.action?.default_popup,
    m.options_page,
    m.background?.service_worker,
    ...contentScripts.flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
    ...war.flatMap((r) => r.resources ?? []),
  ].filter((p) => p && !p.includes('*'))
  for (const path of referenced) {
    if (!files.includes(path)) fail(`manifest references ${path}, which isn't in the package`)
  }

  for (const file of files.filter((f) => /\.(js|css|html|json)$/.test(f))) {
    const text = readFileSync(join(dir, file), 'utf8')
    if (text.includes('localhost')) fail(`${file} mentions localhost (a dev build?)`)
    const plainHttp = text.match(/http:\/\/(?!www\.w3\.org\/)[^\s"'`)]{0,60}/)
    if (plainHttp) fail(`${file} has a non-HTTPS URL: ${plainHttp[0]}`)
    if (/\beval\(|new Function\(/.test(text)) fail(`${file} uses eval or new Function`)
    if (SECRETS.test(text)) fail(`${file} contains something shaped like a secret`)
    if (file.endsWith('.html') && /<script[^>]+src=["'](https?:)?\/\//i.test(text)) {
      fail(`${file} loads a remote script`)
    }
  }
  return { errors, files }
}

function report(label, { errors, files }) {
  if (errors.length) {
    for (const e of errors) console.error(`FAIL: ${e}`)
    console.error(`${label}: ${errors.length} problem(s)`)
    process.exit(1)
  }
  console.log(`${label}: OK (${files.length} files)`)
}

if (checkIndex !== -1) {
  report(`check ${args[checkIndex + 1]}`, checkDir(args[checkIndex + 1]))
  process.exit(0)
}

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
const head = git('rev-parse', '--short', 'HEAD')
const dirty = git('status', '--porcelain')
if (dirty && !allowDirty) {
  console.error('FAIL: uncommitted changes. Commit first so the zip matches a commit, or pass --allow-dirty.')
  process.exit(1)
}

console.log(`== clean production build (commit ${head}${dirty ? ', with uncommitted changes' : ''})`)
rmSync(DIST, { recursive: true, force: true })
const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)

console.log('== checks')
report('dist', checkDir(DIST))

const out = join(RELEASE, `job-app-tracker-${pkg.version}.zip`)
mkdirSync(RELEASE, { recursive: true })
rmSync(out, { force: true })
execFileSync('zip', ['-X', '-r', '-q', out, '.'], { cwd: DIST })

console.log(`== ${relative(ROOT, out)}`)
console.log(execFileSync('unzip', ['-l', out], { encoding: 'utf8' }).trimEnd())
const bytes = readFileSync(out)
console.log(`size: ${statSync(out).size} bytes (${(statSync(out).size / 1024).toFixed(1)} KB)`)
console.log(`sha256: ${createHash('sha256').update(bytes).digest('hex')}`)

console.log('== re-extract check')
const extracted = mkdtempSync(join(tmpdir(), 'job-app-tracker-zip-'))
try {
  execFileSync('unzip', ['-q', out, '-d', extracted])
  const result = checkDir(extracted)
  const distFiles = listFiles(DIST)
  if (!sameSet(result.files, distFiles)) result.errors.push('the zip does not hold the same files as dist/')
  for (const file of distFiles) {
    if (result.files.includes(file) && !readFileSync(join(DIST, file)).equals(readFileSync(join(extracted, file)))) {
      result.errors.push(`${file} differs between the zip and dist/`)
    }
  }
  report('zip, re-extracted and compared byte for byte with dist/', result)
} finally {
  rmSync(extracted, { recursive: true, force: true })
}
console.log(`PACKAGE OK: ${relative(ROOT, out)} from commit ${head}${dirty ? ' plus uncommitted changes' : ''}`)
