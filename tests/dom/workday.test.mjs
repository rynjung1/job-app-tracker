// The Workday parser's posting-DOM capture (src/parsers/workday.ts) against
// the real, trimmed markup of four public postings (tests/fixtures/workday),
// with real selectors, in headless Chrome. Also: the Submit control and the
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
    // Reported, not hidden: see popup.test.mjs.
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

test('Workday posting DOM in headless Chrome', { skip: CHROME ? false : 'headless Chrome not found (set CHROME_PATH to run the DOM test)' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workday-dom-'))
  try {
    await build({ entryPoints: [path.join(ROOT, 'src', 'parsers', 'workday.ts')], bundle: true, format: 'iife', globalName: 'Workday', outfile: path.join(dir, 'workday.js'), logLevel: 'warning' })
    const sections = CASES.map((c) => `<section id="${c.name}">${fs.readFileSync(path.join(FIXTURES, `${c.name}-posting.html`), 'utf8')}</section>`).join('\n')
    const page = `<!doctype html><html><body>
${sections}
<section id="review" data-automation-id="applyFlowReviewPage"><h2 data-automation-id="jobTitleHeading">Senior System Software Engineer, Agentic Kernel Development</h2><div data-automation-id="progressBarActiveStep" aria-label="current step 8 of 8">Review</div><button data-automation-id="pageFooterBackButton">Back</button><button data-automation-id="pageFooterNextButton">Submit</button></section>
<section id="step3"><div data-automation-id="progressBarActiveStep" aria-label="current step 3 of 8">My Experience</div><button data-automation-id="pageFooterBackButton">Back</button><button data-automation-id="pageFooterNextButton">Save and Continue</button></section>
<script src="workday.js"></script>
<script>
  const cases = ${JSON.stringify(CASES.map(({ name, href }) => ({ name, href })))}
  const out = {}
  for (const c of cases) out[c.name] = Workday.captureFromPostingDom(document.getElementById(c.name), c.href)
  out.applyControls = document.querySelectorAll(Workday.WORKDAY_APPLY_CONTROL_SELECTOR).length
  // The footer control is the same on both steps; only the page differs.
  const review = document.getElementById('review')
  const step3 = document.getElementById('step3')
  out.submitControls = {
    review: review.querySelectorAll(Workday.WORKDAY_SUBMIT_CONTROL_SELECTOR).length,
    step3: step3.querySelectorAll(Workday.WORKDAY_SUBMIT_CONTROL_SELECTOR).length,
    postings: document.querySelectorAll(Workday.WORKDAY_SUBMIT_CONTROL_SELECTOR).length - 2,
  }
  out.finalStep = { review: Workday.isFinalReviewStep(review), step3: Workday.isFinalReviewStep(step3) }
  // The review container removed: the progress bar alone still decides.
  review.removeAttribute('data-automation-id')
  out.finalStepWithoutContainer = Workday.isFinalReviewStep(review)
  out.reviewTitle = Workday.reviewPageJobTitle(review)
  document.body.setAttribute('data-result', JSON.stringify(out))
</script></body></html>`
    fs.writeFileSync(path.join(dir, 'page.html'), page)
    const { html, why } = await dumpDom(pathToFileURL(path.join(dir, 'page.html')).href, path.join(dir, 'profile'))
    const raw = html.match(/<body[^>]*data-result="([^"]*)"/)?.[1]
    assert.ok(raw, `the page left no result${why}`)
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
    await t.test('the Apply control selector finds each posting\'s one Apply link; the Submit control matches the footer button on both steps, and only the Review page counts as the final step', () => {
      assert.equal(out.applyControls, CASES.length)
      assert.deepEqual(out.submitControls, { review: 1, step3: 1, postings: 0 })
      assert.deepEqual(out.finalStep, { review: true, step3: false })
      assert.equal(out.finalStepWithoutContainer, true)
      assert.equal(out.reviewTitle, 'Senior System Software Engineer, Agentic Kernel Development')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
