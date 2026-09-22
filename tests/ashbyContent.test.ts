// The real src/content/ashby.ts against a fake Ashby board
// (fakes/ashby-page.ts): it logs on a trusted click of the Submit Application
// button while an /application route is showing, and nothing else — including
// after an in-app move, since Ashby is a single-page app.
import { clickListeners, FakeElement, goTo, page, POSTING_ID, sent } from './fakes/ashby-page'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/content/ashby'

const APPLICATION = `https://jobs.ashbyhq.com/northwind/${POSTING_ID}/application`
const submitButton = new FakeElement(true)
const somethingElse = new FakeElement(false)
const click = (target: unknown, isTrusted = true) => clickListeners.forEach((listener) => listener({ isTrusted, target }))
const LOGGED = {
  type: 'JOB_APPLICATION_LOGGED',
  payload: {
    title: 'Staff Security Engineer',
    company: 'Northwind Robotics',
    location: 'New York, NY (HQ); Remote (US)',
    url: `https://jobs.ashbyhq.com/northwind/${POSTING_ID}`,
  },
}

test('Ashby content script', async (t) => {
  await t.test('one capture-phase click listener on document', () => {
    assert.equal(clickListeners.length, 1)
  })

  await t.test('a trusted Submit Application click logs the job, with the posting URL (no /application)', () => {
    click(submitButton)
    assert.deepEqual(sent, [LOGGED])
  })

  await t.test('an untrusted click, or a click elsewhere, logs nothing', () => {
    click(submitButton, false)
    click(somethingElse)
    assert.equal(sent.length, 1)
  })

  await t.test('on the Overview route, the same click logs nothing', () => {
    goTo(`https://jobs.ashbyhq.com/northwind/${POSTING_ID}`)
    click(submitButton)
    assert.equal(sent.length, 1)
  })

  await t.test('after an in-app move back to /application, the same instance logs again', () => {
    goTo(APPLICATION)
    click(submitButton)
    assert.equal(sent.length, 2)
    assert.deepEqual(sent[1], LOGGED)
  })

  await t.test('a page it can\'t read (no heading, no logo, no " @ " in the title) logs nothing', () => {
    page.heading = ''
    page.company = ''
    page.title = 'Ashby'
    click(submitButton)
    assert.equal(sent.length, 2)
  })
})
