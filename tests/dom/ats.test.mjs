// The Lever and Ashby parsers (src/parsers/lever.ts, src/parsers/ashby.ts) on
// fixture pages in headless Chrome, so the selectors, nextElementSibling and
// the trimming run against real layout. Each case is its own iframe document,
// parsed at a real address for that site. Skipped with a message when Chrome
// isn't found (set CHROME_PATH).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const fixture = (site, name) => fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', site, name), 'utf8')

function which(cmd) {
  const found = spawnSync('which', [cmd], { encoding: 'utf8' })
  return found.status === 0 ? found.stdout.trim() : null
}
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(which),
].find((p) => p && fs.existsSync(p))

const leverApply = fixture('lever', 'apply.html')
const ashbyApplication = fixture('ashby', 'application.html')
const POSTING_ID = '11111111-2222-4333-8444-555555555555'
const LEVER_URL = `https://jobs.lever.co/northwind/${POSTING_ID}/apply`
const ASHBY_URL = `https://jobs.ashbyhq.com/northwind/${POSTING_ID}/application`
const LEVER_JOB = {
  title: 'Staff Product Designer',
  company: 'Northwind Robotics',
  location: 'London, United Kingdom',
  url: `https://jobs.lever.co/northwind/${POSTING_ID}`,
}
const ASHBY_JOB = {
  title: 'Staff Security Engineer',
  company: 'Northwind Robotics',
  location: 'New York, NY (HQ); Remote (US)',
  url: `https://jobs.ashbyhq.com/northwind/${POSTING_ID}`,
}
// The apply page without its header block, so document.title is the only
// source for the title as well as the company.
const leverNoHeader = leverApply.replace(/<div class="section page-centered posting-header">[\s\S]*?<\/div>\s*<\/div>/, '')
const retitle = (html, title) => html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)

const CASES = [
  {
    site: 'lever',
    name: 'Lever: the apply page gives the title, company, location, and the posting URL without /apply',
    html: leverApply,
    href: LEVER_URL,
    expect: LEVER_JOB,
    detects: true,
  },
  {
    site: 'lever',
    name: 'Lever: the same posting on the EU host keeps that host in the URL',
    html: leverApply,
    href: `https://jobs.eu.lever.co/northwind/${POSTING_ID}/apply`,
    expect: { ...LEVER_JOB, url: `https://jobs.eu.lever.co/northwind/${POSTING_ID}` },
    detects: true,
  },
  {
    site: 'lever',
    name: 'Lever: with no header block, document.title splits at its first " - ", so a title containing " - " survives',
    html: retitle(leverNoHeader, 'Northwind Robotics - Android Engineer - Experience'),
    href: LEVER_URL,
    expect: { ...LEVER_JOB, title: 'Android Engineer - Experience', location: null },
    detects: true,
  },
  {
    site: 'lever',
    name: 'Lever: a company name written with two spaces before the dash is trimmed',
    html: retitle(leverNoHeader, 'Northwind Robotics  - Staff Product Designer'),
    href: LEVER_URL,
    expect: { ...LEVER_JOB, location: null },
    detects: true,
  },
  {
    site: 'lever',
    name: 'Lever: the posting page (not /apply) gives no row',
    html: leverApply,
    href: `https://jobs.lever.co/northwind/${POSTING_ID}`,
    expect: null,
    detects: false,
  },
  {
    site: 'lever',
    name: 'Lever: no header and a title with no separator gives no row',
    html: retitle(leverNoHeader, 'Careers at Northwind Robotics'),
    href: LEVER_URL,
    expect: null,
    detects: true,
  },
  {
    site: 'ashby',
    name: 'Ashby: the application page gives the trimmed title, the company from the header logo, the location section, and og:url',
    html: ashbyApplication,
    href: ASHBY_URL,
    expect: ASHBY_JOB,
    detects: true,
  },
  {
    site: 'ashby',
    name: 'Ashby: with no logo image, the company comes from document.title',
    html: ashbyApplication.replace(/<img alt="Northwind Robotics"[^>]*>/, ''),
    href: ASHBY_URL,
    expect: ASHBY_JOB,
    detects: true,
  },
  {
    site: 'ashby',
    name: 'Ashby: with no og:url, the posting URL is built from the path',
    html: ashbyApplication.replace(/<meta property="og:url"[^>]*>/, ''),
    href: ASHBY_URL,
    expect: ASHBY_JOB,
    detects: true,
  },
  {
    site: 'ashby',
    name: 'Ashby: the Overview route (no /application) gives no row',
    html: ashbyApplication,
    href: `https://jobs.ashbyhq.com/northwind/${POSTING_ID}`,
    expect: null,
    detects: false,
  },
  {
    site: 'ashby',
    name: 'Ashby: no heading, no logo and a title with no " @ " gives no row',
    html: retitle(ashbyApplication.replace(/<h1[^>]*>[^<]*<\/h1>/, '').replace(/<img alt="Northwind Robotics"[^>]*>/, ''), 'Ashby'),
    href: ASHBY_URL,
    expect: null,
    detects: true,
  },
]

function dumpDom(url, profile) {
  return new Promise((resolve) => {
    let html = ''
    let stoppedByBackstop = false
    const args = ['--headless=new', `--user-data-dir=${profile}`, '--virtual-time-budget=8000', '--dump-dom', url]
    if (process.platform === 'linux') args.unshift('--no-sandbox')
    const chrome = spawn(CHROME, args)
    chrome.stdout.on('data', (chunk) => {
      html += chunk
      if (html.includes('</html>')) chrome.kill('SIGKILL')
    })
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

test('Lever and Ashby parsers in headless Chrome', { skip: CHROME ? false : 'headless Chrome not found (set CHROME_PATH to run the DOM test)' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-dom-'))
  try {
    await build({ entryPoints: [path.join(ROOT, 'src', 'parsers', 'lever.ts')], bundle: true, format: 'iife', globalName: 'Lever', outfile: path.join(dir, 'lever.js'), logLevel: 'warning' })
    await build({ entryPoints: [path.join(ROOT, 'src', 'parsers', 'ashby.ts')], bundle: true, format: 'iife', globalName: 'Ashby', outfile: path.join(dir, 'ashby.js'), logLevel: 'warning' })
    const cases = JSON.stringify(CASES.map(({ site, html, href }) => ({ site, html, href }))).replace(/<\//g, '<\\/')
    const page = `<!doctype html><html><body>
<script src="lever.js"></script>
<script src="ashby.js"></script>
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
        out[i] = c.site === 'lever'
          ? {
              result: Lever.extractLeverJob(doc, c.href),
              detects: Lever.isLeverApplyPage(c.href),
              forms: doc.querySelectorAll(Lever.LEVER_FORM_SELECTOR).length,
              buttons: doc.querySelectorAll(Lever.leverParser.getApplyButtonSelector()).length,
              nativeSubmitButtons: doc.querySelectorAll('button[type="submit"]:not(.hidden)').length,
            }
          : {
              result: Ashby.extractAshbyJob(doc, c.href),
              detects: Ashby.isAshbyApplicationPage(c.href),
              buttons: doc.querySelectorAll(Ashby.ashbyParser.getApplyButtonSelector()).length,
              forms: doc.querySelectorAll('form').length,
              nativeSubmitButtons: doc.querySelectorAll('[type="submit"]').length,
            }
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
        assert.equal(out[i].detects, c.detects)
      })
    }

    await t.test('Lever: the fixture has one form#application-form and one #btn-submit, and its only native submit button is the hidden hCaptcha one', () => {
      const lever = out[0]
      assert.equal(lever.forms, 1)
      assert.equal(lever.buttons, 1)
      assert.equal(lever.nativeSubmitButtons, 0)
    })

    await t.test('Ashby: the fixture has exactly one submit button, and no form or submit-type element at all', () => {
      const ashby = out[6]
      assert.equal(ashby.buttons, 1)
      assert.equal(ashby.forms, 0)
      assert.equal(ashby.nativeSubmitButtons, 0)
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
