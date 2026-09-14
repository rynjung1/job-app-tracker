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
}
// The fake sheet's header row: a sheet made before 2026-09-14 (8 columns)
// or one with the hidden Log ID column.
export const HEADERS_8 = ['Date', 'Company', 'Title', 'Location', 'URL', 'Resume Version', 'Status', 'Notes']
export const HEADERS_WITH_LOG_ID = [...HEADERS_8, 'Log ID']

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
  log.tokenCalls = 0
  ctl.tokenReject = false
  ctl.online = true
  ctl.fetchPlan = []
  ctl.failQueueWrite = false
  ctl.headers = HEADERS_8
  ctl.appendThenAbort = false
}

// fetchWithTimeout's 30s timer is left running when a request is aborted
// (the timeout case below). Long timers are unref'd so they can't keep the
// test process alive; short ones (the code's own awaits) are untouched.
const realSetTimeout = globalThis.setTimeout
;(globalThis as any).setTimeout = (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => {
  const timer = realSetTimeout(fn, ms, ...args) as any
  if ((ms ?? 0) >= 10_000) timer.unref?.()
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
  alarms: { create: () => {}, clear: async () => true, onAlarm: on('onAlarm') },
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
function columnValues(letter: string): string[] {
  const index = letter.charCodeAt(0) - 65
  const last = Math.max(1, ...Object.keys(sheet.rows).map(Number))
  const values: string[] = []
  for (let row = 2; row <= last; row++) values.push(sheet.rows[row]?.[index] ?? '')
  while (values.length && values[values.length - 1] === '') values.pop()
  return values
}
;(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  const u = decodeURIComponent(url)
  log.fetches.push(u.replace(/^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets/, ''))
  const step = ctl.fetchPlan.length ? ctl.fetchPlan.shift()! : 200
  if (step === 'abort') throw new DOMException('The operation was aborted.', 'AbortError')
  if (step !== 200) return new Response(`{"error":{"code":${step}}}`, { status: step })
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
  const rowRead = u.match(/!(\d+):(\d+)(?:\?|$)/)
  const columnRead = u.match(/!([A-Z])2:\1(?:\?|$)/)
  const body =
    u === 'https://sheets.googleapis.com/v4/spreadsheets'
      ? { spreadsheetId: 'new1', sheets: [{ properties: { title: 'Sheet1', sheetId: 0 } }] }
      : columnRead
        ? { values: [columnValues(columnRead[1])] }
        : rowRead && rowRead[1] === rowRead[2] && rowRead[1] !== '1'
          ? { values: sheet.rows[Number(rowRead[1])] ? [sheet.rows[Number(rowRead[1])]] : [] }
          : appended !== undefined
            ? { updates: { updatedRange: `Sheet1!A${appended}:I${appended}` } }
            : u.includes('!1:1')
              ? { values: [ctl.headers] }
              : {}
  return new Response(JSON.stringify(body), { status: 200 })
}
