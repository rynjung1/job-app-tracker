import { useEffect, useRef, useState } from 'react'
import type { SheetRef } from '../providers/types'
import { getRecentApplications } from '../lib/recentApplications'
import type { RecentApplication } from '../lib/recentApplications'
import { SHEET_REF_KEY } from '../lib/storageKeys'
import { safeJobUrl } from '../lib/safeUrl'
import type { StatusValue } from '../lib/sheetTemplate'
import { applicationCount } from '../lib/authStatus'
import { sheetProblemMessage, sheetProblemTitle } from '../lib/sheetStatus'
import { mergeWaiting, waitingFromQueue, weekSummary } from '../lib/popupList'
import type { WaitingApplication, WeekSummary } from '../lib/popupList'
import type { BackgroundResponse } from '../background/messageRouter'
import { CheckIcon, ClockIcon, GearIcon, LockIcon, SheetIcon, WarnIcon } from '../ui/icons'
import { useSyncStatus } from '../ui/useSyncStatus'
import { StatusSelect } from './StatusSelect'
import { RowMenu } from './RowMenu'
import { NoteEditor } from './NoteEditor'
import { errorMessage, GENERIC_ERROR, STALE_ROW_STATUS } from './messages'

function sheetUrl(sheetRef: SheetRef): string {
  return `https://docs.google.com/spreadsheets/d/${sheetRef.spreadsheetId}/edit`
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Settings opens as a singleton window from the background worker
// (background/settingsWindow.ts); the options page in a tab is the fallback.
// { reconnect: true } starts Google's sign-in there: the popup closes as
// soon as Google's window opens, so Settings is where the result shows.
async function openSettings({ reconnect = false }: { reconnect?: boolean } = {}) {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'OPEN_SETTINGS',
      payload: { reconnect },
    })) as BackgroundResponse<undefined>
    if (!response.ok) throw new Error(response.error)
  } catch (err) {
    console.warn('[job-app-tracker] Settings window failed, opening the options page instead:', err)
    chrome.runtime.openOptionsPage()
  }
}

// One line: the title takes the ellipsis, the location stays whole. Full
// text in the tooltip.
function Place({ title, location }: { title: string; location: string | null }) {
  const place = [title, location].filter(Boolean).join(' · ')
  return (
    <div className="ti" title={place}>
      <span className="t">{title}</span>
      {location && (
        <>
          <span className="tsep" aria-hidden="true">
            ·
          </span>
          <span className="sr-only">, </span>
          <span className="loc">{location}</span>
        </>
      )}
    </div>
  )
}

function CompanyLink({ company, url }: { company: string; url: string | null }) {
  return url ? (
    <a className="co" href={url} target="_blank" rel="noopener noreferrer" title={`${company}: open the job posting`}>
      {company}
      <span className="sr-only"> (opens the job posting in a new tab)</span>
    </a>
  ) : (
    <span className="co">{company}</span>
  )
}

// A queued application (2026-09-15): it has no row in the sheet yet, so no
// status menu and no ⋯; a spacer keeps the columns lined up with the saved
// rows. The banner above says why it's waiting.
function WaitingRow({ app }: { app: WaitingApplication }) {
  const meta = [formatDate(app.date), 'not in your sheet yet'].filter(Boolean).join(' · ')
  return (
    <li className="row waiting">
      <div className="r1">
        <CompanyLink company={app.company} url={safeJobUrl(app.url)} />
        <span className="chip chip-waiting" title="Not in your sheet yet. It's saved automatically once it can be.">
          <ClockIcon size={12} />
          Waiting
        </span>
        <span className="more-spacer" aria-hidden="true" />
      </div>
      <Place title={app.title} location={app.location} />
      <div className="meta">{meta}</div>
    </li>
  )
}

// "3 this week · 2 interviews" (2026-09-15; lib/popupList.ts says what counts).
// Plain inline text with real spaces, so it reads the same to a screen reader.
function Summary({ summary }: { summary: WeekSummary }) {
  return (
    <div className="sum" title="This week runs Monday to Sunday. Cancelled applications aren't counted.">
      <b>
        {summary.thisWeek}
        {summary.more ? '+' : ''}
      </b>{' '}
      this week{' '}
      <span className="sum-sep" aria-hidden="true">
        ·
      </span>{' '}
      <b>{summary.interviews}</b> {summary.interviews === 1 ? 'interview' : 'interviews'}
    </div>
  )
}

type View = { mode: 'list' } | { mode: 'note'; id: string }

function App() {
  const [applications, setApplications] = useState<RecentApplication[] | null>(null)
  const [sheetRef, setSheetRef] = useState<SheetRef | undefined>()
  // sheetRef itself starts undefined both before the storage read resolves
  // AND when genuinely not connected — this distinguishes "still loading"
  // from "confirmed not connected," so the connect-prompt below only
  // renders once we actually know there's nothing connected.
  const [sheetRefChecked, setSheetRefChecked] = useState(false)
  // Entry id -> the sheet's current Status, for rows that still match
  // (background GET_LIVE_STATUSES). Shown over the cached status; never
  // written back to the cached list.
  const [liveStatuses, setLiveStatuses] = useState<Record<string, string>>({})
  // Entries this popup changed itself (a status change), so a live read
  // that was already in flight can't put their old status back.
  const changedHere = useRef(new Set<string>())
  const [view, setView] = useState<View>({ mode: 'list' })
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)
  const { authStatus, sheetStatus, queued, queue } = useSyncStatus()
  const signedOut = authStatus !== undefined
  // Why the status chip and "Add note" can't reach the sheet right now:
  // signed out, or the sheet is in Drive's trash or deleted (2026-09-14).
  const blockedReason = signedOut
    ? 'Reconnect Google Sheets first'
    : sheetStatus
      ? `${sheetProblemTitle(sheetStatus.state)}: restore it or create a new sheet first`
      : null
  // After an editor closes, focus goes back to the row's ⋯ it came from.
  // Done in an effect once the list is back in the DOM, not on a timer.
  const returnFocusTo = useRef<string | null>(null)

  useEffect(() => {
    if (view.mode !== 'list' || !returnFocusTo.current) return
    document.getElementById(`more-${returnFocusTo.current}`)?.focus()
    returnFocusTo.current = null
  }, [view])

  useEffect(() => {
    getRecentApplications().then(setApplications)
    chrome.storage.local.get(SHEET_REF_KEY).then((stored) => {
      setSheetRef(stored[SHEET_REF_KEY] as SheetRef | undefined)
      setSheetRefChecked(true)
    })
    // Cached list first (above), live statuses when they arrive. A failed
    // read (offline, signed out) just leaves the cached statuses showing.
    ;(chrome.runtime.sendMessage({ type: 'GET_LIVE_STATUSES' }) as Promise<BackgroundResponse<Record<string, string>>>)
      .then((response) => {
        if (!response.ok) throw new Error(response.error)
        const live = { ...response.data }
        changedHere.current.forEach((id) => delete live[id])
        setLiveStatuses(live)
      })
      .catch((err) => console.warn('[job-app-tracker] live statuses unavailable, showing saved ones:', err))
  }, [])

  function patchApplication(id: string, patch: Partial<RecentApplication>) {
    setApplications((prev) => prev?.map((a) => (a.id === id ? { ...a, ...patch } : a)) ?? prev)
  }

  async function handleSetStatus(entry: RecentApplication, status: StatusValue) {
    setStatusBusyId(entry.id)
    setRowError(null)
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'SET_STATUS',
        payload: { entryId: entry.id, status },
      })) as BackgroundResponse<RecentApplication>
      if (!response.ok) {
        setRowError({ id: entry.id, message: errorMessage(response.code, STALE_ROW_STATUS) })
        return
      }
      // The sheet now holds this status: drop any live status for the row
      // and keep a live read already in flight from putting the old one back.
      changedHere.current.add(entry.id)
      setLiveStatuses((prev) => {
        const next = { ...prev }
        delete next[entry.id]
        return next
      })
      patchApplication(entry.id, response.data)
    } catch (err) {
      console.error('[job-app-tracker] status change failed:', err)
      setRowError({ id: entry.id, message: GENERIC_ERROR })
    } finally {
      setStatusBusyId(null)
    }
  }

  function openEditor(entry: RecentApplication) {
    setRowError(null)
    setView({ mode: 'note', id: entry.id })
  }

  function closeEditor(entryId: string) {
    returnFocusTo.current = entryId
    setView({ mode: 'list' })
  }

  const loading = !sheetRefChecked || applications === null
  const noting = view.mode === 'note' ? applications?.find((a) => a.id === view.id) : undefined
  // The list (2026-09-15): saved entries and waiting applications, newest
  // first, and the summary line counted from them (lib/popupList.ts).
  const waiting = waitingFromQueue(queue)
  const items = mergeWaiting(applications ?? [], waiting)
  const summary = weekSummary(items, (app) => liveStatuses[app.id] ?? app.status, new Date())

  const noteEditor = noting && (
    <NoteEditor key={noting.id} entry={noting} appliedOn={formatDate(noting.date)} onClose={() => closeEditor(noting.id)} />
  )
  const panel = noteEditor

  return (
    <>
      <header className="hdr">
        <span className="mark" aria-hidden="true">
          <CheckIcon size={14} />
        </span>
        <h1>Job Application Tracker</h1>
        {sheetRef && (
          <a className="tbtn" href={sheetUrl(sheetRef)} target="_blank" rel="noopener noreferrer">
            <SheetIcon size={15} />
            Open sheet
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        <button type="button" className="icon-btn" onClick={() => openSettings()} aria-label="Settings" title="Settings">
          <GearIcon />
        </button>
      </header>

      {!loading && sheetRef !== undefined && !panel && items.length > 0 && <Summary summary={summary} />}

      {loading && (
        <div className="list" aria-busy="true">
          <span className="sr-only">Loading…</span>
          {[55, 45].map((width) => (
            <div className="row" key={width} aria-hidden="true">
              <div className="skel" style={{ width: `${width}%` }} />
              <div className="skel" style={{ width: `${width + 25}%` }} />
            </div>
          ))}
        </div>
      )}

      {!loading && sheetRef === undefined && (
        <div className="empty">
          <div className="big" aria-hidden="true">
            <SheetIcon size={22} />
          </div>
          <h2>Connect a spreadsheet</h2>
          <p>Applications you submit on LinkedIn Easy Apply or Greenhouse are logged to a Google Sheet automatically.</p>
          <button type="button" className="btn primary lg" onClick={() => openSettings()}>
            Open Settings
          </button>
        </div>
      )}

      {/* Applications made before a sheet was connected wait in the queue;
          Connect saves them. Listed under the prompt so they're not unseen. */}
      {!loading && sheetRef === undefined && waiting.length > 0 && (
        <ul className="list" aria-label="Applications waiting to be saved">
          {waiting.map((app) => (
            <WaitingRow key={app.key} app={app} />
          ))}
        </ul>
      )}

      {!loading && sheetRef !== undefined && panel}

      {/* Statuses in the list stay the saved ones while signed out: the live
          read needs sign-in too, and a failed read shows nothing live. */}
      {!loading && sheetRef !== undefined && !panel && authStatus && (
        <div className="banner" role="alert">
          <LockIcon />
          <div>
            <b>Google sign-in needed</b>
            <p>
              {queued > 0
                ? `Logging is paused. ${applicationCount(queued)} ${queued === 1 ? 'is' : 'are'} waiting and will be saved to your sheet when you reconnect.`
                : 'Logging is paused until you reconnect.'}
            </p>
            <button type="button" className="btn primary" onClick={() => openSettings({ reconnect: true })}>
              Reconnect
            </button>
          </div>
        </div>
      )}

      {/* The sheet is in Drive's trash or deleted (2026-09-14): nothing is
          written until it's restored or replaced; Settings has the choices. */}
      {!loading && sheetRef !== undefined && !panel && !authStatus && sheetStatus && (
        <div className="banner" role="alert">
          <WarnIcon />
          <div>
            <b>{sheetProblemTitle(sheetStatus.state)}</b>
            <p>{sheetProblemMessage(sheetStatus.state, queued)}</p>
            <button type="button" className="btn primary" onClick={() => openSettings()}>
              Open Settings
            </button>
          </div>
        </div>
      )}

      {!loading && sheetRef !== undefined && !panel && !authStatus && !sheetStatus && queued > 0 && (
        <div className="banner info" role="status">
          <ClockIcon />
          <div>
            <b>{applicationCount(queued)} waiting to be saved</b>
            <p>
              Saving didn't go through (offline?). {queued === 1 ? "It'll" : "They'll"} be retried automatically every 5
              minutes.
            </p>
          </div>
        </div>
      )}

      {!loading && sheetRef !== undefined && !panel && items.length === 0 && (
        <div className="empty">
          <h2>No applications yet</h2>
          <p>Apply with LinkedIn Easy Apply or on a Greenhouse job page and it will show up here.</p>
        </div>
      )}

      {!loading && sheetRef !== undefined && !panel && items.length > 0 && (
        <ul className="list" aria-label="Recent applications">
          {items.map((item) => {
            if (item.kind === 'waiting') return <WaitingRow key={`w-${item.app.key}`} app={item.app} />
            const app = item.app
            const status = liveStatuses[app.id] ?? app.status
            const url = safeJobUrl(app.url)
            const busy = statusBusyId === app.id
            const error = rowError?.id === app.id ? rowError.message : null
            const meta = formatDate(app.date)
            return (
              <li key={app.id} className={error ? 'row has-error' : 'row'} aria-busy={busy || undefined}>
                <div className="r1">
                  <CompanyLink company={app.company} url={url} />
                  <StatusSelect
                    company={app.company}
                    status={status}
                    disabled={blockedReason !== null || busy}
                    disabledReason={
                      signedOut ? 'Reconnect Google Sheets to change the status' : (blockedReason ?? 'Reconnect Google Sheets to change the status')
                    }
                    busy={busy}
                    onChange={(next) => handleSetStatus(app, next)}
                  />
                  <RowMenu
                    entryId={app.id}
                    company={app.company}
                    url={url}
                    blockedReason={blockedReason}
                    onAddNote={() => openEditor(app)}
                  />
                </div>
                <Place title={app.title} location={app.location} />
                <div className="meta">{meta}</div>
                {error && (
                  <div className="err" role="alert">
                    <WarnIcon size={16} />
                    <span>{error}</span>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

export default App
