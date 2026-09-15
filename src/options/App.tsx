import { useEffect, useState } from 'react'
import type { SheetRef } from '../providers/types'
import { SHEET_REF_KEY } from '../lib/storageKeys'
import { applicationCount } from '../lib/authStatus'
import { sheetProblemMessage, sheetProblemTitle } from '../lib/sheetStatus'
import type { BackgroundResponse, ConnectResult, ReconnectResult } from '../background/messageRouter'
import { CheckIcon, TickIcon, WarnIcon } from '../ui/icons'
import { useSyncStatus } from '../ui/useSyncStatus'

// connecting/error carry the sheetRef when the action was a Reconnect, so
// the error's "Try again" retries Reconnect. Before this, it always ran
// Connect, which creates a new sheet and replaces the connected one.
type ConnectionState =
  | { status: 'loading' }
  | { status: 'disconnected' }
  | { status: 'connecting'; sheetRef?: SheetRef }
  | { status: 'connected'; sheetRef: SheetRef }
  | { status: 'error'; message: string; sheetRef?: SheetRef }

const VERSION = chrome.runtime.getManifest().version
const PRIVACY_POLICY_URL = 'https://rynjung1.github.io/job-app-tracker/privacy.html'

// Opened at ?reconnect=1 (the popup's "Sign-in needed" banner or the
// notification's Reconnect): start Google's sign-in as soon as the
// connected sheet is known. 'started' also keeps a second run of the load
// effect (React StrictMode in dev) from overwriting the Reconnecting state.
let autoReconnect: 'pending' | 'started' | 'none' =
  new URLSearchParams(window.location.search).get('reconnect') === '1' ? 'pending' : 'none'

function savedNotice({ saved, waiting }: ReconnectResult): string {
  const parts: string[] = []
  if (saved > 0) parts.push(`Saved ${saved} waiting application${saved === 1 ? '' : 's'} to your sheet.`)
  if (waiting > 0) {
    parts.push(`${applicationCount(waiting)} still waiting; retried automatically every 5 minutes.`)
  }
  return parts.join(' ')
}

function App() {
  const [state, setState] = useState<ConnectionState>({ status: 'loading' })
  // After a Reconnect: what its immediate drain saved (role="status").
  const [notice, setNotice] = useState('')
  const { authStatus, sheetStatus, queued } = useSyncStatus()
  // "Create a new sheet" (2026-09-14): running, and its error if it failed.
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  // Replaces the connected sheet when it's in Drive's trash or deleted; the
  // background refuses while it's healthy (CREATE_NEW_SHEET).
  async function handleCreateNewSheet() {
    setNotice('')
    setCreateError('')
    setCreating(true)
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'CREATE_NEW_SHEET',
      })) as BackgroundResponse<ConnectResult>
      if (!response.ok) throw new Error(response.error)
      setState({ status: 'connected', sheetRef: response.data.sheetRef })
      setNotice(`Created a new sheet. ${savedNotice(response.data)}`.trim())
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  async function handleConnect() {
    setNotice('')
    setState({ status: 'connecting' })
    try {
      // authenticate()/createSheet() run in the background worker — this
      // page only asks for it and renders the result. See CLAUDE.md's Trust
      // boundary section: options/App.tsx never calls SpreadsheetProvider
      // methods directly.
      const response = (await chrome.runtime.sendMessage({
        type: 'CONNECT_PROVIDER',
      })) as BackgroundResponse<ConnectResult>
      if (!response.ok) throw new Error(response.error)
      setState({ status: 'connected', sheetRef: response.data.sheetRef })
      // Applications made before connecting are saved right away.
      setNotice(savedNotice(response.data))
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleReconnect(sheetRef: SheetRef) {
    setNotice('')
    setState({ status: 'connecting', sheetRef })
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'RECONNECT_PROVIDER',
      })) as BackgroundResponse<ReconnectResult>
      if (!response.ok) throw new Error(response.error)
      // Keep the existing sheetRef — only the OAuth grant needed
      // refreshing, not the sheet itself. background's handler
      // deliberately never calls createSheet() for this message, for the
      // same reason: it would orphan the current sheet and silently swap
      // in a new one.
      setState({ status: 'connected', sheetRef })
      setNotice(savedNotice(response.data))
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err), sheetRef })
    }
  }

  useEffect(() => {
    chrome.storage.local.get(SHEET_REF_KEY).then((stored) => {
      const sheetRef = stored[SHEET_REF_KEY] as SheetRef | undefined
      if (autoReconnect === 'started') return
      if (sheetRef && autoReconnect === 'pending') {
        autoReconnect = 'started'
        // Drop ?reconnect=1 so reloading the window doesn't sign in again.
        window.history.replaceState(null, '', window.location.pathname)
        handleReconnect(sheetRef)
        return
      }
      setState(sheetRef ? { status: 'connected', sheetRef } : { status: 'disconnected' })
    })
    // Runs once on load.
  }, [])

  const busy = state.status === 'loading' || state.status === 'connecting'
  const needsReconnect = state.status === 'connected' && authStatus !== undefined
  // Sign-in comes first: the sheet can't be checked or replaced without it.
  const sheetProblem = state.status === 'connected' && !needsReconnect ? sheetStatus : undefined

  return (
    <div className="page">
      <header className="hdr">
        <span className="mark lg" aria-hidden="true">
          <CheckIcon size={17} />
        </span>
        <div>
          <h1>Settings</h1>
          <p className="sub">Job Application Tracker · v{VERSION}</p>
        </div>
      </header>

      <section className="sec" aria-labelledby="spreadsheet-heading">
        <h2 id="spreadsheet-heading">Spreadsheet</h2>
        <div className={needsReconnect || sheetProblem ? 'card warn' : 'card'} aria-busy={busy || creating || undefined}>
          {state.status === 'loading' && <p className="muted">Checking your connection…</p>}

          {state.status === 'disconnected' && (
            <>
              <div className="status">
                <span className="pill" aria-hidden="true" />
                Not connected
              </div>
              <p className="muted">
                Connecting creates a new, formatted sheet in your Google Drive. The extension can only access files it
                creates.
              </p>
              <div className="acts">
                <button type="button" className="btn primary lg" onClick={handleConnect}>
                  Connect Google Sheets
                </button>
              </div>
            </>
          )}

          {state.status === 'connecting' && (
            <>
              <div className="status">
                <span className="pill" aria-hidden="true" />
                {state.sheetRef ? 'Reconnecting…' : 'Connecting…'}
              </div>
              <p className="muted">Finish signing in with Google in the window that opened.</p>
              <div className="acts">
                <button type="button" className="btn primary lg" disabled>
                  {state.sheetRef ? 'Reconnecting…' : 'Connecting…'}
                </button>
              </div>
            </>
          )}

          {state.status === 'connected' && needsReconnect && (
            <>
              <div className="status">
                <span className="pill warn" aria-hidden="true" />
                Google sign-in needed
              </div>
              <p className="muted">
                Google access to your sheet was lost, so logging is paused.
                {queued > 0 && ` ${applicationCount(queued)} ${queued === 1 ? 'is' : 'are'} waiting.`} Reconnect signs
                you in again and keeps the same sheet.
              </p>
              <div className="acts">
                <button type="button" className="btn primary lg" onClick={() => handleReconnect(state.sheetRef)}>
                  Reconnect
                </button>
                <a
                  className="btn lg"
                  href={`https://docs.google.com/spreadsheets/d/${state.sheetRef.spreadsheetId}/edit`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open sheet <span aria-hidden="true">↗</span>
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </div>
            </>
          )}

          {state.status === 'connected' && sheetProblem && (
            <>
              <div className="status">
                <span className="pill warn" aria-hidden="true" />
                {sheetProblemTitle(sheetProblem.state)}
              </div>
              <p className="muted">{sheetProblemMessage(sheetProblem.state, queued)}</p>
              {sheetProblem.state === 'trashed' && (
                <p className="muted">A restored sheet is noticed within 5 minutes, or when you open the extension's popup.</p>
              )}
              {createError && (
                <div className="alert" role="alert">
                  <WarnIcon size={16} />
                  <span>Couldn't create a new sheet: {createError}</span>
                </div>
              )}
              <div className="acts">
                {creating ? (
                  <button type="button" className="btn primary lg" disabled>
                    Creating…
                  </button>
                ) : (
                  <button type="button" className="btn primary lg" onClick={handleCreateNewSheet}>
                    Create a new sheet
                  </button>
                )}
                {sheetProblem.state === 'trashed' && (
                  <a className="btn lg" href="https://drive.google.com/drive/trash" target="_blank" rel="noopener noreferrer">
                    Open Drive's trash <span aria-hidden="true">↗</span>
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )}
              </div>
            </>
          )}

          {state.status === 'connected' && !needsReconnect && !sheetProblem && (
            <>
              <div className="status">
                <span className="pill ok" aria-hidden="true" />
                Connected to Google Sheets
              </div>
              <p className="muted">Applications are logged to your Job Applications sheet.</p>
              {queued > 0 && !notice && (
                <p className="muted">
                  {applicationCount(queued)} waiting to be saved; retried automatically every 5 minutes.
                </p>
              )}
              <div className="acts">
                <a
                  className="btn primary lg"
                  href={`https://docs.google.com/spreadsheets/d/${state.sheetRef.spreadsheetId}/edit`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open sheet <span aria-hidden="true">↗</span>
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </div>
              {/* Healthy: Reconnect is a quiet link (still a button). It's the
                  primary action again in the sign-in-needed card above. */}
              <p className="quiet">
                Having trouble?{' '}
                <button type="button" className="link-btn" onClick={() => handleReconnect(state.sheetRef)}>
                  Reconnect
                </button>
              </p>
            </>
          )}

          {state.status === 'error' && (
            <>
              <div className="alert" role="alert">
                <WarnIcon size={16} />
                <span>
                  {state.sheetRef ? "Couldn't reconnect" : "Couldn't connect"}: {state.message}
                </span>
              </div>
              <div className="acts">
                <button
                  type="button"
                  className="btn primary lg"
                  onClick={() => (state.sheetRef ? handleReconnect(state.sheetRef) : handleConnect())}
                >
                  Try again
                </button>
              </div>
            </>
          )}

          <p className="notice" role="status">
            {state.status === 'connected' ? notice : ''}
          </p>
        </div>
      </section>

      <section className="sec" aria-labelledby="sites-heading">
        <h2 id="sites-heading">Supported sites</h2>
        <ul className="sites">
          <li>
            <TickIcon size={16} className="tick" />
            <div>
              <b>LinkedIn</b> Easy Apply
              <span className="note">Fully supported with LinkedIn set to English</span>
            </div>
          </li>
          <li>
            <TickIcon size={16} className="tick" />
            <div>
              <b>Greenhouse</b> job-boards.greenhouse.io postings
              <span className="note">Logged once Greenhouse confirms the submission</span>
            </div>
          </li>
        </ul>
      </section>

      <footer className="foot">
        <a className="link" href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
          Privacy policy<span className="sr-only"> (opens in a new tab)</span>
        </a>
        <span>Data goes only to your Google Sheet</span>
      </footer>
    </div>
  )
}

export default App
