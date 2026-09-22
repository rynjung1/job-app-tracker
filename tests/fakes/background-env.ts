// Faked chrome, fetch and navigator for tests/background.test.ts. Imported
// first, so it runs before any real module registers listeners.
//
// Storage round-trips every value through JSON on get and set, like real
// chrome.storage: a fake that hands back live references once produced a
// false failure (CLAUDE.md, the 2026-09-09 mock-fidelity lesson).
/* eslint-disable @typescript-eslint/no-explicit-any */
type Listener = (...args: any[]) => any
export const listeners: Record<string, Listener[]> = {}
const on = (name: string) => ({ addListener: (f: Listener) => (listeners[name] ??= []).push(f) })

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
function area() {
  const data: Record<string, unknown> = {}
  return {
    data,
    get: async (keys: string | string[]) => {
      const out: Record<string, unknown> = {}
      for (const k of typeof keys === 'string' ? [keys] : keys) if (k in data) out[k] = clone(data[k])
      return out
    },
    set: async (items: Record<string, unknown>) => {
      if (ctl.failQueueWrite && 'offlineQueue' in items) throw new Error('simulated storage write failure')
      for (const k of Object.keys(items)) data[k] = clone(items[k])
    },
    remove: async (keys: string | string[]) => {
      for (const k of typeof keys === 'string' ? [keys] : keys) delete data[k]
    },
  }
}
export const local = area()
export const session = area()

export const log = {
  notifications: [] as Array<{ id: string; title: string; message: string }>,
  cleared: [] as string[],
  badge: [] as string[],
  tokenCalls: 0,
  fetches: [] as string[],
  windows: [] as string[],
  batchUpdates: [] as unknown[][],
  alarms: [] as Array<{ name: string; info: Record<string, number> }>,
  timers: [] as Array<{ ms: number; fn: () => void }>,
}
// The fake chrome.alarms' current alarms, by name.
export const alarms = new Map<string, Record<string, number>>()
// The fake sheet's header row. HEADERS_8 and HEADERS_WITH_LOG_ID are a
// sheet created before 2026-09-18, so they still carry Resume Version —
// which is most tests here on purpose, since that's what a user who
// connected earlier still has. HEADERS_CURRENT is what createSheet writes
// now (2026-09-18: no Resume Version, so Status is column F).
export const HEADERS_8 = ['Date', 'Company', 'Title', 'Location', 'URL', 'Resume Version', 'Status', 'Notes']
export const HEADERS_WITH_LOG_ID = [...HEADERS_8, 'Log ID']
export const HEADERS_CURRENT = ['Date', 'Company', 'Title', 'Location', 'URL', 'Status', 'Notes', 'Log ID']

export const ctl = {
  tokenReject: false,
  tokenError: 'OAuth2 not granted or revoked.',
  online: true,
  fetchPlan: [] as Array<number | 'abort'>,
  failQueueWrite: false,
  headers: HEADERS_8,
  // The next append succeeds at "Google" (the row is stored) but its
  // response times out, as in the idempotency bug.
  appendThenAbort: false,
  // The grid id a created spreadsheet's first sheet comes back with. 0 in
  // practice; a test sets it to the Summary tab's own id to check they can't
  // collide (2026-09-17).
  createdSheetId: 0,
  // The fake tab's current name (a rename changes it; its sheetId stays 0),
  // or the tab deleted (the spreadsheet then has only a different tab).
  sheetTitle: 'Sheet1',
  tabDeleted: false,
  // Spreadsheets in Drive's trash, and deleted ones (2026-09-14). Measured
  // with scripts/sheet-probe.js: a trashed spreadsheet answers every Sheets
  // call as usual and only Drive's files.get says trashed; a deleted one is
  // taken to answer 404 everywhere (expected, not measured).
  trashedIds: new Set<string>(),
  goneIds: new Set<string>(),
  // What a Workday job JSON read answers (2026-09-21), for the background's
  // read after a Submit message; null makes the fetch fail like a network
  // error.
  workdayJson: { status: 200, body: {} } as null | { status: number; body: unknown },
  // Each spreadsheet's name (2026-09-17), for readTitle. A create adds the
  // name it asked for under the next id (new1, new2...); 'sheet1' is the
  // pre-existing one every test starts connected to.
  titles: { sheet1: 'Job Applications' } as Record<string, string>,
}
// The fake sheet: row values for readRow, and every successful cell write.
export const sheet = { rows: {} as Record<number, string[]>, writes: [] as Array<{ range: string; values: unknown }> }

export function reset() {
  for (const k of Object.keys(sheet.rows)) delete sheet.rows[Number(k)]
  sheet.writes.length = 0
  for (const k of Object.keys(local.data)) delete local.data[k]
  for (const k of Object.keys(session.data)) delete session.data[k]
  log.notifications.length = 0
  log.cleared.length = 0
  log.badge.length = 0
  log.fetches.length = 0
  log.windows.length = 0
  log.batchUpdates.length = 0
  log.alarms.length = 0
  log.timers.length = 0
  alarms.clear()
  log.tokenCalls = 0
  ctl.tokenReject = false
  ctl.online = true
  ctl.fetchPlan = []
  ctl.failQueueWrite = false
  ctl.headers = HEADERS_8
  ctl.appendThenAbort = false
  ctl.createdSheetId = 0
  ctl.sheetTitle = 'Sheet1'
  ctl.tabDeleted = false
  ctl.trashedIds.clear()
  ctl.goneIds.clear()
  ctl.titles = { sheet1: 'Job Applications' }
  ctl.workdayJson = { status: 200, body: {} }
  created = 0
}

// fetchWithTimeout's 20s timer is left running when a request is aborted
// (the timeout case below), and the "Logged" notification's 5s clear timer
// outlives a test. Timers of 5s or more are unref'd so they can't keep the
// test process alive, and recorded in log.timers so a test can run one
// itself; short ones (the code's own awaits) are untouched.
const realSetTimeout = globalThis.setTimeout
;(globalThis as any).setTimeout = (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => {
  const timer = realSetTimeout(fn, ms, ...args) as any
  if ((ms ?? 0) >= 5_000) {
    timer.unref?.()
    log.timers.push({ ms: ms ?? 0, fn: () => fn(...args) })
  }
  return timer
}

Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ onLine: ctl.online }) })

;(globalThis as any).chrome = {
  runtime: {
    id: 'testid',
    getURL: (p: string) => `chrome-extension://testid/${p}`,
    getManifest: () => ({ version: '1.0.0' }),
    openOptionsPage: async () => {},
    onMessage: on('onMessage'),
    onInstalled: on('onInstalled'),
    onStartup: on('onStartup'),
  },
  storage: { local, session, onChanged: on('storageChanged') },
  identity: {
    getAuthToken: async ({ interactive }: { interactive: boolean }) => {
      log.tokenCalls++
      if (ctl.tokenReject && !interactive) throw new Error(ctl.tokenError)
      return { token: `tok${log.tokenCalls}` }
    },
    removeCachedAuthToken: async () => {},
  },
  notifications: {
    create: async (id: string, o: { title: string; message: string }) => {
      log.notifications.push({ id, title: o.title, message: o.message })
      return id
    },
    clear: async (id: string) => {
      log.cleared.push(id)
      return true
    },
    onButtonClicked: on('onButtonClicked'),
  },
  action: {
    setBadgeText: async ({ text }: { text: string }) => {
      log.badge.push(text)
    },
    setBadgeBackgroundColor: async () => {},
    setBadgeTextColor: async () => {},
    setTitle: async () => {},
  },
  alarms: {
    // No return value, like Chrome 110 (create returns a promise only from 111).
    create: (name: string, info: Record<string, number>) => {
      alarms.set(name, info)
      log.alarms.push({ name, info })
    },
    get: async (name: string) => (alarms.has(name) ? { name, ...alarms.get(name) } : undefined),
    clear: async (name: string) => alarms.delete(name),
    onAlarm: on('onAlarm'),
  },
  windows: {
    create: async (o: { url: string }) => {
      log.windows.push(o.url)
      return { id: 7 }
    },
    update: async () => ({}),
    onRemoved: on('onRemoved'),
  },
  tabs: { query: async () => [{ id: 1 }], update: async () => ({}), create: async () => ({}) },
}

// The fake Sheets API: ctl.headers for 1:1, the fake sheet's rows for N:N,
// one column from row 2 down for X2:X (majorDimension=COLUMNS, trailing
// blanks dropped like the real API), appends stored after the last row, a
// new spreadsheet for the create call; every successful PUT and batchUpdate
// is recorded. ctl.fetchPlan scripts statuses call by call.
let appendedRow = 1
// Spreadsheets this fake has created in the current test: new1, new2...
let created = 0
// Google quotes a tab name in a returned range only when it has to.
const googleQuoted = (name: string) => (/^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`)
function columnValues(letter: string): string[] {
  const index = letter.charCodeAt(0) - 65
  const last = Math.max(1, ...Object.keys(sheet.rows).map(Number))
  const values: string[] = []
  for (let row = 2; row <= last; row++) values.push(sheet.rows[row]?.[index] ?? '')
  while (values.length && values[values.length - 1] === '') values.pop()
  return values
}
// The fake's answers are plain objects with the four members the code uses
// (ok, status, text(), json()), all promise-based. Not a real Response:
// the first one in a process loads Node's fetch internals, measured at
// 21-24 ms idle and 28-34 ms under load, which made every test waiting on
// this fake race wall time (tests/background.test.ts, settle()).
export const fakeResponse = (status: number, text: string) =>
  ({ ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) }) as unknown as Response

;(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  const u = decodeURIComponent(url)
  log.fetches.push(u.replace(/^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets/, ''))
  const step = ctl.fetchPlan.length ? ctl.fetchPlan.shift()! : 200
  if (step === 'abort') throw new DOMException('The operation was aborted.', 'AbortError')
  if (step !== 200) return fakeResponse(step, `{"error":{"code":${step}}}`)
  // A Workday job JSON read (2026-09-21): whatever ctl.workdayJson says.
  if (u.includes('/wday/cxs/')) {
    if (!ctl.workdayJson) throw new TypeError('Failed to fetch')
    return fakeResponse(ctl.workdayJson.status, JSON.stringify(ctl.workdayJson.body))
  }
  // Drive files.get?fields=trashed (isTrashed): per ctl.trashedIds; a
  // deleted file answers 404.
  const driveFile = u.match(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)/)?.[1]
  if (driveFile) {
    if (ctl.goneIds.has(driveFile)) return fakeResponse(404, `{"error":{"code":404,"message":"File not found: ${driveFile}."}}`)
    return fakeResponse(200, JSON.stringify({ trashed: ctl.trashedIds.has(driveFile) }))
  }
  // A deleted spreadsheet: every Sheets call on it answers 404.
  const sheetsId = u.match(/^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/([^/?:]+)/)?.[1]
  if (sheetsId && ctl.goneIds.has(sheetsId)) {
    return fakeResponse(404, '{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}')
  }
  // A range must name the fake tab, quoted ('It''s'!A1) or not; Sheets
  // answers any other name with 400 "Unable to parse range".
  const named = u.match(/(?:\/values\/|ranges=)(?:'((?:[^']|'')*)'|([^!'?&/]+))!/)
  const rangeSheet = named ? (named[1] !== undefined ? named[1].replace(/''/g, "'") : named[2]) : undefined
  if (rangeSheet !== undefined && rangeSheet !== ctl.sheetTitle) {
    return fakeResponse(400, `{"error":{"code":400,"message":"Unable to parse range: ${rangeSheet}!A1"}}`)
  }
  if (init?.method === 'PUT') {
    sheet.writes.push({ range: u.match(/\/values\/([^?]+)/)?.[1] ?? '', values: JSON.parse(String(init.body)).values })
  }
  if (u.includes(':batchUpdate') && init?.body) log.batchUpdates.push(JSON.parse(String(init.body)).requests)
  let appended: number | undefined
  if (u.includes(':append') && init?.body) {
    appendedRow = Math.max(appendedRow, ...Object.keys(sheet.rows).map(Number)) + 1
    appended = appendedRow
    sheet.rows[appended] = (JSON.parse(String(init.body)).values[0] as unknown[]).map((v) => String(v))
    if (ctl.appendThenAbort) {
      ctl.appendThenAbort = false
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
  }
  // values:batchGet (readCells): one column slice per ranges= parameter,
  // majorDimension=COLUMNS, trailing blanks dropped like the real API.
  const batchRanges = u.includes('values:batchGet') ? [...u.matchAll(/ranges=(?:'(?:[^']|'')*'|[^!&]+)!([A-Z])(\d+):\1(\d+)/g)] : []
  const columnSlice = (letter: string, from: number, to: number) => {
    const values: string[] = []
    for (let row = from; row <= to; row++) values.push(sheet.rows[row]?.[letter.charCodeAt(0) - 65] ?? '')
    while (values.length && values[values.length - 1] === '') values.pop()
    return values
  }
  const rowRead = u.match(/!(\d+):(\d+)(?:\?|$)/)
  const columnRead = u.match(/!([A-Z])2:\1(?:\?|$)/)
  // A create names the new spreadsheet; each one gets the next id, so a test
  // that creates twice can tell the sheets apart.
  let createdId: string | undefined
  if (u === 'https://sheets.googleapis.com/v4/spreadsheets' && init?.body) {
    createdId = `new${++created}`
    ctl.titles[createdId] = String(JSON.parse(String(init.body)).properties?.title ?? '')
  }
  const titleRead = u.match(/^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/([^/?]+)\?fields=properties\.title$/)
  const body =
    createdId !== undefined
      ? { spreadsheetId: createdId, sheets: [{ properties: { title: 'Sheet1', sheetId: ctl.createdSheetId } }] }
      : titleRead
        ? { properties: { title: ctl.titles[titleRead[1]] ?? '' } }
        : u.endsWith('?fields=sheets.properties')
          ? { sheets: [{ properties: ctl.tabDeleted ? { title: 'Other', sheetId: 5 } : { title: ctl.sheetTitle, sheetId: 0 } }] }
          : batchRanges.length
            ? { valueRanges: batchRanges.map((m) => ({ values: [columnSlice(m[1], Number(m[2]), Number(m[3]))] })) }
            : columnRead
              ? { values: [columnValues(columnRead[1])] }
              : rowRead && rowRead[1] === rowRead[2] && rowRead[1] !== '1'
                ? { values: sheet.rows[Number(rowRead[1])] ? [sheet.rows[Number(rowRead[1])]] : [] }
                : appended !== undefined
                  ? { updates: { updatedRange: `${googleQuoted(ctl.sheetTitle)}!A${appended}:I${appended}` } }
                  : u.includes('!1:1')
                    ? { values: [ctl.headers] }
                    : {}
  return fakeResponse(200, JSON.stringify(body))
}
