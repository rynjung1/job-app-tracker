// The LinkedIn parser (src/parsers/linkedin.ts, extractLinkedInJob) on
// fixture pages of all three layouts, in headless Chrome, so selectors,
// closest() and the rendered-link check run against real layout. Each case
// is its own iframe document at a real LinkedIn address. Skipped with a
// message when Chrome isn't found (set CHROME_PATH).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const fixture = (name) => fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'linkedin', name), 'utf8')

function which(cmd) {
  const found = spawnSync('which', [cmd], { encoding: 'utf8' })
  return found.status === 0 ? found.stdout.trim() : null
}
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(which),
].find((p) => p && fs.existsSync(p))

const searchResults = fixture('search-results.html')
const splitPane = fixture('split-pane.html')
const GALENT = '<a href="https://www.linkedin.com/company/galenthq/life/">Galent</a>'
// The same page with the detail pane showing a different job than ?currentJobId=.
const otherPane = `<section aria-label="Job details"><div><div><a href="https://www.linkedin.com/company/example-corp/">Example Corp</a></div><p><a href="/jobs/view/1000000001/">Junior Developer</a></p><p>Toronto, ON · 1 day ago · 12 applicants</p><div><a aria-label="Easy Apply to this job" href="/jobs/view/1000000001/apply/">Easy Apply</a></div></div></section>`

const SEARCH_URL = 'https://www.linkedin.com/jobs/search-results/?currentJobId=4464201438&keywords=software%20developer&f_AL=true'
const GALENT_JOB = { title: 'Entry Level Software Developer - Paid Training Program', company: 'Galent', location: 'Mississauga, ON', url: 'https://www.linkedin.com/jobs/view/4464201438/' }

const CASES = [
  {
    name: '/jobs/search-results/ (no h1): title link, company and "location · age" row from the detail pane',
    html: searchResults,
    href: SEARCH_URL,
    expect: GALENT_JOB,
  },
  {
    name: '/jobs/search-results/, no company link in the pane: document.title names the same title, so its company is used',
    html: searchResults.replaceAll(GALENT, ''),
    href: SEARCH_URL,
    expect: GALENT_JOB,
  },
  {
    name: '/jobs/search-results/, no company link and a stale search-page title: no row',
    html: searchResults.replaceAll(GALENT, '').replace(/<title>[^<]*<\/title>/, '<title>(20) software developer Jobs | LinkedIn</title>'),
    href: SEARCH_URL,
    expect: null,
  },
  {
    name: '/jobs/search-results/, the pane showing a different job than ?currentJobId=: no row',
    html: searchResults.replace(/<section aria-label="Job details">[\s\S]*?<\/section>/, otherPane).replace(/<title>[^<]*<\/title>/, '<title>Junior Developer | Example Corp | LinkedIn</title>'),
    href: SEARCH_URL,
    expect: null,
  },
  {
    name: 'old split pane (/jobs/search/): the h1 title link, company and the span location row; stale search-page title ignored',
    html: splitPane,
    href: 'https://www.linkedin.com/jobs/search/?currentJobId=4000000001&f_AL=true',
    expect: { title: 'Software Engineer Intern', company: 'Example Robotics', location: 'Markham, ON', url: 'https://www.linkedin.com/jobs/view/4000000001/' },
  },
  {
    name: 'old split pane, ?currentJobId= naming a job whose pane isn\'t showing: no row',
    html: splitPane,
    href: 'https://www.linkedin.com/jobs/search/?currentJobId=4000000002&f_AL=true',
    expect: null,
  },
  {
    name: '/jobs/view/{id}/: document.title, the company link, the location span next to "ago"; URL without the query',
    html: fixture('view.html'),
    href: 'https://www.linkedin.com/jobs/view/4000000009/?refId=placeholder',
    expect: { title: 'Backend Developer', company: 'Example Systems', location: 'Toronto, ON', url: 'https://www.linkedin.com/jobs/view/4000000009/' },
  },
]

function dumpDom(url, profile) {
  return new Promise((resolve) => {
    let html = ''
    const args = ['--headless=new', `--user-data-dir=${profile}`, '--virtual-time-budget=5000', '--allow-file-access-from-files', '--dump-dom', url]
    if (process.platform === 'linux') args.unshift('--no-sandbox')
    const chrome = spawn(CHROME, args)
    chrome.stdout.on('data', (chunk) => {
      html += chunk
      if (html.includes('</html>')) chrome.kill('SIGKILL')
    })
    // The backstop is reported, not hidden.
    let stoppedByBackstop = false
    const timer = setTimeout(() => {
      stoppedByBackstop = true
      chrome.kill('SIGKILL')
    }, 30_000)
    chrome.on('exit', () => {
      clearTimeout(timer)
      resolve({ html, why: stoppedByBackstop ? ' (headless Chrome was stopped by the 30s backstop before printing the page)' : '' })
    })
  })
}

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

test('LinkedIn parser in headless Chrome', { skip: CHROME ? false : 'headless Chrome not found (set CHROME_PATH to run the DOM test)' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-dom-'))
  try {
    await build({ entryPoints: [path.join(ROOT, 'src', 'parsers', 'linkedin.ts')], bundle: true, format: 'iife', globalName: 'LinkedIn', outfile: path.join(dir, 'linkedin.js'), logLevel: 'warning' })
    const cases = JSON.stringify(CASES.map(({ html, href }) => ({ html, href }))).replace(/<\//g, '<\\/')
    const page = `<!doctype html><html><body>
<script src="linkedin.js"></script>
<script>
  const cases = ${cases}
  const out = []
  let pending = cases.length
  cases.forEach((c, i) => {
    const frame = document.createElement('iframe')
    frame.style.width = '1280px'
    frame.style.height = '900px'
    frame.onload = () => {
      try {
        const doc = frame.contentDocument
        out[i] = { result: LinkedIn.extractLinkedInJob(doc, c.href), applyControls: doc.querySelectorAll(LinkedIn.linkedinParser.getApplyButtonSelector()).length }
      } catch (e) {
        out[i] = { error: String(e) }
      }
      if (--pending === 0) document.body.setAttribute('data-result', JSON.stringify(out))
    }
    frame.srcdoc = c.html
    document.body.appendChild(frame)
  })
</script></body></html>`
    fs.writeFileSync(path.join(dir, 'page.html'), page)
    const { html, why } = await dumpDom(pathToFileURL(path.join(dir, 'page.html')).href, path.join(dir, 'profile'))
    const raw = html.match(/<body[^>]*data-result="([^"]*)"/)?.[1]
    assert.ok(raw, `the page left no result${why}`)
    const out = JSON.parse(unescape(raw))

    for (const [i, c] of CASES.entries()) {
      await t.test(c.name, () => {
        assert.equal(out[i]?.error, undefined)
        assert.deepEqual(out[i].result, c.expect)
        assert.ok(out[i].applyControls >= 1, 'the Easy Apply selector matches the page\'s control')
      })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
