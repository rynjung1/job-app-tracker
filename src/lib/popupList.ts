import type { RecentApplication } from './recentApplications'
import { MAX_RECENT } from './recentApplications'
import { LOG_ID_COLUMN } from './sheetTemplate'

// The popup's list (2026-09-15, decided by Ryan): the recent entries plus the
// applications still waiting in the offline queue (offline, signed out, the
// sheet in the trash or deleted, or no sheet connected yet), which have no
// row in the sheet yet. Pure, so the merge and the summary line are tested
// without a page (tests/popupList.test.ts).

// A queued application as the popup shows it. Queue rows keep the sheet's
// column names (lib/buildRow.ts).
export interface WaitingApplication {
  key: string
  company: string
  title: string
  location: string | null
  url: string
  date: string
  logId?: string
}

export type ListItem = { kind: 'saved'; app: RecentApplication } | { kind: 'waiting'; app: WaitingApplication }

export function waitingFromQueue(queue: Record<string, string>[]): WaitingApplication[] {
  return queue.map((row, i) => ({
    key: row[LOG_ID_COLUMN] || `queued-${i}`,
    company: row.Company ?? '',
    title: row.Title ?? '',
    location: row.Location || null,
    url: row.URL ?? '',
    date: row.Date ?? '',
    logId: row[LOG_ID_COLUMN] || undefined,
  }))
}

const appliedAt = (date: string) => Date.parse(date) || 0

// Newest first, by the date the user applied. Every waiting application is
// shown: the cap of 20 applies to the saved entries only
// (lib/recentApplications.ts), and the waiting ones are exactly those not in
// the sheet yet. The drain adds a saved row's entry and removes it from the
// queue in two storage writes, so a waiting application whose Log ID already
// has an entry is left out rather than shown twice.
export function mergeWaiting(recent: RecentApplication[], waiting: WaitingApplication[]): ListItem[] {
  const saved = new Set(recent.map((app) => app.logId).filter(Boolean))
  const items: ListItem[] = [
    ...waiting.filter((app) => !(app.logId && saved.has(app.logId))).map((app) => ({ kind: 'waiting' as const, app })),
    ...recent.map((app) => ({ kind: 'saved' as const, app })),
  ]
  // sort is stable: equal dates keep waiting before saved, each in its order.
  return items.sort((a, b) => appliedAt(b.app.date) - appliedAt(a.app.date))
}

// "This week" (decided by Ryan, 2026-09-15): the current calendar week, from
// Monday 00:00 to the end of Sunday, in local time.
export function weekStart(now: Date): Date {
  const daysSinceMonday = (now.getDay() + 6) % 7
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday)
}

export interface WeekSummary {
  thisWeek: number
  // The recent list is full and even its oldest entry is from this week, so
  // earlier applications this week may have dropped off it: shown as "20+".
  more: boolean
  interviews: number
}

// The popup's summary line, from what the popup already has (the list above
// and the status it shows for each entry: live when read, else cached), so
// no extra reads. thisWeek: saved and waiting applications dated this week,
// except those shown as Cancelled. interviews: saved entries shown as
// Interview, whatever their date.
export function weekSummary(items: ListItem[], shownStatus: (app: RecentApplication) => string, now: Date): WeekSummary {
  const start = weekStart(now)
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
  const inWeek = (date: string) => {
    const time = Date.parse(date)
    return time >= start.getTime() && time < end.getTime()
  }
  let thisWeek = 0
  let interviews = 0
  const saved: RecentApplication[] = []
  for (const item of items) {
    if (item.kind === 'waiting') {
      if (inWeek(item.app.date)) thisWeek++
      continue
    }
    saved.push(item.app)
    const status = shownStatus(item.app)
    if (status === 'Interview') interviews++
    if (inWeek(item.app.date) && status !== 'Cancelled') thisWeek++
  }
  const oldest = Math.min(...saved.map((app) => appliedAt(app.date)))
  return { thisWeek, more: saved.length >= MAX_RECENT && oldest >= start.getTime(), interviews }
}
