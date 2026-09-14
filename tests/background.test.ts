// The background worker in Node: the real withAuth, activeProvider wrapper,
// lib/authStatus, offline queue, message router and background listeners
// (src/background/index.ts registers them on import), against faked chrome,
// fetch and navigator (fakes/background-env.ts, imported first). Each case
// is one subtest; they share the listeners and run in order.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ctl, listeners, local, log, reset, sheet } from './fakes/background-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeJobUrl } from '../src/lib/safeUrl'
import { getActiveProvider } from '../src/providers/activeProvider'
import { AuthRequiredError } from '../src/providers/types'
import '../src/background/index'

const REF = { spreadsheetId: 'sheet1', sheetName: 'Sheet1', sheetId: 0 }
const settle = () => new Promise((r) => setTimeout(r, 60))
const flag = () => local.data.authStatus as { reason: string } | undefined
const needsReconnect = () => log.notifications.filter((n) => n.id === 'needs-reconnect')
const queue = () => (local.data.offlineQueue as unknown[] | undefined)?.length ?? 0
const recent = () => (local.data.recentApplications as any[] | undefined) ?? []
const d = (h: number) => new Date(Date.UTC(2026, 8, 13, h)).toISOString()

async function call() {
  const provider = await getActiveProvider()
  try {
    await provider.readHeaders(REF)
    return 'ok'
  } catch (e) {
    return e instanceof AuthRequiredError ? 'AuthRequiredError' : `other: ${(e as Error).message.slice(0, 40)}`
  }
}
function internal(message: unknown) {
  return new Promise((resolve) => listeners.onMessage[0](message, { origin: 'chrome-extension://testid' }, resolve))
}
function apply(company: string) {
  listeners.onMessage[0](
    { type: 'JOB_APPLICATION_LOGGED', payload: { title: 'Software Engineer Intern', company, location: 'Remote', url: 'https://www.linkedin.com/jobs/view/1/' } },
    { origin: 'https://www.linkedin.com' },
    () => {},
  )
}

test('background worker', async (t) => {
  const check = (name: string, ok: boolean, detail: unknown) => t.test(name, () => assert.ok(ok, JSON.stringify(detail)))

  // ---- Needs reconnect: detection, the flag, notifications. ----
  reset()
  ctl.tokenReject = true
  let r = await call()
  await check('getAuthToken rejects while online -> AuthRequiredError, flag, 1 notification, badge', r === 'AuthRequiredError' && !!flag() && needsReconnect().length === 1 && log.badge.join() === '!', { r, reason: flag()?.reason, notes: needsReconnect().length, badge: log.badge })

  reset()
  ctl.fetchPlan = [401, 401]
  r = await call()
  await check('401 survives the retry -> AuthRequiredError, flag', r === 'AuthRequiredError' && !!flag() && log.tokenCalls === 2, { r, tokenCalls: log.tokenCalls, reason: flag()?.reason })

  reset()
  ctl.fetchPlan = [401, 200]
  r = await call()
  await check('401 then success on the retry -> ok, no flag', r === 'ok' && !flag() && needsReconnect().length === 0, { r, flag: flag() })

  reset()
  ctl.fetchPlan = [500]
  r = await call()
  await check('500 -> ordinary error, no flag', r.startsWith('other') && !flag(), { r })

  reset()
  ctl.fetchPlan = ['abort']
  r = await call()
  await check('timeout (AbortError) -> ordinary error, no flag', r.startsWith('other') && !flag(), { r })

  reset()
  ctl.tokenReject = true
  ctl.online = false
  r = await call()
  await check('getAuthToken rejects while OFFLINE -> ordinary error, no flag', r.startsWith('other') && !flag() && needsReconnect().length === 0, { r })

  reset()
  ctl.tokenReject = true
  const five = await Promise.all([call(), call(), call(), call(), call()])
  await check('5 concurrent sign-in failures -> exactly 1 notification', five.every((x) => x === 'AuthRequiredError') && needsReconnect().length === 1, { five, notes: needsReconnect().length })

  ctl.tokenReject = false
  r = await call()
  await check('then a success -> flag cleared, badge off, notification cleared', r === 'ok' && !flag() && log.badge.at(-1) === '' && log.cleared.includes('needs-reconnect'), { r, badge: log.badge, cleared: log.cleared })

  // Drain-only failure: notifies once (first failure), later drains never.
  reset()
  await local.set({ sheetRef: REF, offlineQueue: [{ Company: 'Q' }] })
  ctl.tokenReject = true
  for (let i = 0; i < 3; i++) {
    listeners.onAlarm[0]({ name: 'retryOfflineQueue' })
    await settle()
  }
  await check('3 failing drains -> 1 notification (the first failure), queue kept', needsReconnect().length === 1 && queue() === 1, { notes: needsReconnect().length, queue: queue() })

  // Applies while signed out: one notification per apply, count included.
  reset()
  await local.set({ sheetRef: REF })
  ctl.tokenReject = true
  apply('Acme')
  await settle()
  apply('Beta')
  await settle()
  const afterApplies = needsReconnect().map((n) => n.message)
  listeners.onAlarm[0]({ name: 'retryOfflineQueue' })
  await settle()
  await check('2 applies signed out -> queued 2, notified per apply with the count; drain adds none', queue() === 2 && needsReconnect().length === afterApplies.length && afterApplies.at(-1)!.includes('2 applications are waiting'), { queue: queue(), messages: afterApplies, afterDrain: needsReconnect().length })

  // Reconnect: interactive sign-in works again; the immediate drain saves both.
  ctl.tokenReject = false
  const resp = (await internal({ type: 'RECONNECT_PROVIDER' })) as { ok: boolean; data: unknown }
  await check('RECONNECT_PROVIDER -> {saved: 2, waiting: 0}, queue empty, flag and badge cleared', resp.ok && JSON.stringify(resp.data) === '{"saved":2,"waiting":0}' && queue() === 0 && !flag() && log.badge.at(-1) === '' && log.cleared.includes('needs-reconnect'), { resp, queue: queue(), badge: log.badge.at(-1) })

  reset()
  await internal({ type: 'OPEN_SETTINGS', payload: { reconnect: true } })
  await check('OPEN_SETTINGS {reconnect: true} -> Settings window at ?reconnect=1', log.windows[0]?.endsWith('src/options/index.html?reconnect=1') ?? false, log.windows)

  // ---- Drained rows enter the recent list; Connect drains. ----
  const qrow = (company: string, h: number) => ({ Date: d(h), Company: company, Title: 'Queued role', Location: 'Remote', URL: 'https://jobs.example.com/q', 'Resume Version': 'SWE v3', Status: 'Applied', Notes: '' })
  reset()
  const existing = Array.from({ length: 19 }, (_, i) => ({ id: `old${i}`, company: `Old${i}`, title: 'T', location: null, url: '', date: d(4 + i), resumeVersion: '', status: 'Applied', sheetName: 'Sheet1', rowNumber: 100 + i }))
  await local.set({ sheetRef: REF, recentApplications: existing, offlineQueue: [qrow('QueuedNewest', 23), qrow('QueuedMiddle', 10), qrow('QueuedOldest', 1)] })
  listeners.onAlarm[0]({ name: 'retryOfflineQueue' })
  await settle()
  const list = recent()
  const names = list.map((e) => e.company)
  const sortedDesc = list.every((e, i) => i === 0 || e.date <= list[i - 1].date)
  const middle = list.find((e) => e.company === 'QueuedMiddle')
  await check('drain: 3 saved rows join 19 entries -> sorted by applied date, capped at 20 (QueuedOldest and Old0 drop), no toast', queue() === 0 && list.length === 20 && sortedDesc && names[0] === 'QueuedNewest' && !names.includes('QueuedOldest') && !names.includes('Old0') && middle?.rowNumber > 1 && middle?.status === 'Applied' && middle?.location === 'Remote' && log.notifications.length === 0, { length: list.length, first3: names.slice(0, 3), middleAt: names.indexOf('QueuedMiddle'), middleRow: middle?.rowNumber, last: names.at(-1), notes: log.notifications.length })

  reset()
  await local.set({ offlineQueue: [qrow('BeforeConnect', 12)] })
  const c = (await internal({ type: 'CONNECT_PROVIDER' })) as any
  await check('CONNECT_PROVIDER drains right away -> {sheetRef, saved: 1, waiting: 0}, entry in the list', c.ok && c.data.sheetRef.spreadsheetId === 'new1' && c.data.saved === 1 && c.data.waiting === 0 && queue() === 0 && recent()[0]?.company === 'BeforeConnect', { data: c.data, list: recent().map((e) => e.company) })

  // A drain that throws outside its per-row catch must not fail Connect
  // (whose "Try again" would create a second sheet).
  reset()
  await local.set({ offlineQueue: [qrow('WriteFails', 12)] })
  ctl.failQueueWrite = true
  const cf = (await internal({ type: 'CONNECT_PROVIDER' })) as any
  await check('CONNECT_PROVIDER whose drain throws (queue write fails) -> still ok, saved 0, waiting 1, sheet kept', cf.ok && cf.data.sheetRef.spreadsheetId === 'new1' && cf.data.saved === 0 && cf.data.waiting === 1 && (local.data.sheetRef as any)?.spreadsheetId === 'new1', cf)

  // ---- A failed notification Undo is visible. ----
  const entry = { id: 'n1', company: 'Acme', title: 'SWE Intern', location: null, url: '', date: d(12), resumeVersion: '', status: 'Applied', sheetName: 'Sheet1', rowNumber: 5 }
  reset()
  await local.set({ sheetRef: REF, recentApplications: [entry] })
  ctl.fetchPlan = [500]
  await listeners.onButtonClicked[0]('n1', 0)
  const undoFailed = log.notifications.filter((n) => n.id === 'undo-failed')
  await check('notification Undo fails (500) -> "undo-failed" notification, entry still Applied, Logged cleared', undoFailed.length === 1 && undoFailed[0].message === "Acme — SWE Intern is still logged. Use Undo in the extension's popup." && recent()[0].status === 'Applied' && needsReconnect().length === 0 && log.cleared.includes('n1'), { undoFailed, cleared: log.cleared })

  reset()
  await local.set({ sheetRef: REF, recentApplications: [entry], authStatus: { since: d(1), reason: 'x' } })
  ctl.tokenReject = true
  await listeners.onButtonClicked[0]('n1', 0)
  await check('notification Undo fails signed out (flag already set) -> "Sign-in needed" again, no undo-failed', needsReconnect().length === 1 && log.notifications.filter((n) => n.id === 'undo-failed').length === 0, log.notifications)

  reset()
  await local.set({ sheetRef: REF, recentApplications: [entry] })
  await listeners.onButtonClicked[0]('n1', 0)
  await check('notification Undo succeeds -> Cancelled, no failure notification', recent()[0].status === 'Cancelled' && log.notifications.length === 0, { status: recent()[0].status, notes: log.notifications })

  // ---- SET_STATUS, AUTH_REQUIRED, the URL check, Undo through the shared setter. ----
  const acme = { id: 's1', company: 'Acme', title: 'SWE Intern', location: 'Remote', url: 'https://www.linkedin.com/jobs/view/1/', date: d(12), resumeVersion: 'SWE v3', status: 'Applied', sheetName: 'Sheet1', rowNumber: 5 }
  const acmeRow = ['46277.5', 'Acme', 'SWE Intern', 'Remote', 'https://www.linkedin.com/jobs/view/1/', 'SWE v3', 'Applied', '']
  const setStatus = (status: unknown, entryId: unknown = 's1') => internal({ type: 'SET_STATUS', payload: { entryId, status } }) as Promise<any>
  const withAcme = async () => {
    reset()
    await local.set({ sheetRef: REF, recentApplications: [acme] })
    sheet.rows[5] = [...acmeRow]
  }

  await withAcme()
  let st = await setStatus('Interview')
  await check('SET_STATUS: row still matches -> exactly one write, "Interview" to Sheet1!G5; cached entry updated', st.ok && st.data.status === 'Interview' && sheet.writes.length === 1 && sheet.writes[0].range === 'Sheet1!G5' && JSON.stringify(sheet.writes[0].values) === '[["Interview"]]' && recent()[0].status === 'Interview', { resp: st, writes: sheet.writes })

  await withAcme()
  sheet.rows[5][1] = 'Acme (renamed)'
  st = await setStatus('Offer')
  await check('SET_STATUS: Company edited by hand -> STALE_ROW, nothing written, cached status unchanged', !st.ok && st.code === 'STALE_ROW' && sheet.writes.length === 0 && recent()[0].status === 'Applied', { resp: st, writes: sheet.writes })

  await withAcme()
  const unknownStatus = await setStatus('Hired')
  const nonString = await setStatus(42)
  const fetchesBeforeEntry = log.fetches.length
  const unknownEntry = await setStatus('Offer', 'no-such-entry')
  await check('SET_STATUS: unknown or non-string status refused before any request; unknown entry refused; nothing written', !unknownStatus.ok && !nonString.ok && !unknownEntry.ok && fetchesBeforeEntry === 0 && log.fetches.length === 0 && sheet.writes.length === 0, { unknownStatus: unknownStatus.error, nonString: nonString.error, unknownEntry: unknownEntry.error, fetches: log.fetches.length })

  await withAcme()
  ctl.tokenReject = true
  st = await setStatus('Offer')
  await check('SET_STATUS signed out -> AUTH_REQUIRED, sign-in flag set, nothing written', !st.ok && st.code === 'AUTH_REQUIRED' && !!flag() && sheet.writes.length === 0 && recent()[0].status === 'Applied', { resp: st })

  await withAcme()
  ctl.fetchPlan = [200, 200, 200, 500]
  st = await setStatus('Offer')
  await check('SET_STATUS: the Status write fails (500) -> error with no code, cached status unchanged', !st.ok && !st.code && recent()[0].status === 'Applied' && sheet.writes.length === 0, { resp: st })

  await withAcme()
  let responded = false
  const returned = listeners.onMessage[0]({ type: 'CANCEL_APPLICATION', payload: { entryId: 's1' } }, { origin: 'chrome-extension://testid' }, () => {
    responded = true
  })
  await settle()
  await check('CANCEL_APPLICATION is no longer an internal message: not handled, nothing read or written', returned === false && !responded && log.fetches.length === 0 && recent()[0].status === 'Applied', { returned, responded, fetches: log.fetches.length })

  await withAcme()
  ctl.tokenReject = true
  const save = (await internal({ type: 'SAVE_RESUME_VERSION', payload: { entryId: 's1', resumeVersion: 'SWE v4', skipIdentityCheck: false } })) as any
  await check('SAVE_RESUME_VERSION signed out -> AUTH_REQUIRED, nothing written', !save.ok && save.code === 'AUTH_REQUIRED' && sheet.writes.length === 0, save)

  await withAcme()
  await listeners.onButtonClicked[0]('s1', 0)
  await check('notification Undo, through the shared status setter -> "Cancelled" written to Sheet1!G5, cache Cancelled', recent()[0].status === 'Cancelled' && sheet.writes.length === 1 && sheet.writes[0].range === 'Sheet1!G5' && JSON.stringify(sheet.writes[0].values) === '[["Cancelled"]]', sheet.writes)

  const urls = { https: safeJobUrl('https://www.linkedin.com/jobs/view/1/'), http: safeJobUrl('http://example.com/x'), javascript: safeJobUrl('javascript:alert(1)'), data: safeJobUrl('data:text/html,hi'), empty: safeJobUrl(''), junk: safeJobUrl('not a url') }
  await check('safeJobUrl: https and http kept; javascript:, data:, empty and junk refused', urls.https === 'https://www.linkedin.com/jobs/view/1/' && urls.http === 'http://example.com/x' && urls.javascript === null && urls.data === null && urls.empty === null && urls.junk === null, urls)
})
