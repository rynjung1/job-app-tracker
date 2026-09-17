// The background worker in Node: the real withAuth, activeProvider wrapper,
// lib/authStatus, offline queue, message router and background listeners
// (src/background/index.ts registers them on import), against faked chrome,
// fetch and navigator (fakes/background-env.ts, imported first). Each case
// is one subtest; they share the listeners and run in order.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { alarms, ctl, HEADERS_WITH_LOG_ID, listeners, local, log, reset, session, sheet } from './fakes/background-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRow } from '../src/lib/buildRow'
import { matchLiveStatuses } from '../src/lib/liveStatuses'
import { sanitizeRow } from '../src/lib/sanitize'
import { safeJobUrl } from '../src/lib/safeUrl'
import { getActiveProvider } from '../src/providers/activeProvider'
import { AuthRequiredError } from '../src/providers/types'
import { ensureRetryAlarm } from '../src/background/offlineQueue'
import { DEFAULT_SHEET_TITLE, datedSheetTitle } from '../src/lib/sheetTitle'
import { duringSheetSwap } from '../src/background/sheetSwap'
import { drainOfflineQueue } from '../src/background/offlineQueue'
import '../src/background/index'

const REF = { spreadsheetId: 'sheet1', sheetName: 'Sheet1', sheetId: 0 }
// Lets the listeners' async work finish. The fakes answer with plain
// promises (no timers, no real Response; see fakeResponse), so all of that
// work runs as microtasks, and a few event-loop turns cover it however slow
// the machine is. This used to wait a fixed 60 ms, a race against wall time.
const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((r) => setImmediate(r))
}
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
// One job URL per company: the same URL twice within 24 hours is a reopened
// Easy Apply and isn't logged again (index.ts, since 2026-09-14).
function apply(company: string) {
  listeners.onMessage[0](
    { type: 'JOB_APPLICATION_LOGGED', payload: { title: 'Software Engineer Intern', company, location: 'Remote', url: `https://www.linkedin.com/jobs/view/${encodeURIComponent(company)}/` } },
    { origin: 'https://www.linkedin.com' },
    () => {},
  )
}

test('background worker', async (t) => {
  const check = (name: string, ok: boolean, detail: unknown) => t.test(name, () => assert.ok(ok, JSON.stringify(detail)))

  // ---- Worker start: the retry alarm (2026-09-14). Importing index.ts is
  // the worker starting, with no onInstalled event. ----
  await settle()
  const startAlarms = log.alarms.map((a) => `${a.name} ${JSON.stringify(a.info)}`)
  await check('worker start with no retry alarm -> creates it (every 5 minutes), without onInstalled', startAlarms.length === 1 && startAlarms[0] === 'retryOfflineQueue {"periodInMinutes":5}', startAlarms)

  reset()
  alarms.set('retryOfflineQueue', { periodInMinutes: 5 })
  await ensureRetryAlarm()
  await check('worker start with the retry alarm already there -> none created', log.alarms.length === 0 && alarms.has('retryOfflineQueue'), log.alarms)

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

  // One sheet per extension (2026-09-14): overlapping Connects (two Settings
  // pages) share one run; a stale page's Connect keeps the connected sheet.
  const spreadsheetCreates = () => log.fetches.filter((f) => f === '').length
  reset()
  const [connectA, connectB] = (await Promise.all([internal({ type: 'CONNECT_PROVIDER' }), internal({ type: 'CONNECT_PROVIDER' })])) as any[]
  await check('two CONNECT_PROVIDER at once -> exactly one spreadsheet created, both answered with it', connectA.ok && connectB.ok && spreadsheetCreates() === 1 && connectA.data.sheetRef.spreadsheetId === 'new1' && connectB.data.sheetRef.spreadsheetId === 'new1' && (local.data.sheetRef as any)?.spreadsheetId === 'new1', { connectA, connectB, creates: spreadsheetCreates() })

  reset()
  await local.set({ sheetRef: REF, offlineQueue: [qrow('StalePage', 12)] })
  const stalePage = (await internal({ type: 'CONNECT_PROVIDER' })) as any
  await check('CONNECT_PROVIDER with a sheet already connected (a stale Settings page) -> no spreadsheet created, the connected one kept and returned, the queue still saved', stalePage.ok && spreadsheetCreates() === 0 && stalePage.data.sheetRef.spreadsheetId === REF.spreadsheetId && (local.data.sheetRef as any)?.spreadsheetId === REF.spreadsheetId && stalePage.data.saved === 1 && queue() === 0, { stalePage, creates: spreadsheetCreates() })

  // ---- A sheet in Drive's trash, or deleted (2026-09-14). The fake follows
  // scripts/sheet-probe.js: trash changes no Sheets answer, only Drive's. ----
  const sheetFlag = () => local.data.sheetStatus as { state: string } | undefined
  const sheetNotes = () => log.notifications.filter((n) => n.id === 'sheet-problem')
  const driveChecks = () => log.fetches.filter((f) => f.includes('googleapis.com/drive')).length
  const appendCalls = () => log.fetches.filter((f) => f.includes(':append')).length
  const rowsFor = (company: string) => Object.values(sheet.rows).filter((values) => values[1] === company).length
  const tick = async () => {
    listeners.onAlarm[0]({ name: 'retryOfflineQueue' })
    await settle()
  }
  const sheetProvider = await getActiveProvider()
  const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof AuthRequiredError ? 'AuthRequiredError' : `other: ${(e as Error).name}`))

  reset()
  await local.set({ sheetRef: REF })
  ctl.trashedIds.add(REF.spreadsheetId)
  apply('Before Noticed Co')
  await settle()
  await check('trashed: a direct log still lands (Sheets answers as usual); the Drive check after it sets "trashed", the badge and one notification', rowsFor('Before Noticed Co') === 1 && sheetFlag()?.state === 'trashed' && driveChecks() === 1 && sheetNotes().length === 1 && sheetNotes()[0].title === "Your sheet is in Google Drive's trash" && log.badge.at(-1) === '!', { flag: sheetFlag(), drive: driveChecks(), notes: sheetNotes(), badge: log.badge })

  const appendsWhileTrashed = appendCalls()
  apply('While Trashed Co')
  await settle()
  await check('trashed: the next application is queued with no append; the notification repeats with the count', appendCalls() === appendsWhileTrashed && queue() === 1 && rowsFor('While Trashed Co') === 0 && sheetNotes().length === 2 && sheetNotes()[1].message.includes('1 application is waiting'), { appends: appendCalls() - appendsWhileTrashed, queue: queue(), notes: sheetNotes().map((n) => n.message) })

  await tick()
  await check('trashed: a retry tick asks Drive again and writes nothing, with no new notification', driveChecks() === 2 && appendCalls() === appendsWhileTrashed && queue() === 1 && sheetFlag()?.state === 'trashed' && sheetNotes().length === 2, { drive: driveChecks(), queue: queue() })

  await sheetProvider.readHeaders(REF)
  await check('trashed: a Sheets call that succeeds does not clear "trashed" (only Drive can)', sheetFlag()?.state === 'trashed', sheetFlag())

  ctl.trashedIds.delete(REF.spreadsheetId)
  await tick()
  await check('restored: the next tick gets trashed=false, clears the flag, badge and notification, and the drain writes the queue', !sheetFlag() && queue() === 0 && rowsFor('While Trashed Co') === 1 && log.badge.at(-1) === '' && log.cleared.includes('sheet-problem'), { flag: sheetFlag(), queue: queue(), badge: log.badge.at(-1), cleared: log.cleared })

  const trashedEntry = { id: 't1', company: 'Acme', title: 'SWE Intern', location: null, url: '', date: d(12), resumeVersion: '', status: 'Applied', sheetName: 'Sheet1', rowNumber: 5 }
  const trashedFlag = { state: 'trashed', since: d(1), reason: 'placeholder' }
  reset()
  await local.set({ sheetRef: REF, recentApplications: [trashedEntry], sheetStatus: trashedFlag })
  const refusedStatus = (await internal({ type: 'SET_STATUS', payload: { entryId: 't1', status: 'Interview' } })) as any
  const refusedResume = (await internal({ type: 'SAVE_RESUME_VERSION', payload: { entryId: 't1', resumeVersion: 'SWE v9', skipIdentityCheck: true } })) as any
  await listeners.onButtonClicked[0]('t1', 0)
  await check('trashed: SET_STATUS and SAVE_RESUME_VERSION are refused (SHEET_UNAVAILABLE) and the notification Undo writes nothing, all before any request', !refusedStatus.ok && refusedStatus.code === 'SHEET_UNAVAILABLE' && !refusedResume.ok && refusedResume.code === 'SHEET_UNAVAILABLE' && log.fetches.length === 0 && sheet.writes.length === 0 && sheetNotes().length === 1 && log.cleared.includes('t1'), { refusedStatus, refusedResume, fetches: log.fetches, notes: sheetNotes().length })

  reset()
  await local.set({ sheetRef: REF })
  ctl.goneIds.add(REF.spreadsheetId)
  apply('Deleted Sheet Co')
  await settle()
  const afterDeletedApply = { flag: sheetFlag(), queue: queue(), notes: sheetNotes().map((n) => n.title) }
  await tick()
  await check('deleted: the append 404s and a second read of the spreadsheet 404s too -> "missing", queued, "Your sheet was deleted"; a tick keeps it and writes nothing', afterDeletedApply.flag?.state === 'missing' && afterDeletedApply.queue === 1 && afterDeletedApply.notes.length === 2 && afterDeletedApply.notes.every((title) => title === 'Your sheet was deleted') && sheetFlag()?.state === 'missing' && queue() === 1 && rowsFor('Deleted Sheet Co') === 0, { afterDeletedApply, afterTick: sheetFlag() })

  reset()
  await local.set({ sheetRef: REF })
  ctl.fetchPlan = [404]
  apply('Unconfirmed 404 Co')
  await settle()
  await check('a 404 that a second read of the spreadsheet doesn\'t confirm -> an ordinary failure: queued, no flag', !sheetFlag() && queue() === 1 && sheetNotes().length === 0, { flag: sheetFlag(), queue: queue() })

  reset()
  ctl.fetchPlan = [401, 401]
  const drive401 = await outcome(sheetProvider.isTrashed(REF))
  const after401 = { signIn: !!flag(), sheet: sheetFlag() }
  reset()
  ctl.fetchPlan = [500]
  const drive500 = await outcome(sheetProvider.isTrashed(REF))
  const after500 = sheetFlag()
  reset()
  ctl.fetchPlan = ['abort']
  const driveTimeout = await outcome(sheetProvider.isTrashed(REF))
  await check('Drive check: a 401 surviving the retry means sign-in needed, not trashed; a 500 or a timeout is an ordinary failure with no flag', drive401 === 'AuthRequiredError' && after401.signIn && !after401.sheet && drive500.startsWith('other') && !after500 && driveTimeout.startsWith('other') && !sheetFlag(), { drive401, after401, drive500, driveTimeout })

  const oldEntry = { id: 'old1', company: 'Old Sheet Row', title: 'T', location: null, url: '', date: d(9), resumeVersion: '', status: 'Applied', sheetName: 'Sheet1', rowNumber: 7 }
  reset()
  await local.set({ sheetRef: REF, recentApplications: [oldEntry], offlineQueue: [qrow('Waiting For New Sheet', 12)] })
  ctl.trashedIds.add(REF.spreadsheetId)
  const createdForTrashed = (await internal({ type: 'CREATE_NEW_SHEET' })) as any
  await check('CREATE_NEW_SHEET with the sheet in the trash -> a new spreadsheet, connected, the flag cleared, the recent list emptied, the queue saved into the new sheet', createdForTrashed.ok && spreadsheetCreates() === 1 && (local.data.sheetRef as any)?.spreadsheetId === 'new1' && !sheetFlag() && queue() === 0 && createdForTrashed.data.saved === 1 && recent().length === 1 && recent()[0].company === 'Waiting For New Sheet', { createdForTrashed, creates: spreadsheetCreates(), flag: sheetFlag(), recent: recent().map((e) => e.company) })

  reset()
  await local.set({ sheetRef: REF })
  const refusedCreate = (await internal({ type: 'CREATE_NEW_SHEET' })) as any
  await check('CREATE_NEW_SHEET with a healthy sheet (reachable, not trashed) -> refused (SHEET_HEALTHY), nothing created, the sheet kept', !refusedCreate.ok && refusedCreate.code === 'SHEET_HEALTHY' && spreadsheetCreates() === 0 && (local.data.sheetRef as any)?.spreadsheetId === REF.spreadsheetId, refusedCreate)

  reset()
  await local.set({ sheetRef: REF, sheetStatus: { state: 'missing', since: d(1), reason: 'placeholder' } })
  ctl.goneIds.add(REF.spreadsheetId)
  const createdForDeleted = (await internal({ type: 'CREATE_NEW_SHEET' })) as any
  await check('CREATE_NEW_SHEET with the sheet deleted -> a new spreadsheet, connected, the flag cleared', createdForDeleted.ok && spreadsheetCreates() === 1 && (local.data.sheetRef as any)?.spreadsheetId === 'new1' && !sheetFlag(), { createdForDeleted, flag: sheetFlag() })

  reset()
  await local.set({ sheetRef: REF })
  ctl.goneIds.add(REF.spreadsheetId)
  const connectDeleted = (await internal({ type: 'CONNECT_PROVIDER' })) as any
  const deletedResult = { ok: connectDeleted.ok, creates: spreadsheetCreates(), stored: (local.data.sheetRef as any)?.spreadsheetId, flag: sheetFlag() }
  reset()
  await local.set({ sheetRef: REF })
  ctl.trashedIds.add(REF.spreadsheetId)
  const connectTrashed = (await internal({ type: 'CONNECT_PROVIDER' })) as any
  await check('CONNECT_PROVIDER with the stored sheet deleted -> replaced by a new one; with it in the trash -> kept, and the flag says trashed', deletedResult.ok && deletedResult.creates === 1 && deletedResult.stored === 'new1' && !deletedResult.flag && connectTrashed.ok && spreadsheetCreates() === 0 && connectTrashed.data.sheetRef.spreadsheetId === REF.spreadsheetId && sheetFlag()?.state === 'trashed', { deletedResult, connectTrashed, flag: sheetFlag() })

  // ---- "Start a new sheet" for a healthy sheet, and the way back
  //      (2026-09-17). Every sheet after the first carries its creation
  //      date, so two files in Drive are never both "Job Applications". ----
  const storedRef = () => local.data.sheetRef as any
  const previousRef = () => local.data.previousSheetRef as any
  const dated = datedSheetTitle()

  reset()
  const firstConnect = (await internal({ type: 'CONNECT_PROVIDER' })) as any
  await check('the first sheet keeps the plain name, and the ref carries it', firstConnect.ok && ctl.titles.new1 === DEFAULT_SHEET_TITLE && firstConnect.data.sheetRef.title === DEFAULT_SHEET_TITLE && storedRef()?.title === DEFAULT_SHEET_TITLE && !previousRef(), { created: ctl.titles.new1, ref: storedRef() })

  reset()
  await local.set({ sheetRef: { ...REF, title: DEFAULT_SHEET_TITLE }, recentApplications: [oldEntry], offlineQueue: [qrow('Waiting For Newer Sheet', 12)] })
  const started = (await internal({ type: 'CREATE_NEW_SHEET', payload: { replaceHealthy: true } })) as any
  const touchedOld = log.fetches.filter((f) => f.includes(REF.spreadsheetId))
  await check('CREATE_NEW_SHEET with replaceHealthy on a healthy sheet -> a dated new sheet, connected, the old one remembered and never touched, the recent list cleared, the queue saved into the new sheet', started.ok && spreadsheetCreates() === 1 && ctl.titles.new1 === dated && storedRef()?.spreadsheetId === 'new1' && storedRef()?.title === dated && previousRef()?.spreadsheetId === REF.spreadsheetId && previousRef()?.title === DEFAULT_SHEET_TITLE && touchedOld.length === 0 && queue() === 0 && started.data.saved === 1 && recent().length === 1 && recent()[0].company === 'Waiting For Newer Sheet', { started, titles: ctl.titles, previous: previousRef(), touchedOld, recent: recent().map((e) => e.company) })

  reset()
  await local.set({ sheetRef: { ...REF, title: DEFAULT_SHEET_TITLE } })
  const noPayload = (await internal({ type: 'CREATE_NEW_SHEET' })) as any
  const emptyPayload = (await internal({ type: 'CREATE_NEW_SHEET', payload: {} })) as any
  const notTrue = (await internal({ type: 'CREATE_NEW_SHEET', payload: { replaceHealthy: 'yes' } })) as any
  await check('CREATE_NEW_SHEET on a healthy sheet without replaceHealthy: true (absent, empty, or a non-boolean) -> still refused (SHEET_HEALTHY), nothing created', [noPayload, emptyPayload, notTrue].every((r) => !r.ok && r.code === 'SHEET_HEALTHY') && spreadsheetCreates() === 0 && storedRef()?.spreadsheetId === REF.spreadsheetId && !previousRef(), { noPayload, emptyPayload, notTrue, creates: spreadsheetCreates() })

  reset()
  await local.set({ sheetRef: { ...REF, title: DEFAULT_SHEET_TITLE } })
  const [startA, startB] = (await Promise.all([
    internal({ type: 'CREATE_NEW_SHEET', payload: { replaceHealthy: true } }),
    internal({ type: 'CREATE_NEW_SHEET', payload: { replaceHealthy: true } }),
  ])) as any[]
  await check('two "Start a new sheet" at once (a stale Settings page) -> exactly one spreadsheet created, both answered with it, one sheet remembered', startA.ok && startB.ok && spreadsheetCreates() === 1 && startA.data.sheetRef.spreadsheetId === 'new1' && startB.data.sheetRef.spreadsheetId === 'new1' && storedRef()?.spreadsheetId === 'new1' && previousRef()?.spreadsheetId === REF.spreadsheetId, { startA, startB, creates: spreadsheetCreates() })

  reset()
  await local.set({ sheetRef: { ...REF, title: DEFAULT_SHEET_TITLE } })
  ctl.trashedIds.add(REF.spreadsheetId)
  const recovered = (await internal({ type: 'CREATE_NEW_SHEET' })) as any
  await check('the trashed/deleted recovery path gets the dated name too, and remembers the sheet it replaced', recovered.ok && ctl.titles.new1 === dated && storedRef()?.title === dated && previousRef()?.spreadsheetId === REF.spreadsheetId, { recovered, titles: ctl.titles, previous: previousRef() })

  reset()
  await local.set({ sheetRef: { ...REF, title: DEFAULT_SHEET_TITLE }, recentApplications: [oldEntry] })
  await internal({ type: 'CREATE_NEW_SHEET', payload: { replaceHealthy: true } })
  await local.set({ recentApplications: [{ ...oldEntry, id: 'new-sheet-row', company: 'Logged In The New Sheet' }], offlineQueue: [qrow('Waiting For The Old Sheet', 13)] })
  const fetchesBeforeSwitch = log.fetches.length
  const switched = (await internal({ type: 'SWITCH_TO_PREVIOUS_SHEET' })) as any
  const switchFetches = log.fetches.slice(fetchesBeforeSwitch)
  await check('SWITCH_TO_PREVIOUS_SHEET with the old sheet healthy -> connected back to it, the sheet being left is remembered, the recent list cleared, the queue drained into the old sheet', switched.ok && switched.data.sheetRef.spreadsheetId === REF.spreadsheetId && storedRef()?.spreadsheetId === REF.spreadsheetId && storedRef()?.title === DEFAULT_SHEET_TITLE && previousRef()?.spreadsheetId === 'new1' && previousRef()?.title === dated && spreadsheetCreates() === 1 && switched.data.saved === 1 && queue() === 0 && recent().length === 1 && recent()[0].company === 'Waiting For The Old Sheet' && switchFetches.some((f) => f.startsWith(`/${REF.spreadsheetId}/values/`)), { switched, previous: previousRef(), recent: recent().map((e) => e.company), switchFetches })

  reset()
  await local.set({ sheetRef: { ...REF, title: DEFAULT_SHEET_TITLE } })
  await internal({ type: 'CREATE_NEW_SHEET', payload: { replaceHealthy: true } })
  await local.set({ recentApplications: [{ ...oldEntry, id: 'kept', company: 'Still In The New Sheet' }] })
  ctl.trashedIds.add(REF.spreadsheetId)
  const trashedBack = (await internal({ type: 'SWITCH_TO_PREVIOUS_SHEET' })) as any
  await check('SWITCH_TO_PREVIOUS_SHEET when the previous sheet is in the trash -> refused (PREVIOUS_UNAVAILABLE) saying so, nothing swapped, the recent list kept', !trashedBack.ok && trashedBack.code === 'PREVIOUS_UNAVAILABLE' && trashedBack.error.includes("Drive's trash") && storedRef()?.spreadsheetId === 'new1' && previousRef()?.spreadsheetId === REF.spreadsheetId && recent().length === 1 && recent()[0].company === 'Still In The New Sheet', { trashedBack, stored: storedRef()?.spreadsheetId, previous: previousRef()?.spreadsheetId })

  reset()
  await local.set({ sheetRef: { ...REF, title: DEFAULT_SHEET_TITLE } })
  await internal({ type: 'CREATE_NEW_SHEET', payload: { replaceHealthy: true } })
  ctl.goneIds.add(REF.spreadsheetId)
  const deletedBack = (await internal({ type: 'SWITCH_TO_PREVIOUS_SHEET' })) as any
  reset()
  await local.set({ sheetRef: { ...REF, title: DEFAULT_SHEET_TITLE } })
  const nothingBack = (await internal({ type: 'SWITCH_TO_PREVIOUS_SHEET' })) as any
  await check('SWITCH_TO_PREVIOUS_SHEET when the previous sheet was deleted -> refused, saying it was deleted; with nothing remembered -> refused, nothing swapped', !deletedBack.ok && deletedBack.code === 'PREVIOUS_UNAVAILABLE' && deletedBack.error.includes('deleted') && !nothingBack.ok && !nothingBack.code && storedRef()?.spreadsheetId === REF.spreadsheetId, { deletedBack, nothingBack, stored: storedRef()?.spreadsheetId })

  reset()
  await local.set({ sheetRef: { ...REF, title: DEFAULT_SHEET_TITLE } })
  await internal({ type: 'CREATE_NEW_SHEET', payload: { replaceHealthy: true } })
  await internal({ type: 'SWITCH_TO_PREVIOUS_SHEET' })
  const startedAgain = (await internal({ type: 'CREATE_NEW_SHEET', payload: { replaceHealthy: true } })) as any
  await check('new sheet -> switch back -> new sheet again: the second new sheet is dated too, and the way back points at the sheet just left', startedAgain.ok && spreadsheetCreates() === 2 && ctl.titles.new2 === dated && storedRef()?.spreadsheetId === 'new2' && previousRef()?.spreadsheetId === REF.spreadsheetId, { startedAgain, titles: ctl.titles, stored: storedRef(), previous: previousRef() })

  reset()
  await local.set({ sheetRef: REF })
  const filled = (await internal({ type: 'REFRESH_SHEET_TITLE' })) as any
  const titleReads = () => log.fetches.filter((f) => f.endsWith('?fields=properties.title')).length
  const afterFill = { reads: titleReads(), stored: storedRef()?.title }
  ctl.titles.sheet1 = 'Job Applications (renamed by hand)'
  const renamed = (await internal({ type: 'REFRESH_SHEET_TITLE' })) as any
  await check('REFRESH_SHEET_TITLE fills a ref stored before titles existed, in one read, and picks up a sheet renamed in Drive', filled.ok && filled.data.title === DEFAULT_SHEET_TITLE && afterFill.stored === DEFAULT_SHEET_TITLE && afterFill.reads === 1 && renamed.ok && renamed.data.title === 'Job Applications (renamed by hand)' && storedRef()?.title === 'Job Applications (renamed by hand)', { filled, afterFill, renamed, reads: titleReads(), stored: storedRef() })

  reset()
  await local.set({ sheetRef: { ...REF, title: DEFAULT_SHEET_TITLE } })
  ctl.goneIds.add(REF.spreadsheetId)
  const titleFailed = (await internal({ type: 'REFRESH_SHEET_TITLE' })) as any
  await check('REFRESH_SHEET_TITLE when the read fails -> an error, and the stored title is left alone (Settings keeps showing what it has)', !titleFailed.ok && storedRef()?.title === DEFAULT_SHEET_TITLE, { titleFailed, stored: storedRef() })

  const then = new Date(2026, 0, 5, 9, 30)
  await check('datedSheetTitle: the plain name plus the local creation date, zero-padded', datedSheetTitle(then) === 'Job Applications (from 2026-01-05)' && dated.startsWith(`${DEFAULT_SHEET_TITLE} (from `) && /^Job Applications \(from \d{4}-\d{2}-\d{2}\)$/.test(dated), { then: datedSheetTitle(then), dated })

  // ---- Audit fixes (2026-09-17). ----

  // 1. Checking the previous sheet must not flag the connected one.
  reset()
  await local.set({ sheetRef: { ...REF, title: DEFAULT_SHEET_TITLE } })
  await internal({ type: 'CREATE_NEW_SHEET', payload: { replaceHealthy: true } })
  ctl.trashedIds.add(REF.spreadsheetId)
  const refusedSwitch = (await internal({ type: 'SWITCH_TO_PREVIOUS_SHEET' })) as any
  const flagAfterRefusal = sheetFlag()
  apply('Logged After The Refusal')
  await settle()
  await check('SWITCH_TO_PREVIOUS_SHEET with the previous sheet trashed leaves the CONNECTED sheet unflagged, and the next application still lands', !refusedSwitch.ok && refusedSwitch.code === 'PREVIOUS_UNAVAILABLE' && !flagAfterRefusal && !sheetFlag() && rowsFor('Logged After The Refusal') === 1 && queue() === 0 && sheetNotes().length === 0, { refusedSwitch, flagAfterRefusal, flag: sheetFlag(), queue: queue(), notes: sheetNotes().length })

  // 3. A failing Drive call is "unknown", not a broken feature.
  reset()
  await local.set({ sheetRef: REF })
  ctl.fetchPlan = [200, 500]
  const createDriveDown = (await internal({ type: 'CREATE_NEW_SHEET' })) as any
  reset()
  await local.set({ sheetRef: REF, offlineQueue: [qrow('Queued Before Connect', 12)] })
  ctl.fetchPlan = [200, 500]
  const connectDriveDown = (await internal({ type: 'CONNECT_PROVIDER' })) as any
  await check('with Drive failing, the trash check reads as healthy: "Create a new sheet" is refused rather than erroring, and Connect keeps the sheet and still drains', !createDriveDown.ok && createDriveDown.code === 'SHEET_HEALTHY' && connectDriveDown.ok && spreadsheetCreates() === 0 && connectDriveDown.data.sheetRef.spreadsheetId === REF.spreadsheetId && connectDriveDown.data.saved === 1 && queue() === 0, { createDriveDown, connectDriveDown, creates: spreadsheetCreates() })

  // 2. A swap in flight: writers queue or stop instead of writing into the
  //    spreadsheet being left behind.
  reset()
  await local.set({ sheetRef: REF })
  await duringSheetSwap(async () => {
    apply('Applied Mid Swap')
    await settle()
  })
  await check('an application logged while a swap is in flight is queued, not appended to the sheet being left', rowsFor('Applied Mid Swap') === 0 && appendCalls() === 0 && queue() === 1, { appends: appendCalls(), queue: queue() })

  reset()
  await local.set({ sheetRef: REF, offlineQueue: [qrow('Drain Row One', 12), qrow('Drain Row Two', 13)] })
  const realFetch = globalThis.fetch
  let appendsSeen = 0
  // The connected sheet changes after the drain's first append, as a swap
  // landing mid-drain would do.
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const response = await realFetch(url, init)
    if (String(url).includes(':append') && ++appendsSeen === 1) {
      await local.set({ sheetRef: { ...REF, spreadsheetId: 'swapped-in' } })
    }
    return response
  }) as typeof fetch
  const drainedAcrossSwap = await drainOfflineQueue()
  globalThis.fetch = realFetch
  await check('a swap landing mid-drain stops the pass: the row already written counts, the rest stays queued for the new sheet', drainedAcrossSwap === 1 && rowsFor('Drain Row One') === 1 && rowsFor('Drain Row Two') === 0 && queue() === 1, { drainedAcrossSwap, queue: queue(), rows: Object.values(sheet.rows).map((r) => r[1]) })

  // 4. Crash-safety: one storage write, the new sheet first, and no switch
  //    back to the sheet already connected.
  reset()
  await local.set({ sheetRef: { ...REF, title: DEFAULT_SHEET_TITLE } })
  const realSet = local.set
  const writes: string[][] = []
  local.set = async (items: Record<string, unknown>) => {
    writes.push(Object.keys(items))
    return realSet(items)
  }
  await internal({ type: 'CREATE_NEW_SHEET', payload: { replaceHealthy: true } })
  local.set = realSet
  const refWrite = writes.find((keys) => keys.includes('sheetRef') || keys.includes('previousSheetRef'))
  await check('a swap writes both refs in one storage call, the new sheet first, so a worker killed mid-swap can never come back with previous === connected', writes.filter((keys) => keys.includes('sheetRef') || keys.includes('previousSheetRef')).length === 1 && refWrite?.[0] === 'sheetRef' && refWrite?.includes('previousSheetRef') === true, { writes })

  reset()
  await local.set({ sheetRef: REF, previousSheetRef: REF })
  const switchToItself = (await internal({ type: 'SWITCH_TO_PREVIOUS_SHEET' })) as any
  await check('SWITCH_TO_PREVIOUS_SHEET when the remembered sheet is the connected one (an interrupted swap) -> refused, the recent list untouched', !switchToItself.ok && switchToItself.code === 'PREVIOUS_UNAVAILABLE' && switchToItself.error.includes('already connected') && log.fetches.length === 0, { switchToItself, fetches: log.fetches })

  // 6. An in-flight create is shared only with a request that asked for the
  //    same thing.
  reset()
  await local.set({ sheetRef: { ...REF, title: DEFAULT_SHEET_TITLE } })
  const [swapRun, plainRun] = (await Promise.all([
    internal({ type: 'CREATE_NEW_SHEET', payload: { replaceHealthy: true } }),
    internal({ type: 'CREATE_NEW_SHEET' }),
  ])) as any[]
  await check('a deliberate swap and a plain CREATE_NEW_SHEET at once: one sheet created, and the plain one is refused rather than answered with the swap', swapRun.ok && swapRun.data.sheetRef.spreadsheetId === 'new1' && !plainRun.ok && plainRun.code === 'SHEET_HEALTHY' && spreadsheetCreates() === 1, { swapRun, plainRun, creates: spreadsheetCreates() })

  // 7. The notification Edit window's skipped identity check expires.
  const freshEntry = { id: 'fresh1', company: 'Acme', title: 'SWE Intern', location: null, url: '', date: new Date().toISOString(), resumeVersion: 'SWE v1', status: 'Applied', sheetName: 'Sheet1', rowNumber: 5 }
  const staleEntry = { ...freshEntry, id: 'stale1', date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }
  reset()
  await local.set({ sheetRef: REF, recentApplications: [freshEntry] })
  sheet.rows[5] = ['', 'Renamed By Hand', 'SWE Intern', '', '', 'SWE v1', 'Applied', '', '']
  const skipFresh = (await internal({ type: 'SAVE_RESUME_VERSION', payload: { entryId: 'fresh1', resumeVersion: 'SWE v2', skipIdentityCheck: true } })) as any
  const freshWrites = sheet.writes.length
  reset()
  await local.set({ sheetRef: REF, recentApplications: [staleEntry] })
  sheet.rows[5] = ['', 'Renamed By Hand', 'SWE Intern', '', '', 'SWE v1', 'Applied', '', '']
  const skipStale = (await internal({ type: 'SAVE_RESUME_VERSION', payload: { entryId: 'stale1', resumeVersion: 'SWE v2', skipIdentityCheck: true } })) as any
  await check('skipIdentityCheck is honoured for an application just logged (the notification\'s window) and not for one two hours old, which gets the Company/Title check and STALE_ROW', skipFresh.ok && freshWrites === 1 && !skipStale.ok && skipStale.code === 'STALE_ROW' && sheet.writes.length === 0, { skipFresh, freshWrites, skipStale, writes: sheet.writes.length })

  reset()
  await local.set({ sheetRef: REF })
  ctl.trashedIds.add(REF.spreadsheetId)
  await internal({ type: 'GET_LIVE_STATUSES' })
  await settle()
  await check('opening the popup (GET_LIVE_STATUSES) asks Drive too -> "trashed" set', driveChecks() === 1 && sheetFlag()?.state === 'trashed', { drive: driveChecks(), flag: sheetFlag() })

  reset()
  await local.set({ sheetRef: REF })
  await tick()
  const idleTickChecks = driveChecks()
  await local.set({ offlineQueue: [qrow('Queued For Tick', 12)] })
  await tick()
  await check('retry tick: with nothing queued and no flag, no Drive call; with an application queued, one Drive call before the drain', idleTickChecks === 0 && driveChecks() === 1 && queue() === 0 && rowsFor('Queued For Tick') === 1, { idleTickChecks, drive: driveChecks(), queue: queue() })

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
  await check('SET_STATUS: row still matches -> exactly one write, "Interview" to Sheet1!G5; cached entry updated', st.ok && st.data.status === 'Interview' && sheet.writes.length === 1 && sheet.writes[0].range === "'Sheet1'!G5" && JSON.stringify(sheet.writes[0].values) === '[["Interview"]]' && recent()[0].status === 'Interview', { resp: st, writes: sheet.writes })

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
  await check('notification Undo, through the shared status setter -> "Cancelled" written to Sheet1!G5, cache Cancelled', recent()[0].status === 'Cancelled' && sheet.writes.length === 1 && sheet.writes[0].range === "'Sheet1'!G5" && JSON.stringify(sheet.writes[0].values) === '[["Cancelled"]]', sheet.writes)

  const urls = { https: safeJobUrl('https://www.linkedin.com/jobs/view/1/'), http: safeJobUrl('http://example.com/x'), javascript: safeJobUrl('javascript:alert(1)'), data: safeJobUrl('data:text/html,hi'), empty: safeJobUrl(''), junk: safeJobUrl('not a url') }
  await check('safeJobUrl: https and http kept; javascript:, data:, empty and junk refused', urls.https === 'https://www.linkedin.com/jobs/view/1/' && urls.http === 'http://example.com/x' && urls.javascript === null && urls.data === null && urls.empty === null && urls.junk === null, urls)

  // ---- Log ID: the drain's duplicate check (2026-09-14). ----
  const LOG_ID = HEADERS_WITH_LOG_ID.indexOf('Log ID')
  const rowsOf = (company: string) => Object.entries(sheet.rows).filter(([, values]) => values[1] === company)
  const appendsSince = (n: number) => log.fetches.slice(n).filter((f) => f.includes(':append')).length
  const drain = async () => {
    listeners.onAlarm[0]({ name: 'retryOfflineQueue' })
    await settle()
  }
  const withLogIdSheet = async () => {
    reset()
    ctl.headers = HEADERS_WITH_LOG_ID
    await local.set({ sheetRef: REF })
  }

  const posting = { title: 'Engineer', company: 'Id Co', location: null, url: 'https://jobs.example.com/id' }
  const first = sanitizeRow(buildRow(posting, 'SWE v1'))
  const second = sanitizeRow(buildRow(posting, 'SWE v1'))
  await check('buildRow gives every row a random Log ID, and sanitizeRow keeps it', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(first['Log ID']) && first['Log ID'] !== second['Log ID'], { first: first['Log ID'], second: second['Log ID'] })

  await withLogIdSheet()
  ctl.appendThenAbort = true
  apply('Timeout Co')
  await settle()
  const queuedId = (local.data.offlineQueue as any[] | undefined)?.[0]?.['Log ID']
  const afterApply = { queue: queue(), copies: rowsOf('Timeout Co').length }
  const fetchesBeforeDrain = log.fetches.length
  await drain()
  const copies = rowsOf('Timeout Co')
  await check('an append that succeeded but timed out: queued, then the drain finds its Log ID -> 1 copy, no second append, queue empty, recent entry at that row', afterApply.queue === 1 && afterApply.copies === 1 && queue() === 0 && copies.length === 1 && copies[0][1][LOG_ID] === queuedId && appendsSince(fetchesBeforeDrain) === 0 && recent()[0]?.company === 'Timeout Co' && recent()[0]?.rowNumber === Number(copies[0][0]), { afterApply, copies: copies.length, appendsInDrain: appendsSince(fetchesBeforeDrain), recent: recent()[0] })

  await withLogIdSheet()
  ctl.fetchPlan = [200, 500]
  apply('Fail Co')
  await settle()
  const failedFirst = { queue: queue(), copies: rowsOf('Fail Co').length }
  await drain()
  await check('an append that really failed (500) is still retried by the drain -> 1 copy, queue empty', failedFirst.queue === 1 && failedFirst.copies === 0 && queue() === 0 && rowsOf('Fail Co').length === 1, { failedFirst, copies: rowsOf('Fail Co').length })

  await withLogIdSheet()
  const sameDate = '2026-09-14T15:00:00.000Z'
  const twinRow = (logId: string) => ({ Date: sameDate, Company: 'Twin Co', Title: 'Engineer', Location: 'Remote', URL: 'https://jobs.example.com/twin', 'Resume Version': 'SWE v1', Status: '', Notes: '', 'Log ID': logId })
  sheet.rows[2] = ['46279.625', 'Twin Co', 'Engineer', 'Remote', 'https://jobs.example.com/twin', 'SWE v1', '', '', 'id-A']
  await local.set({ offlineQueue: [twinRow('id-B')] })
  await drain()
  const twins = rowsOf('Twin Co')
  await check('two applications with the same Date and Company but different Log IDs stay separate -> 2 rows', queue() === 0 && twins.length === 2 && twins.map(([, values]) => values[LOG_ID]).sort().join() === 'id-A,id-B', { twins: twins.map(([row, values]) => [row, values[LOG_ID]]) })

  reset()
  await local.set({ sheetRef: REF, offlineQueue: [{ ...twinRow('id-C'), Company: 'Old Sheet Co' }] })
  await drain()
  const columnReads = log.fetches.filter((f) => f.includes('majorDimension=COLUMNS')).length
  const oldCopies = rowsOf('Old Sheet Co')
  await check('a sheet without the Log ID column: no column read, the row is appended as before (8 columns, no id)', queue() === 0 && oldCopies.length === 1 && columnReads === 0 && oldCopies[0][1].length === 8, { columnReads, copies: oldCopies.length, width: oldCopies[0]?.[1].length })

  reset()
  const connected = (await internal({ type: 'CONNECT_PROVIDER' })) as any
  const headerWrite = (sheet.writes.find((w) => w.range === "'Sheet1'!A1")?.values as string[][] | undefined)?.[0]
  const requests = (log.batchUpdates[0] ?? []) as any[]
  const hide = requests.find((r) => r.updateDimensionProperties?.range?.dimension === 'COLUMNS' && r.updateDimensionProperties.properties?.hiddenByUser)?.updateDimensionProperties
  const banding = requests.find((r) => r.addBanding)?.addBanding.bandedRange.range
  await check('createSheet: Log ID is the 9th header, hidden and 60px wide, and outside the banding', connected.ok && headerWrite?.length === 9 && headerWrite[8] === 'Log ID' && hide?.range.startIndex === 8 && hide.range.endIndex === 9 && hide.properties.pixelSize === 60 && banding?.endColumnIndex === 8, { headerWrite, hide, banding })

  // ---- The "Logged" notification's clear (2026-09-14): a 5s timer, and a
  // 0.5-minute alarm as the fallback. ----
  reset()
  await local.set({ sheetRef: REF })
  apply('Clear Co')
  await settle()
  const logged = log.notifications.find((n) => n.title === 'Logged')
  const clearName = `clearNotification:${logged?.id}`
  const clearAlarm = log.alarms.find((a) => a.name === clearName)
  const clearTimer = log.timers.find((timer) => timer.ms === 5000)
  const clearedEarly = log.cleared.includes(logged?.id ?? '')
  clearTimer?.fn()
  await settle()
  const byTimer = { cleared: log.cleared.includes(logged?.id ?? ''), alarmCancelled: !alarms.has(clearName) }
  log.cleared.length = 0
  listeners.onAlarm[0]({ name: clearName })
  await check('"Logged" notification: cleared by a 5s timer, which also cancels its 0.5-minute fallback alarm; the alarm alone clears it too', !!logged && clearAlarm?.info.delayInMinutes === 0.5 && !!clearTimer && !clearedEarly && byTimer.cleared && byTimer.alarmCancelled && log.cleared.includes(logged!.id), { logged, clearAlarm, timers: log.timers.map((x) => x.ms), clearedEarly, byTimer, byAlarm: log.cleared })

  // ---- Content-script payloads are checked (2026-09-14). ----
  reset()
  await local.set({ sheetRef: REF })
  const send = (type: string, payload: unknown, origin = 'https://www.linkedin.com', extra: Record<string, unknown> = {}) =>
    listeners.onMessage[0]({ type, payload, ...extra }, { origin }, () => {})
  const ok = { title: 'Engineer', company: 'Valid Co', location: null, url: 'https://www.linkedin.com/jobs/view/9/' }
  const badPayloads = [
    null,
    'a string',
    { ...ok, title: 42 },
    { ...ok, company: '   ' },
    { ...ok, location: 5 },
    { title: ok.title, company: ok.company, url: ok.url },
    { ...ok, url: 'http://www.linkedin.com/jobs/view/9/' },
    { ...ok, url: 'javascript:alert(1)' },
    { ...ok, title: 'T'.repeat(501) },
    { ...ok, location: 'L'.repeat(501) },
    { ...ok, url: `https://x.example/${'u'.repeat(2048)}` },
  ]
  for (const payload of badPayloads) send('JOB_APPLICATION_LOGGED', payload)
  send('JOB_APPLICATION_PENDING', { ...ok, company: 7 }, 'https://job-boards.greenhouse.io', { key: 'acme/1' })
  await settle()
  const rejected = { fetches: log.fetches.length, queue: queue(), pending: session.data.pendingApplications, notes: log.notifications.length }
  send('JOB_APPLICATION_LOGGED', { ...ok, extra: 'dropped' })
  await settle()
  await check('content-script payloads: 11 malformed LOGGED and 1 malformed PENDING rejected before any request, queue or pending write; a valid one still logs', rejected.fetches === 0 && rejected.queue === 0 && rejected.pending === undefined && rejected.notes === 0 && rowsOf('Valid Co').length === 1 && recent()[0]?.company === 'Valid Co', { rejected, rows: rowsOf('Valid Co').length })

  await withAcme()
  const saveResume = (resumeVersion: unknown) =>
    internal({ type: 'SAVE_RESUME_VERSION', payload: { entryId: 's1', resumeVersion, skipIdentityCheck: true } }) as Promise<any>
  const notString = await saveResume(42)
  const tooLong = await saveResume('v'.repeat(501))
  const fetchesAfterRejects = log.fetches.length
  const saved = await saveResume('SWE v5')
  await check('SAVE_RESUME_VERSION: a non-string or over-500-character resumeVersion is refused before any request; a string is saved', !notString.ok && !tooLong.ok && fetchesAfterRejects === 0 && saved.ok && sheet.writes.length === 1 && JSON.stringify(sheet.writes[0].values) === '[["SWE v5"]]', { notString: notString.error, tooLong: tooLong.error, fetchesAfterRejects, saved: saved.ok, writes: sheet.writes })

  // ---- Sheet tab renamed (2026-09-14): quoted ranges, re-resolved by sheetId. ----
  const tabLookups = () => log.fetches.filter((f) => f.endsWith('?fields=sheets.properties')).length
  const rangeFetches = () => log.fetches.filter((f) => f.includes('/values/') || f.includes('ranges='))
  reset()
  await local.set({ sheetRef: REF })
  ctl.sheetTitle = "Bob's Jobs"
  apply('Renamed Co')
  await settle()
  const afterRename = {
    stored: (local.data.sheetRef as any)?.sheetName,
    lookups: tabLookups(),
    appendUrl: log.fetches.find((f) => f.includes(':append')),
    rows: rowsOf('Renamed Co').length,
    entrySheet: recent()[0]?.sheetName,
    logged: log.notifications.some((n) => n.title === 'Logged'),
    queue: queue(),
  }
  apply('Second Co')
  await settle()
  const lookupsAfterSecond = tabLookups()
  const unquoted = rangeFetches().filter((f) => !/(\/values\/|ranges=)'/.test(f))
  await check("renamed tab (\"Bob's Jobs\"): the 400 is answered by one tab lookup by sheetId, the stored sheetRef takes the new name, and the row lands; the next apply needs no lookup; every range is quoted", afterRename.stored === "Bob's Jobs" && afterRename.lookups === 1 && afterRename.appendUrl?.includes("/values/'Bob''s Jobs'!A1:append") === true && afterRename.rows === 1 && afterRename.entrySheet === "Bob's Jobs" && afterRename.logged && afterRename.queue === 0 && lookupsAfterSecond === 1 && rowsOf('Second Co').length === 1 && unquoted.length === 0, { afterRename, lookupsAfterSecond, unquoted })

  reset()
  await local.set({ sheetRef: REF })
  ctl.sheetTitle = 'Renamed'
  ctl.tabDeleted = true
  apply('Deleted Tab Co')
  await settle()
  await check('tab deleted (no tab with the stored sheetId): one lookup, no retry loop, the row is queued, the stored sheetRef unchanged', tabLookups() === 1 && queue() === 1 && (local.data.sheetRef as any)?.sheetName === 'Sheet1' && rowsOf('Deleted Tab Co').length === 0, { lookups: tabLookups(), queue: queue(), stored: local.data.sheetRef })

  // ---- Easy Apply reopened (2026-09-14): the same job URL within 24 hours
  // isn't logged twice, unless its entry is Cancelled. ----
  const REPEAT_URL = 'https://www.linkedin.com/jobs/view/777/'
  const sendJob = async (company: string, url: string) => {
    listeners.onMessage[0]({ type: 'JOB_APPLICATION_LOGGED', payload: { title: 'Engineer', company, location: null, url } }, { origin: 'https://www.linkedin.com' }, () => {})
    await settle()
  }
  const appends = () => log.fetches.filter((f) => f.includes(':append')).length
  reset()
  await local.set({ sheetRef: REF })
  await sendJob('Repeat Co', REPEAT_URL)
  await sendJob('Repeat Co', REPEAT_URL)
  const reopened = { appends: appends(), rows: rowsOf('Repeat Co').length, logged: log.notifications.filter((n) => n.title === 'Logged').length, queue: queue() }
  await sendJob('Other Co', 'https://www.linkedin.com/jobs/view/778/')
  const afterOtherJob = appends()
  await local.set({ recentApplications: recent().map((e) => (e.url === REPEAT_URL ? { ...e, status: 'Cancelled' } : e)) })
  await sendJob('Repeat Co', REPEAT_URL)
  const afterCancel = appends()
  reset()
  const dayOld = { id: 'old', company: 'Repeat Co', title: 'Engineer', location: null, url: REPEAT_URL, date: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), resumeVersion: '', status: 'Applied', sheetName: 'Sheet1', rowNumber: 2 }
  await local.set({ sheetRef: REF, recentApplications: [dayOld] })
  await sendJob('Repeat Co', REPEAT_URL)
  const afterDayOld = appends()
  await check('Easy Apply reopened: the same job twice -> 1 row, 1 "Logged", nothing queued; a different job logs; after the entry is Cancelled it logs again; an entry 25 hours old doesn\'t block', reopened.appends === 1 && reopened.rows === 1 && reopened.logged === 1 && reopened.queue === 0 && afterOtherJob === 2 && afterCancel === 3 && afterDayOld === 1, { reopened, afterOtherJob, afterCancel, afterDayOld })

  // ---- The note editor (2026-09-15): GET_NOTE prefills from the row;
  // SAVE_NOTE writes only if the Notes cell still holds what it opened with. ----
  const getNote = (entryId: unknown = 's1') => internal({ type: 'GET_NOTE', payload: { entryId } }) as Promise<any>
  const saveNote = (note: unknown, expected: unknown, entryId: unknown = 's1') =>
    internal({ type: 'SAVE_NOTE', payload: { entryId, note, expected } }) as Promise<any>
  const withAcmeNote = async (note: string) => {
    await withAcme()
    sheet.rows[5] = [...acmeRow.slice(0, 7), note]
  }

  await withAcmeNote('Called the recruiter')
  const gotNote = await getNote()
  await check('GET_NOTE: the row still matches -> its Notes cell; nothing written', gotNote.ok && gotNote.data.note === 'Called the recruiter' && sheet.writes.length === 0, gotNote)

  await withAcmeNote('Called the recruiter')
  const formulaNote = '=HYPERLINK("https://example.com") follow up Friday'
  let savedNote = await saveNote(formulaNote, 'Called the recruiter')
  await check('SAVE_NOTE: the cell still holds what the editor opened with -> one RAW write of the whole note to Sheet1!H5, replacing it', savedNote.ok && sheet.writes.length === 1 && sheet.writes[0].range === "'Sheet1'!H5" && JSON.stringify(sheet.writes[0].values) === JSON.stringify([[formulaNote]]) && log.fetches.some((f) => f.includes('H5') && f.includes('valueInputOption=RAW')), { savedNote, writes: sheet.writes, fetches: log.fetches })

  await withAcmeNote('Edited in the sheet')
  savedNote = await saveNote('My note', 'Called the recruiter')
  await check('SAVE_NOTE: the Notes cell changed in the sheet since the editor opened -> NOTE_CHANGED, nothing written', !savedNote.ok && savedNote.code === 'NOTE_CHANGED' && sheet.writes.length === 0, savedNote)

  await withAcme()
  const emptyNote = await getNote()
  savedNote = await saveNote('First note', '')
  await check('GET_NOTE on an empty Notes cell -> ""; SAVE_NOTE expecting "" writes the first note', emptyNote.ok && emptyNote.data.note === '' && savedNote.ok && sheet.writes.length === 1 && JSON.stringify(sheet.writes[0].values) === '[["First note"]]', { emptyNote, savedNote, writes: sheet.writes })

  await withAcme()
  sheet.rows[5][1] = 'Acme Renamed'
  const staleGet = await getNote()
  const staleSave = await saveNote('x', '')
  await check('GET_NOTE and SAVE_NOTE: Company edited by hand -> STALE_ROW, nothing written', !staleGet.ok && staleGet.code === 'STALE_ROW' && !staleSave.ok && staleSave.code === 'STALE_ROW' && sheet.writes.length === 0, { staleGet, staleSave })

  await withAcme()
  const tooLongNote = await saveNote('x'.repeat(1001), '')
  const numericNote = await saveNote(5, '')
  const noExpected = await saveNote('x', undefined)
  const noteFetchesAfterRejects = log.fetches.length
  const maxNote = await saveNote('y'.repeat(1000), '')
  await check('SAVE_NOTE: a non-string or over-1000-character note, or no expected value, is refused before any request; exactly 1000 characters is saved', !tooLongNote.ok && !numericNote.ok && !noExpected.ok && noteFetchesAfterRejects === 0 && maxNote.ok && sheet.writes.length === 1, { tooLongNote: tooLongNote.error, numericNote: numericNote.error, noExpected: noExpected.error, noteFetchesAfterRejects, maxNote: maxNote.ok })

  reset()
  await local.set({ sheetRef: REF, recentApplications: [acme], sheetStatus: { state: 'trashed', since: d(1), reason: 'placeholder' } })
  sheet.rows[5] = [...acmeRow]
  const trashedGet = await getNote()
  const trashedSave = await saveNote('x', '')
  await check('sheet in the trash: GET_NOTE and SAVE_NOTE -> SHEET_UNAVAILABLE before any request', !trashedGet.ok && trashedGet.code === 'SHEET_UNAVAILABLE' && !trashedSave.ok && trashedSave.code === 'SHEET_UNAVAILABLE' && log.fetches.length === 0 && sheet.writes.length === 0, { trashedGet, trashedSave, fetches: log.fetches })

  await withAcme()
  ctl.tokenReject = true
  const signedOutNote = await saveNote('x', '')
  await check('SAVE_NOTE signed out -> AUTH_REQUIRED, sign-in flag set, nothing written', !signedOutNote.ok && signedOutNote.code === 'AUTH_REQUIRED' && !!flag() && sheet.writes.length === 0, signedOutNote)

  // ---- Recent entries carry the row's Log ID (2026-09-15), so the popup can
  // leave out a waiting application once its saved entry exists. ----
  reset()
  ctl.headers = HEADERS_WITH_LOG_ID
  await local.set({ sheetRef: REF })
  apply('Log Id Direct Co')
  await settle()
  const queuedRow = sanitizeRow(buildRow({ title: 'Engineer', company: 'Log Id Drained Co', location: null, url: 'https://www.linkedin.com/jobs/view/991/' }, 'SWE v1'))
  await local.set({ offlineQueue: [queuedRow] })
  await internal({ type: 'RECONNECT_PROVIDER' })
  const directEntry = recent().find((e) => e.company === 'Log Id Direct Co')
  const drainedEntry = recent().find((e) => e.company === 'Log Id Drained Co')
  const directRowId = rowsOf('Log Id Direct Co')[0]?.[1][8]
  await check('recent entries carry the row\'s Log ID: a direct log and a drained row', !!directEntry?.logId && directEntry.logId === directRowId && drainedEntry?.logId === queuedRow['Log ID'] && queue() === 0, { direct: directEntry?.logId, directRowId, drained: drainedEntry?.logId, queued: queuedRow['Log ID'] })

  // ---- Status starts at 'Applied' (2026-09-17), so a logged row carries one
  // of the five values the sheet's dropdown and colour rules know. ----
  reset()
  ctl.headers = HEADERS_WITH_LOG_ID
  await local.set({ sheetRef: REF })
  apply('Status Direct Co')
  await settle()
  const directStatusRow = rowsOf('Status Direct Co')[0]?.[1]
  const queuedStatusRow = sanitizeRow(buildRow({ title: 'Engineer', company: 'Status Queued Co', location: null, url: 'https://www.linkedin.com/jobs/view/992/' }, 'SWE v1'))
  await local.set({ offlineQueue: [queuedStatusRow] })
  await internal({ type: 'RECONNECT_PROVIDER' })
  const drainedStatusRow = rowsOf('Status Queued Co')[0]?.[1]
  const statusEntries = recent().map((e) => e.status)
  await check("Status starts at 'Applied': buildRow writes it, a direct log and a drained queued row both land with it, Notes stays blank, and the cached entries agree", buildRow({ title: 'T', company: 'C', location: null, url: 'https://example.com' }, 'SWE v1').Status === 'Applied' && directStatusRow?.[6] === 'Applied' && queuedStatusRow.Status === 'Applied' && drainedStatusRow?.[6] === 'Applied' && directStatusRow?.[7] === '' && statusEntries.every((s) => s === 'Applied'), { direct: directStatusRow?.[6], drained: drainedStatusRow?.[6], notes: directStatusRow?.[7], entries: statusEntries })

  // The popup's live chip now reads the same value back: matchLiveStatuses
  // skips a blank Status cell, so before this change a fresh row's live read
  // returned nothing and the popup fell back to its cached "Applied".
  const liveEntry = { id: 'ls1', company: 'Acme', title: 'SWE Intern', location: null, url: '', date: d(12), resumeVersion: '', status: 'Applied', sheetName: 'Sheet1', rowNumber: 2 }
  const liveRow = (status: string) => ({ Company: 'Acme', Title: 'SWE Intern', Status: status })
  const liveApplied = matchLiveStatuses([liveEntry], [liveRow('Applied')])
  const liveBlank = matchLiveStatuses([liveEntry], [liveRow('')])
  await check("the live chip reads a logged row back as Applied, where a blank Status cell was skipped", liveApplied.ls1 === 'Applied' && liveBlank.ls1 === undefined, { liveApplied, liveBlank })
})
