// Content-script scope (2026-09-14): the LinkedIn script now runs on every
// www.linkedin.com page, because moving from /feed/ to /jobs/ inside the app
// is a pushState, not a page load. The real src/content/linkedin.ts, loaded
// on /feed/ against a fake page (fakes/linkedin-page.ts), then moved to a
// job page the way the app does it. Plus the manifest's match patterns,
// read from manifest.config.ts.
import { FakeElement, clickListeners, navigateInApp, sent } from './fakes/linkedin-page'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import '../src/content/linkedin'

const click = (target: unknown, isTrusted = true) => clickListeners.forEach((listener) => listener({ isTrusted, target }))
const easyApply = new FakeElement(true)

test('LinkedIn content script outside /jobs/', async (t) => {
  await t.test('loaded on /feed/: one capture-phase click listener on document', () => {
    assert.equal(clickListeners.length, 1)
  })

  await t.test('an Easy Apply-shaped click on /feed/ sends nothing (detect() checks the path at click time)', () => {
    click(easyApply)
    assert.equal(sent.length, 0)
  })

  await t.test('after an in-app move to /jobs/view/, the same instance logs the Easy Apply click', () => {
    navigateInApp('/jobs/view/4460524353/')
    click(easyApply)
    assert.deepEqual(sent, [
      {
        type: 'JOB_APPLICATION_LOGGED',
        payload: { title: 'Software Engineer', company: 'Acme', location: null, url: 'https://www.linkedin.com/jobs/view/4460524353/' },
      },
    ])
  })

  await t.test('on the job page, an untrusted click or a click elsewhere sends nothing more', () => {
    click(easyApply, false)
    click(new FakeElement(false))
    assert.equal(sent.length, 1)
  })

  await t.test('back on /feed/ (in-app), an Easy Apply-shaped click sends nothing', () => {
    navigateInApp('/feed/')
    click(easyApply)
    assert.equal(sent.length, 1)
  })
})

test('manifest content-script matches: https only, LinkedIn on every page', () => {
  // tests/run.mjs runs from the repo root; the bundled test lives elsewhere.
  const source = fs.readFileSync(path.join(process.cwd(), 'manifest.config.ts'), 'utf8')
  const matches = [...source.matchAll(/^\s*matches: \[([^\]]*)\]/gm)].map((m) => m[1].trim())
  assert.deepEqual(matches, ["'https://www.linkedin.com/*'", "'https://job-boards.greenhouse.io/*/jobs/*'"])
})
