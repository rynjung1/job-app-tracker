import { useEffect, useRef, useState } from 'react'
import type { SheetRef } from '../providers/types'
import { getRecentApplications } from '../lib/recentApplications'
import type { RecentApplication } from '../lib/recentApplications'
import { SHEET_REF_KEY } from '../lib/storageKeys'
import { getLastResumeVersions } from '../lib/resumeVersion'
import type { ResumeVersionsByRoleType } from '../lib/resumeVersion'
import { safeJobUrl } from '../lib/safeUrl'
import type { StatusValue } from '../lib/sheetTemplate'
import { applicationCount } from '../lib/authStatus'
import { sheetProblemMessage, sheetProblemTitle } from '../lib/sheetStatus'
import type { BackgroundResponse } from '../background/messageRouter'
import { CheckIcon, ClockIcon, GearIcon, LockIcon, SheetIcon, WarnIcon } from '../ui/icons'
import { useSyncStatus } from '../ui/useSyncStatus'
import { StatusSelect } from './StatusSelect'
import { RowMenu } from './RowMenu'
import { ResumeVersionEditor } from './ResumeVersionEditor'

// Opened by the notification's Edit button (background/index.ts), this page
// is a small window showing only the resume editor for that entry. Opened
// from the toolbar, there's no edit param and it's the popup.
const editId = new URLSearchParams(window.location.search).get('edit')
if (editId) document.body.classList.add('in-window')

const STALE_ROW_STATUS =
  "This row may have changed since it was logged, so its status wasn't changed. You can still change it in your spreadsheet."
const STALE_ROW_RESUME =
  "This row may have changed since it was logged, so it wasn't updated. You can still change it in your spreadsheet."
const SIGN_IN_NEEDED = 'Google sign-in needed. Reconnect, then try again.'
const SHEET_UNAVAILABLE = "Your sheet is in Google Drive's trash or was deleted, so nothing was changed. See the note above."
const GENERIC_ERROR = 'Something went wrong. Please try again.'

function errorMessage(code: string | undefined, staleMessage: string): string {
  if (code === 'STALE_ROW') return staleMessage
  if (code === 'AUTH_REQUIRED') return SIGN_IN_NEEDED
  if (code === 'SHEET_UNAVAILABLE') return SHEET_UNAVAILABLE
  return GENERIC_ERROR
}

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

type View = { mode: 'list' } | { mode: 'edit'; id: string }

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
  const [lastUsed, setLastUsed] = useState<ResumeVersionsByRoleType>({})
  const [view, setView] = useState<View>(editId ? { mode: 'edit', id: editId } : { mode: 'list' })
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const { authStatus, sheetStatus, queued } = useSyncStatus()
  const signedOut = authStatus !== undefined
  // Why the status chip and "Change resume version" can't write right now:
  // signed out, or the sheet is in Drive's trash or deleted (2026-09-14).
  const blockedReason = signedOut
    ? 'Reconnect Google Sheets first'
    : sheetStatus
      ? `${sheetProblemTitle(sheetStatus.state)}: restore it or create a new sheet first`
      : null
  // After the editor closes, focus goes back to the row's ⋯ it came from.
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
    getLastResumeVersions().then(setLastUsed)
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
    setEditorError(null)
    setRowError(null)
    setView({ mode: 'edit', id: entry.id })
  }

  function closeEditor(entryId: string) {
    if (editId) {
      window.close()
      return
    }
    setEditorError(null)
    returnFocusTo.current = entryId
    setView({ mode: 'list' })
  }

  async function handleSaveResume(entry: RecentApplication, resumeVersion: string) {
    setSaving(true)
    setEditorError(null)
    try {
      // The notification's Edit window skips the identity check for the
      // entry it was opened for (its short correction window); the popup's
      // editor always checks. Sent explicitly rather than inferred.
      const skipIdentityCheck = editId !== null && entry.id === editId
      const response = (await chrome.runtime.sendMessage({
        type: 'SAVE_RESUME_VERSION',
        payload: { entryId: entry.id, resumeVersion, skipIdentityCheck },
      })) as BackgroundResponse<RecentApplication>
      if (!response.ok) {
        setEditorError(errorMessage(response.code, STALE_ROW_RESUME))
        return
      }
      patchApplication(entry.id, response.data)
      getLastResumeVersions().then(setLastUsed)
      closeEditor(entry.id)
    } catch (err) {
      console.error('[job-app-tracker] failed to save resume version:', err)
      setEditorError(GENERIC_ERROR)
    } finally {
      setSaving(false)
    }
  }

  const loading = !sheetRefChecked || applications === null
  const editing = view.mode === 'edit' ? applications?.find((a) => a.id === view.id) : undefined

  const editor = editing && (
    <ResumeVersionEditor
      key={editing.id}
      entry={editing}
      appliedOn={formatDate(editing.date)}
      lastUsed={lastUsed}
      saving={saving}
      error={editorError}
      onSave={(value) => handleSaveResume(editing, value)}
      onCancel={() => closeEditor(editing.id)}
    />
  )

  // The notification's Edit window: the editor only.
  if (editId) {
    if (loading) return <p className="window-note">Loading…</p>
    if (editor) return editor
    return (
      <div className="window-note">
        <p>
          This application is no longer in your recent list, so its resume version can't be changed here. You can still
          change it in your spreadsheet.
        </p>
        <button type="button" className="btn lg" onClick={() => window.close()}>
          Close
        </button>
      </div>
    )
  }

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

      {!loading && sheetRef !== undefined && editor}

      {/* Statuses in the list stay the saved ones while signed out: the live
          read needs sign-in too, and a failed read shows nothing live. */}
      {!loading && sheetRef !== undefined && !editor && authStatus && (
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
      {!loading && sheetRef !== undefined && !editor && !authStatus && sheetStatus && (
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

      {!loading && sheetRef !== undefined && !editor && !authStatus && !sheetStatus && queued > 0 && (
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

      {!loading && sheetRef !== undefined && !editor && applications.length === 0 && (
        <div className="empty">
          <h2>No applications yet</h2>
          <p>Apply with LinkedIn Easy Apply or on a Greenhouse job page and it will show up here.</p>
        </div>
      )}

      {!loading && sheetRef !== undefined && !editor && applications.length > 0 && (
        <ul className="list" aria-label="Recent applications">
          {applications.map((app) => {
            const status = liveStatuses[app.id] ?? app.status
            const url = safeJobUrl(app.url)
            const busy = statusBusyId === app.id
            const error = rowError?.id === app.id ? rowError.message : null
            const place = [app.title, app.location].filter(Boolean).join(' · ')
            const meta = [app.resumeVersion && `Resume ${app.resumeVersion}`, formatDate(app.date)]
              .filter(Boolean)
              .join(' · ')
            return (
              <li key={app.id} className={error ? 'row has-error' : 'row'} aria-busy={busy || undefined}>
                <div className="r1">
                  {url ? (
                    <a className="co" href={url} target="_blank" rel="noopener noreferrer" title={`${app.company}: open the job posting`}>
                      {app.company}
                      <span className="sr-only"> (opens the job posting in a new tab)</span>
                    </a>
                  ) : (
                    <span className="co">{app.company}</span>
                  )}
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
                    onChangeResume={() => openEditor(app)}
                  />
                </div>
                {/* One line: the title takes the ellipsis, the location stays
                    whole. Full text in the tooltip. */}
                <div className="ti" title={place}>
                  <span className="t">{app.title}</span>
                  {app.location && (
                    <>
                      <span className="tsep" aria-hidden="true">
                        ·
                      </span>
                      <span className="sr-only">, </span>
                      <span className="loc">{app.location}</span>
                    </>
                  )}
                </div>
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
