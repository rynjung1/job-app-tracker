// The real src/content/workday.ts on a fake Workday page
// (fakes/workday-page.ts), moved through the app the way a user does: job
// search, a posting, its Apply control, the application routes, the final
// Submit. Checks the click-time capture (2026-09-14), the job JSON fallback,
// and that the placeholder Submit selector logs nothing.
import { FakeElement, clickListeners, fetches, htmlAttributes, navigateInApp, page, sent } from './fakes/workday-page'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CAPTURE_COUNT_ATTRIBUTE, workdayParser } from '../src/parsers/workday'
import '../src/content/workday'

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/workday', name), 'utf8'))
const settle = () => new Promise((r) => setTimeout(r, 20))
const click = async (target: unknown, isTrusted = true) => {
  clickListeners.forEach((listener) => listener({ isTrusted, target }))
  await settle()
}

const NVIDIA = 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-System-Software-Engineer--Agentic-Kernel-Development_JR2025621'
const NVIDIA_POSTING = { title: 'Senior System Software Engineer, Agentic Kernel Development', location: 'US, CA, Santa Clara', reqId: 'JR2025621' }
const apply = new FakeElement('adventureButton', 'Apply')
// Controls a Review page plausibly has; the placeholder matches none of them.
const plausibleSubmits = [new FakeElement('pageFooterNextButton', 'Submit'), new FakeElement('bottom-navigation-next-button', 'Submit')]
const testSubmit = new FakeElement('testFinalSubmit', 'Submit')

test('Workday content script', async (t) => {
  await t.test('on the job search page, an Apply-shaped click does nothing (no job in the address)', async () => {
    await click(apply)
    assert.equal(htmlAttributes[CAPTURE_COUNT_ATTRIBUTE], undefined)
    assert.equal(sent.length + fetches.length, 0)
  })

  await t.test('posting page: a trusted Apply click keeps the posting (count 1 on <html>), sends nothing, reads nothing; an untrusted one is ignored', async () => {
    navigateInApp(`/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-System-Software-Engineer--Agentic-Kernel-Development_JR2025621`)
    page.posting = NVIDIA_POSTING
    await click(apply, false)
    assert.equal(htmlAttributes[CAPTURE_COUNT_ATTRIBUTE], undefined)
    await click(apply)
    assert.equal(htmlAttributes[CAPTURE_COUNT_ATTRIBUTE], '1')
    assert.equal(sent.length + fetches.length, 0)
  })

  await t.test('application routes: with the placeholder selector, Submit-like clicks log nothing and read nothing', async () => {
    navigateInApp(`${new URL(NVIDIA).pathname}/apply/applyManually`)
    page.posting = null
    for (const control of [...plausibleSubmits, testSubmit]) await click(control)
    assert.equal(sent.length + fetches.length, 0)
  })

  // From here a test-only selector stands in for the one the observation
  // will pin, to exercise the Submit path itself.
  await t.test('final Submit (test selector): logs the kept posting, no network read; normalized URL and tenant Company', async () => {
    workdayParser.getApplyButtonSelector = () => '[data-automation-id="testFinalSubmit"]'
    await click(testSubmit, false)
    assert.equal(sent.length, 0)
    await click(testSubmit)
    assert.deepEqual(sent, [{ type: 'JOB_APPLICATION_LOGGED', payload: { title: NVIDIA_POSTING.title, company: 'nvidia', location: NVIDIA_POSTING.location, url: NVIDIA } }])
    assert.equal(fetches.length, 0)
  })

  await t.test('landed on /apply without an Apply click: one same-origin job JSON read, then logged from it', async () => {
    const bmo = fixture('bmo-job.json').jobPostingInfo
    navigateInApp(`https://bmo.wd3.myworkdayjobs.com/en-US/External/job/Toronto-ON-CAN/Sr-Application-Developer----Java---AWS---Payment-Systems---Leadership-_R260009659/apply/autofillWithResume`)
    page.fetchAnswer = { status: 200, body: fixture('bmo-job.json') }
    await click(testSubmit)
    assert.deepEqual(fetches, ['https://bmo.wd3.myworkdayjobs.com/wday/cxs/bmo/External/job/Toronto-ON-CAN/Sr-Application-Developer----Java---AWS---Payment-Systems---Leadership-_R260009659'])
    assert.deepEqual(sent.at(-1), { type: 'JOB_APPLICATION_LOGGED', payload: { title: bmo.title, company: 'bmo', location: bmo.location, url: bmo.externalUrl } })
    assert.equal(sent.length, 2)
  })

  await t.test('the JSON read fails (404, then a network error): nothing logged', async () => {
    navigateInApp('https://mastercard.wd1.myworkdayjobs.com/en-US/CorporateCareers/job/OFallon-Missouri/Senior-Software-Engineer_R-290078/apply')
    page.fetchAnswer = { status: 404, body: {} }
    await click(testSubmit)
    page.fetchAnswer = null
    await click(testSubmit)
    assert.equal(fetches.length, 3)
    assert.equal(sent.length, 2)
  })

  await t.test('a Submit on an address that names no job: no read, nothing logged', async () => {
    navigateInApp('https://mastercard.wd1.myworkdayjobs.com/en-US/CorporateCareers/userHome')
    await click(testSubmit)
    assert.equal(fetches.length, 3)
    assert.equal(sent.length, 2)
  })
})
