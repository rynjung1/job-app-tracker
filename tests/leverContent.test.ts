// The real src/content/lever.ts against a fake Lever apply page
// (fakes/lever-page.ts): it logs on the application form's submit event, not
// on the visible button's click, and only on an apply page it can read.
import { FakeElement, goTo, page, POSTING_ID, sent, submitListeners } from './fakes/lever-page'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/content/lever'

const APPLY = `https://jobs.lever.co/northwind/${POSTING_ID}/apply`
const form = new FakeElement('form#application-form')
const otherForm = new FakeElement('form#newsletter')
const submit = (target: unknown, isTrusted = true) => submitListeners.forEach((listener) => listener({ isTrusted, target }))

test('Lever content script', async (t) => {
  await t.test('one capture-phase submit listener on document', () => {
    assert.equal(submitListeners.length, 1)
  })

  await t.test("the application form's submit logs the job, with the posting URL (no /apply)", () => {
    submit(form)
    assert.deepEqual(sent, [
      {
        type: 'JOB_APPLICATION_LOGGED',
        payload: {
          title: 'Staff Product Designer',
          company: 'Northwind Robotics',
          location: 'London, United Kingdom',
          url: `https://jobs.lever.co/northwind/${POSTING_ID}`,
        },
      },
    ])
  })

  await t.test('an untrusted submit still logs: Lever submits by clicking a hidden button from its own script', () => {
    submit(form, false)
    assert.equal(sent.length, 2)
  })

  await t.test('another form on the page logs nothing', () => {
    submit(otherForm)
    assert.equal(sent.length, 2)
  })

  await t.test('on the posting page (not /apply), the same submit logs nothing', () => {
    goTo(`https://jobs.lever.co/northwind/${POSTING_ID}`)
    submit(form)
    assert.equal(sent.length, 2)
  })

  await t.test('back on the apply page, a page it can\'t read (no header, no separator in the title) logs nothing', () => {
    goTo(APPLY)
    page.header = ''
    page.title = 'Careers at Northwind Robotics'
    submit(form)
    assert.equal(sent.length, 2)
  })
})
