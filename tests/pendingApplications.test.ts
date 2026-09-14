// Greenhouse two-phase logging in Node: the real lib/pendingApplications.ts
// (the pending entry recorded at the Submit click, taken at the
// confirmation page) and greenhouseParser.applicationState() on real path
// shapes. chrome.storage.session is faked: async, with a small delay, and
// deep-cloning on get and set like real chrome.storage (CLAUDE.md, the
// 2026-09-09 mock-fidelity lesson).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordPendingApplication, takePendingApplication, PENDING_WINDOW_MS } from '../src/lib/pendingApplications'
import { greenhouseParser } from '../src/parsers/greenhouse'

const store: Record<string, unknown> = {}
const tick = () => new Promise((r) => setTimeout(r, 5))
;(globalThis as any).chrome = {
  storage: {
    session: {
      async get(k: string) {
        await tick()
        return k in store ? { [k]: structuredClone(store[k]) } : {}
      },
      async set(o: Record<string, unknown>) {
        await tick()
        for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v)
      },
    },
  },
}

const job = (title: string) => ({ title, company: 'PlanetScale', location: 'SF', url: 'https://job-boards.greenhouse.io/planetscale/jobs/1' })
const K = 'https://job-boards.greenhouse.io|planetscale/1'

test('Greenhouse pending applications', async (t) => {
  const check = (name: string, ok: boolean, detail: unknown = '') => t.test(name, () => assert.ok(ok, JSON.stringify(detail)))

  await recordPendingApplication(K, job('First click'))
  await check('confirmation after a click returns the payload', (await takePendingApplication(K))?.title === 'First click')
  await check('a second confirmation (reload) returns null', (await takePendingApplication(K)) === null)
  await check('confirmation for an unknown key returns null', (await takePendingApplication('https://job-boards.greenhouse.io|other/2')) === null)

  await recordPendingApplication(K, job('Failed attempt'))
  await recordPendingApplication(K, job('Final click'))
  await check('a later click replaces an earlier one', (await takePendingApplication(K))?.title === 'Final click')

  const realNow = Date.now
  await recordPendingApplication(K, job('Old click'))
  Date.now = () => realNow() + PENDING_WINDOW_MS + 1000
  const expired = await takePendingApplication(K)
  Date.now = realNow
  await check('an entry older than 30 minutes returns null', expired === null)
  await check('the expired entry was deleted, not left behind', JSON.stringify(store.pendingApplications) === '{}', store.pendingApplications)

  // A pending write and a confirmation fired at the same instant: with the
  // lock the write lands first (call order), so the confirmation sees it.
  const [, got] = await Promise.all([recordPendingApplication(K, job('Concurrent')), takePendingApplication(K)])
  await check('pending write + confirmation fired together: confirmation sees the write', got?.title === 'Concurrent')
  // Two confirmations at once: exactly one gets the payload.
  await recordPendingApplication(K, job('Once'))
  const both = await Promise.all([takePendingApplication(K), takePendingApplication(K)])
  await check('two confirmations at once: exactly one logs', both.filter(Boolean).length === 1, both.map((b) => b?.title ?? null))
})

test('greenhouseParser.applicationState()', async (t) => {
  const state = (path: string) => {
    ;(globalThis as any).window = { location: { pathname: path } }
    return greenhouseParser.applicationState?.() ?? null
  }
  const check = (name: string, ok: boolean, detail: unknown = '') => t.test(name, () => assert.ok(ok, JSON.stringify(detail)))
  await check('form page', JSON.stringify(state('/planetscale/jobs/4107018009')) === '{"key":"planetscale/4107018009","onConfirmationPage":false}', state('/planetscale/jobs/4107018009'))
  await check('confirmation page', JSON.stringify(state('/planetscale/jobs/4107018009/confirmation')) === '{"key":"planetscale/4107018009","onConfirmationPage":true}', state('/planetscale/jobs/4107018009/confirmation'))
  await check('same key on both pages', state('/anthropic/jobs/5183044008')?.key === state('/anthropic/jobs/5183044008/confirmation')?.key)
  await check('board page is not an application', state('/planetscale') === null)
  await check('other sub-page is not an application', state('/planetscale/jobs/4107018009/other') === null)
})
