import { useEffect, useRef, useState } from 'react'
import type { SheetRef } from '../providers/types'
import { getRecentApplications } from '../lib/recentApplications'
import type { RecentApplication } from '../lib/recentApplications'
import { SHEET_REF_KEY } from '../lib/storageKeys'
import type { BackgroundResponse } from '../background/messageRouter'
import { CheckIcon, ClockIcon, GearIcon, LockIcon, SheetIcon, WarnIcon } from '../ui/icons'
import { applicationCount } from '../lib/authStatus'
import { useSyncStatus } from '../ui/useSyncStatus'

// If opened via the notification's Edit button (background/index.ts), this
// is set to that entry's id and this window was created just for editing
// (chrome.windows.create, not the normal toolbar-click popup). Opened
// normally, there's no edit param — editingId starts null and the list is
// just the list, same as before this feature existed.
const editId = new URLSearchParams(window.location.search).get('edit')
if (editId) document.body.classList.add('in-window')

interface ActionError {
  id: string
  message: string
}

const STALE_ROW_MESSAGE_EDIT =
  "This row may have changed since it was logged, so it wasn't updated. You can still edit it in your spreadsheet."
const STALE_ROW_MESSAGE_UNDO =
  "This row may have changed since it was logged, so it wasn't updated. You can still mark it Cancelled in your spreadsheet."
const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'

const KNOWN_STATUSES = ['Applied', 'Interview', 'Offer', 'Rejected', 'Cancelled']

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

function StatusChip({ status }: { status: string }) {
  if (!status) return null
  const variant = KNOWN_STATUSES.includes(status) ? ` chip-${status.toLowerCase()}` : ''
  return <span className={`chip${variant}`}>{status}</span>
}

function NewTabHint() {
  return <span className="sr-only"> (opens in a new tab)</span>
}

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
  // Entries this popup changed itself (Undo), so a live read that was
  // already in flight can't put their old status back.
  const changedHere = useRef(new Set<string>())
  const [editingId, setEditingId] = useState<string | null>(editId)
  const [resumeInput, setResumeInput] = useState('')
  const [savingEditId, setSavingEditId] = useState<string | null>(null)
  const [undoingId, setUndoingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const { authStatus, queued } = useSyncStatus()

  useEffect(() => {
    getRecentApplications().then((apps) => {
      setApplications(apps)
      if (editId) {
        const editing = apps.find((a) => a.id === editId)
        if (editing) setResumeInput(editing.resumeVersion)
      }
    })
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

  // No confirmation — switching to a different row's Edit just discards
  // whatever was typed in the previous one. Nothing has been written
  // anywhere yet at this point, it's local input text only.
  function handleStartEdit(entry: RecentApplication) {
    setEditingId(entry.id)
    setResumeInput(entry.resumeVersion)
    setActionError(null)
  }

  // Closing the panel removes the focused input, so focus goes back to the
  // Edit button it came from instead of falling to the page.
  function closeEditor(id: string) {
    setEditingId(null)
    requestAnimationFrame(() => document.getElementById(`edit-${id}`)?.focus())
  }

  async function handleSaveResumeVersion(entry: RecentApplication) {
    if (!sheetRef) return
    setSavingEditId(entry.id)
    setActionError(null)
    try {
      // The one case that skips the identity check and closes the window
      // on save: this window was opened specifically to edit this exact
      // entry via the notification's Edit button, and the user hasn't
      // since switched to editing a different row. Every other save —
      // including a different row edited from inside this same standalone
      // window — gets the real check, since a stale rowNumber is exactly
      // as possible there as from the normal popup. Sent as an explicit
      // payload field rather than something background has to infer.
      const isOriginalNotificationEdit = editId !== null && editingId === editId && entry.id === editId
      const response = (await chrome.runtime.sendMessage({
        type: 'SAVE_RESUME_VERSION',
        payload: { entryId: entry.id, resumeVersion: resumeInput, skipIdentityCheck: isOriginalNotificationEdit },
      })) as BackgroundResponse<RecentApplication>
      if (!response.ok) {
        setActionError({
          id: entry.id,
          message: response.code === 'STALE_ROW' ? STALE_ROW_MESSAGE_EDIT : GENERIC_ERROR_MESSAGE,
        })
        return
      }
      patchApplication(entry.id, response.data)
      closeEditor(entry.id)
      if (isOriginalNotificationEdit) {
        window.close()
      }
    } catch (err) {
      console.error('[job-app-tracker] failed to save resume version:', err)
      setActionError({ id: entry.id, message: GENERIC_ERROR_MESSAGE })
    } finally {
      setSavingEditId(null)
    }
  }

  async function handleUndo(entry: RecentApplication) {
    if (!sheetRef) return
    setUndoingId(entry.id)
    setActionError(null)
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'CANCEL_APPLICATION',
        payload: { entryId: entry.id },
      })) as BackgroundResponse<RecentApplication>
      if (!response.ok) {
        setActionError({
          id: entry.id,
          message: response.code === 'STALE_ROW' ? STALE_ROW_MESSAGE_UNDO : GENERIC_ERROR_MESSAGE,
        })
        return
      }
      changedHere.current.add(entry.id)
      setLiveStatuses((prev) => {
        const next = { ...prev }
        delete next[entry.id]
        return next
      })
      patchApplication(entry.id, response.data)
    } catch (err) {
      console.error('[job-app-tracker] undo failed:', err)
      setActionError({ id: entry.id, message: GENERIC_ERROR_MESSAGE })
    } finally {
      setUndoingId(null)
    }
  }

  const loading = !sheetRefChecked || applications === null

  return (
    <>
      <header className="hdr">
        <span className="mark" aria-hidden="true">
          <CheckIcon size={14} />
        </span>
        <h1>Job Application Tracker</h1>
        {sheetRef && (
          <a
            className="icon-btn"
            href={sheetUrl(sheetRef)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open spreadsheet (opens in a new tab)"
            title="Open spreadsheet"
          >
            <SheetIcon />
          </a>
        )}
        <button type="button" className="icon-btn" onClick={() => openSettings()} aria-label="Settings" title="Settings">
          <GearIcon />
        </button>
      </header>

      {/* Statuses in the list stay the saved ones while signed out: the live
          read needs sign-in too, and a failed read shows nothing live. */}
      {!loading && sheetRef !== undefined && authStatus && (
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

      {!loading && sheetRef !== undefined && !authStatus && queued > 0 && (
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

      {loading && (
        <div className="list" aria-busy="true">
          <span className="sr-only">Loading…</span>
          {[55, 45].map((width) => (
            <div className="item" key={width} aria-hidden="true">
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

      {!loading && sheetRef !== undefined && applications.length === 0 && (
        <div className="empty">
          <h2>No applications yet</h2>
          <p>Apply with LinkedIn Easy Apply or on a Greenhouse job page and it will show up here.</p>
          <a className="link" href={sheetUrl(sheetRef)} target="_blank" rel="noopener noreferrer">
            Open your sheet <span aria-hidden="true">↗</span>
            <NewTabHint />
          </a>
        </div>
      )}

      {!loading && sheetRef !== undefined && applications.length > 0 && (
        <>
          <ul className="list" aria-label="Recent applications">
            {applications.map((app) => {
              const status = liveStatuses[app.id] ?? app.status
              const saving = savingEditId === app.id
              const undoing = undoingId === app.id
              const meta = [app.resumeVersion && `Resume ${app.resumeVersion}`, formatDate(app.date)]
                .filter(Boolean)
                .join(' · ')
              return (
                <li key={app.id} className="item" aria-busy={saving || undoing || undefined}>
                  <div className="row1">
                    <div className="who">
                      <div className="co">{app.company}</div>
                      <div className="ti">
                        {app.title}
                        {app.location && (
                          <>
                            {' · '}
                            <span className="loc" title={app.location}>
                              {app.location}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <StatusChip status={status} />
                  </div>

                  {editingId === app.id ? (
                    <form
                      className="edit"
                      onSubmit={(e) => {
                        e.preventDefault()
                        handleSaveResumeVersion(app)
                      }}
                    >
                      <label htmlFor={`rv-${app.id}`}>Resume version</label>
                      <input
                        id={`rv-${app.id}`}
                        className="input"
                        type="text"
                        value={resumeInput}
                        onChange={(e) => setResumeInput(e.target.value)}
                        disabled={saving}
                        autoFocus
                      />
                      <div className="acts">
                        <button type="button" className="btn" onClick={() => closeEditor(app.id)} disabled={saving}>
                          Cancel
                        </button>
                        <button type="submit" className="btn primary" disabled={saving}>
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="row2">
                      <span className="meta">{meta}</span>
                      <button
                        type="button"
                        id={`edit-${app.id}`}
                        className="btn"
                        onClick={() => handleStartEdit(app)}
                        aria-label={`Edit resume version, ${app.company}`}
                      >
                        Edit
                      </button>
                      {status !== 'Cancelled' && (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => handleUndo(app)}
                          disabled={undoing}
                          aria-label={undoing ? undefined : `Undo: mark ${app.company} Cancelled`}
                        >
                          {undoing ? 'Undoing…' : 'Undo'}
                        </button>
                      )}
                    </div>
                  )}

                  {actionError?.id === app.id && (
                    <div className="err" role="alert">
                      <WarnIcon size={16} />
                      <span>{actionError.message}</span>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          <footer className="foot">
            <span>
              {applications.length === 1 ? '1 recent application' : `${applications.length} recent applications`}
            </span>
            <a className="link" href={sheetUrl(sheetRef)} target="_blank" rel="noopener noreferrer">
              Open sheet <span aria-hidden="true">↗</span>
              <NewTabHint />
            </a>
          </footer>
        </>
      )}
    </>
  )
}

export default App
