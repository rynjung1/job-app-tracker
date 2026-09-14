// The Workday parser's posting-DOM capture (src/parsers/workday.ts) against
// the real, trimmed markup of four public postings (tests/fixtures/workday),
// with real selectors, in headless Chrome. Also: the placeholder Submit
// selector matches nothing on a page with plausible Submit controls. Skipped
// with a message when Chrome isn't found (set CHROME_PATH).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'workday')

function which(cmd) {
  const found = spawnSync('which', [cmd], { encoding: 'utf8' })
  return found.status === 0 ? found.stdout.trim() : null
}
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(which),
].find((p) => p && fs.existsSync(p))

// Each fixture's page address (the posting, with its locale) and what the
// capture must hold: the fixture's own text, the first location, the tenant.
const CASES = [
  { name: 'nvidia', href: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-System-Software-Engineer--Agentic-Kernel-Development_JR2025621', title: 'Senior System Software Engineer, Agentic Kernel Development', location: 'US, CA, Santa Clara', reqId: 'JR2025621' },
  { name: 'bmo', href: 'https://bmo.wd3.myworkdayjobs.com/en-US/External/job/Toronto-ON-CAN/Sr-Application-Developer----Java---AWS---Payment-Systems---Leadership-_R260009659', title: 'Sr. Application Developer - (Java / AWS / Payment Systems / Leadership)', location: 'Toronto, ON, CAN', reqId: 'R260009659' },
  { name: 'wf', href: 'https://wd1.myworkdaysite.com/en-US/recruiting/wf/WellsFargoJobs/job/SACRAMENTO-CA/Sacramento-Capital-District---Relationship-Banker_R-575483', title: 'Sacramento Capital District - Relationship Banker', location: 'SACRAMENTO, CA', reqId: 'R-575483' },
  { name: 'adobe', href: 'https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/job/Lehi/Sr-Cloud-Security-Engineer_R171604', title: 'Sr Cloud Security Engineer', location: 'Lehi', reqId: 'R171604' },
]

function dumpDom(url, profile) {
  return new Promise((resolve) => {
    let html = ''
    const args = ['--headless=new', `--user-data-dir=${profile}`, '--virtual-time-budget=3000', '--allow-file-access-from-files', '--dump-dom', url]
    if (process.platform === 'linux') args.unshift('--no-sandbox')
    const chrome = spawn(CHROME, args)
    chrome.stdout.on('data', (chunk) => {
      html += chunk
      if (html.includes('</html>')) chrome.kill('SIGKILL')
    })
    const timer = setTimeout(() => chrome.kill('SIGKILL'), 30_000)
    chrome.on('exit', () => {
      clearTimeout(timer)
      resolve(html)
    })
  })
}

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

test('Workday posting DOM in headless Chrome', { skip: CHROME ? false : 'headless Chrome not found (set CHROME_PATH to run the DOM test)' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workday-dom-'))
  try {
    await build({ entryPoints: [path.join(ROOT, 'src', 'parsers', 'workday.ts')], bundle: true, format: 'iife', globalName: 'Workday', outfile: path.join(dir, 'workday.js'), logLevel: 'warning' })
    const sections = CASES.map((c) => `<section id="${c.name}">${fs.readFileSync(path.join(FIXTURES, `${c.name}-posting.html`), 'utf8')}</section>`).join('\n')
    const page = `<!doctype html><html><body>
${sections}
<section id="review"><button data-automation-id="pageFooterNextButton">Submit</button><button type="submit">Submit</button><div role="button" data-automation-id="bottom-navigation-next-button">Submit</div></section>
<script src="workday.js"></script>
<script>
  const cases = ${JSON.stringify(CASES.map(({ name, href }) => ({ name, href })))}
  const out = {}
  for (const c of cases) out[c.name] = Workday.captureFromPostingDom(document.getElementById(c.name), c.href)
  out.placeholderMatches = document.querySelectorAll(Workday.WORKDAY_SUBMIT_SELECTOR_PLACEHOLDER).length
  out.applyControls = document.querySelectorAll(Workday.WORKDAY_APPLY_CONTROL_SELECTOR).length
  document.body.setAttribute('data-result', JSON.stringify(out))
</script></body></html>`
    fs.writeFileSync(path.join(dir, 'page.html'), page)
    const html = await dumpDom(pathToFileURL(path.join(dir, 'page.html')).href, path.join(dir, 'profile'))
    const raw = html.match(/<body[^>]*data-result="([^"]*)"/)?.[1]
    assert.ok(raw, 'the page left no result')
    const out = JSON.parse(unescape(raw))

    for (const c of CASES) {
      await t.test(`${c.name}: title, first location, requisition id, normalized URL, tenant Company`, () => {
        const url = new URL(c.href)
        assert.deepEqual(out[c.name], {
          posting: { title: c.title, company: c.name, location: c.location, url: `${url.origin}${url.pathname.replace(/^\/en-US/, '')}` },
          reqId: c.reqId,
        })
      })
    }
    await t.test('the DOM capture agrees with the job JSON (nvidia, bmo, wf): same title, location and URL', () => {
      for (const name of ['nvidia', 'bmo', 'wf']) {
        const info = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}-job.json`), 'utf8')).jobPostingInfo
        assert.deepEqual(
          { title: out[name].posting.title, location: out[name].posting.location, url: out[name].posting.url },
          { title: info.title, location: info.location, url: info.externalUrl },
          name,
        )
      }
    })
    await t.test('the Apply control selector finds each posting\'s one Apply link; the placeholder Submit selector matches nothing', () => {
      assert.equal(out.applyControls, CASES.length)
      assert.equal(out.placeholderMatches, 0)
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
