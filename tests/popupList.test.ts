// The popup's list and summary line (2026-09-15): waiting applications merged
// into the recent list, and "this week" as the current calendar week, Monday
// 00:00 to the end of Sunday, local time. Pure functions, no page. Dates are
// built with the local-time Date constructor, so the cases hold in any
// timezone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeWaiting, waitingFromQueue, weekStart, weekSummary } from '../src/lib/popupList'
import type { ListItem } from '../src/lib/popupList'
import type { RecentApplication } from '../src/lib/recentApplications'

const local = (y: number, m: number, d: number, h = 10, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s)
const iso = (date: Date) => date.toISOString()
const entry = (id: string, date: Date, status = 'Applied', logId?: string): RecentApplication => ({
  id,
  company: `Co ${id}`,
  title: 'Engineer',
  location: null,
  url: `https://jobs.example.com/${id}`,
  date: iso(date),
  resumeVersion: '',
  status,
  sheetName: 'Sheet1',
  rowNumber: 2,
  logId,
})
const queued = (logId: string | undefined, date: Date, company = 'Queued Co') => ({
  Date: iso(date),
  Company: company,
  Title: 'Engineer',
  Location: '',
  URL: 'https://jobs.example.com/q',
  'Resume Version': 'SWE v1',
  Status: '',
  Notes: '',
  ...(logId ? { 'Log ID': logId } : {}),
})
const saved = (apps: RecentApplication[]): ListItem[] => apps.map((app) => ({ kind: 'saved', app }))
const cached = (app: RecentApplication) => app.status

test('popup list and summary line', async (t) => {
  // A Wednesday in September 2026; its week's Monday is found, not assumed.
  const monday = weekStart(local(2026, 9, 16, 12))
  const day = (offset: number, h = 10, min = 0, s = 0) =>
    local(monday.getFullYear(), monday.getMonth() + 1, monday.getDate() + offset, h, min, s)

  await t.test('weekStart: a Monday at 00:00 local; every moment Monday 00:00 to Sunday 23:59:59 maps to it; a minute earlier is the week before', () => {
    assert.equal(monday.getDay(), 1)
    assert.deepEqual([monday.getHours(), monday.getMinutes(), monday.getSeconds()], [0, 0, 0])
    for (let offset = 0; offset < 7; offset++) {
      assert.equal(weekStart(day(offset, 0, 0, 0)).getTime(), monday.getTime(), `day ${offset} 00:00`)
      assert.equal(weekStart(day(offset, 23, 59, 59)).getTime(), monday.getTime(), `day ${offset} 23:59:59`)
    }
    assert.equal(weekStart(day(-1, 23, 59)).getTime(), day(-7, 0).getTime())
    assert.equal(weekStart(day(7, 0)).getTime(), day(7, 0).getTime())
  })

  await t.test('weekSummary: counts saved and waiting applications dated this week, not Cancelled ones (by the shown status), and Interviews at any date', () => {
    const now = day(2, 15)
    const apps = [
      entry('applied', day(1)), // this week
      entry('mondayMidnight', day(0, 0, 0)), // this week, its first moment
      entry('cachedCancelled', day(1), 'Cancelled'), // not counted
      entry('liveCancelled', day(1)), // live status Cancelled: not counted
      entry('liveInterview', day(0, 9), 'Cancelled'), // live Interview: counted, and an interview
      entry('lastSunday', day(-1, 23, 59)), // the week before
      entry('olderInterview', day(-10), 'Interview'), // an interview, not this week
    ]
    const live: Record<string, string> = { liveCancelled: 'Cancelled', liveInterview: 'Interview' }
    const items: ListItem[] = [
      { kind: 'waiting', app: waitingFromQueue([queued('w1', day(2, 9))])[0] }, // this week
      { kind: 'waiting', app: waitingFromQueue([queued('w2', day(-2))])[0] }, // the week before
      ...saved(apps),
    ]
    const summary = weekSummary(items, (app) => live[app.id] ?? app.status, now)
    assert.deepEqual(summary, { thisWeek: 4, more: false, interviews: 2 })
  })

  await t.test('weekSummary: "20+" only when the list holds 20 saved entries and even the oldest is from this week', () => {
    const now = day(6, 20)
    const allThisWeek = Array.from({ length: 20 }, (_, i) => entry(`a${i}`, day(i % 7, 1 + (i % 20))))
    const oldestLastWeek = [...allThisWeek.slice(0, 19), entry('old', day(-3))]
    const nineteen = allThisWeek.slice(0, 19)
    assert.deepEqual(weekSummary(saved(allThisWeek), cached, now), { thisWeek: 20, more: true, interviews: 0 })
    assert.equal(weekSummary(saved(oldestLastWeek), cached, now).more, false)
    assert.equal(weekSummary(saved(nineteen), cached, now).more, false)
    assert.deepEqual(weekSummary([], cached, now), { thisWeek: 0, more: false, interviews: 0 })
  })

  await t.test('mergeWaiting: newest first by applied date, waiting rows among the saved ones', () => {
    const recent = [entry('r1', day(2, 10)), entry('r2', day(1, 10)), entry('r3', day(0, 10))]
    const waiting = waitingFromQueue([queued('q1', day(2, 11), 'Q1'), queued('q2', day(1, 18), 'Q2')])
    const order = mergeWaiting(recent, waiting).map((item) => (item.kind === 'waiting' ? `W:${item.app.company}` : item.app.id))
    assert.deepEqual(order, ['W:Q1', 'r1', 'W:Q2', 'r2', 'r3'])
  })

  await t.test('mergeWaiting: a waiting row whose Log ID already has a saved entry is left out; one without a Log ID stays', () => {
    const recent = [entry('r1', day(1), 'Applied', 'same-id')]
    const waiting = waitingFromQueue([queued('same-id', day(1), 'Drained'), queued(undefined, day(0), 'No Id')])
    const items = mergeWaiting(recent, waiting)
    assert.deepEqual(items.map((item) => item.kind + ':' + item.app.company), ['saved:Co r1', 'waiting:No Id'])
  })

  await t.test('mergeWaiting: 20 saved entries and 3 waiting -> 23 items; the cap never hides a waiting row', () => {
    const recent = Array.from({ length: 20 }, (_, i) => entry(`r${i}`, day(-i)))
    const waiting = waitingFromQueue([queued('q1', day(-30)), queued('q2', day(-31)), queued('q3', day(1))])
    const items = mergeWaiting(recent, waiting)
    assert.equal(items.length, 23)
    assert.equal(items.filter((item) => item.kind === 'waiting').length, 3)
  })

  await t.test('waitingFromQueue: the queue row\'s columns; an empty Location is null; the Log ID is the key', () => {
    const [app] = waitingFromQueue([queued('k1', day(0), 'Mapped Co')])
    assert.deepEqual(app, {
      key: 'k1',
      company: 'Mapped Co',
      title: 'Engineer',
      location: null,
      url: 'https://jobs.example.com/q',
      date: iso(day(0)),
      resumeVersion: 'SWE v1',
      logId: 'k1',
    })
  })
})
