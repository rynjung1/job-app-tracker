// The real src/content/workday.ts on a fake Workday page
// (fakes/workday-page.ts), moved through the app the way a user does: job
// search, a posting, the application steps, the final Submit. Since
// 2026-09-21 the script keeps nothing and reads nothing: Workday's sign-in
// reloads the page, so at Submit it sends the address it is on and the
// background reads the job (tests/background.test.ts covers that half).
// What's checked here is which clicks send and which don't.
import { FakeElement, clickListeners, fetches, htmlAttributes, navigateInApp, page, pageWrites, sent } from './fakes/workday-page'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/content/workday'

// Five event-loop turns, as elsewhere: the handler is synchronous now, but
// a message that ever became async would still be caught.
const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((r) => setImmediate(r))
}
const click = async (target: unknown, isTrusted = true) => {
  clickListeners.forEach((listener) => listener({ isTrusted, target }))
  await settle()
}
const onReviewPage = (jobTitle = 'Senior System Software Engineer, Agentic Kernel Development') => {
  page.review = { reviewPage: true, activeStep: 'current step 8 of 8', jobTitle }
}
const onStep = (activeStep: string) => {
  page.review = { reviewPage: false, activeStep, jobTitle: '' }
}

const NVIDIA_PATH = '/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-System-Software-Engineer--Agentic-Kernel-Development_JR2025621'
const NVIDIA_URL = `https://nvidia.wd5.myworkdayjobs.com${NVIDIA_PATH.replace('/en-US', '')}`
const apply = new FakeElement('adventureButton', 'Apply')
const footerNext = new FakeElement('pageFooterNextButton', 'Submit')
const footerBack = new FakeElement('pageFooterBackButton', 'Back')

test('Workday content script', async (t) => {
  await t.test('on the job search page, a footer click does nothing (no job in the address)', async () => {
    onReviewPage()
    await click(footerNext)
    assert.equal(sent.length + fetches.length, 0)
  })

  await t.test('the posting page: the Apply control is no longer a trigger — nothing is kept, sent or read', async () => {
    navigateInApp(NVIDIA_PATH)
    page.posting = { title: 'Senior System Software Engineer, Agentic Kernel Development', location: 'US, CA, Santa Clara', reqId: 'JR2025621' }
    page.review = { reviewPage: false, activeStep: '', jobTitle: '' }
    await click(apply)
    assert.equal(sent.length + fetches.length, 0)
  })

  await t.test("an earlier step's Next button is the same control, and logs nothing", async () => {
    navigateInApp(`${NVIDIA_PATH}/apply/applyManually`)
    page.posting = null
    onStep('current step 3 of 8')
    await click(footerNext)
    assert.equal(sent.length, 0)
  })

  await t.test('the Review page: a trusted footer click sends the address and the page title, and reads nothing', async () => {
    navigateInApp(`${NVIDIA_PATH}/apply/autofillWithResume`)
    onReviewPage()
    await click(footerNext, false)
    assert.equal(sent.length, 0)
    await click(footerNext)
    assert.deepEqual(sent, [
      {
        type: 'WORKDAY_APPLICATION_SUBMITTED',
        payload: {
          url: `https://nvidia.wd5.myworkdayjobs.com${NVIDIA_PATH}/apply/autofillWithResume`,
          title: 'Senior System Software Engineer, Agentic Kernel Development',
        },
      },
    ])
    assert.equal(fetches.length, 0)
  })

  await t.test("the Back button is never the trigger, even on the Review page", async () => {
    await click(footerBack)
    assert.equal(sent.length, 1)
  })

  await t.test('the review container gone, the progress bar still says the last step: still sent', async () => {
    onStep('étape 8 sur 8')
    await click(footerNext)
    assert.equal(sent.length, 2)
    assert.equal((sent.at(-1) as { payload: { title: string } }).payload.title, '')
  })

  await t.test('neither mark: nothing sent', async () => {
    page.review = { reviewPage: false, activeStep: '', jobTitle: '' }
    await click(footerNext)
    onStep('step 8')
    await click(footerNext)
    assert.equal(sent.length, 2)
  })

  await t.test('on an address that names no job, the Review page logs nothing', async () => {
    navigateInApp('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/userHome')
    onReviewPage()
    await click(footerNext)
    assert.equal(sent.length, 2)
  })

  await t.test('the script never fetches anything, and wrote nothing to the page', () => {
    assert.deepEqual(fetches, [])
    assert.deepEqual(htmlAttributes, {})
    assert.deepEqual(pageWrites, [])
    assert.equal(NVIDIA_URL, 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-System-Software-Engineer--Agentic-Kernel-Development_JR2025621')
  })
})
