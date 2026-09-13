import { useEffect, useState } from 'react'
import type { SheetRef } from '../providers/types'
import { SHEET_REF_KEY } from '../lib/storageKeys'
import type { BackgroundResponse } from '../background/messageRouter'
import { CheckIcon, TickIcon, WarnIcon } from '../ui/icons'

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

function App() {
  const [state, setState] = useState<ConnectionState>({ status: 'loading' })

  useEffect(() => {
    chrome.storage.local.get(SHEET_REF_KEY).then((stored) => {
      const sheetRef = stored[SHEET_REF_KEY] as SheetRef | undefined
      setState(sheetRef ? { status: 'connected', sheetRef } : { status: 'disconnected' })
    })
  }, [])

  async function handleConnect() {
    setState({ status: 'connecting' })
    try {
      // authenticate()/createSheet() run in the background worker — this
      // page only asks for it and renders the result. See CLAUDE.md's Trust
      // boundary section: options/App.tsx never calls SpreadsheetProvider
      // methods directly.
      const response = (await chrome.runtime.sendMessage({
        type: 'CONNECT_PROVIDER',
      })) as BackgroundResponse<SheetRef>
      if (!response.ok) throw new Error(response.error)
      setState({ status: 'connected', sheetRef: response.data })
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleReconnect(sheetRef: SheetRef) {
    setState({ status: 'connecting', sheetRef })
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'RECONNECT_PROVIDER',
      })) as BackgroundResponse<undefined>
      if (!response.ok) throw new Error(response.error)
      // Keep the existing sheetRef — only the OAuth grant needed
      // refreshing, not the sheet itself. background's handler
      // deliberately never calls createSheet() for this message, for the
      // same reason: it would orphan the current sheet and silently swap
      // in a new one.
      setState({ status: 'connected', sheetRef })
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err), sheetRef })
    }
  }

  const busy = state.status === 'loading' || state.status === 'connecting'

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
        <div className="card" aria-busy={busy || undefined}>
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

          {state.status === 'connected' && (
            <>
              <div className="status">
                <span className="pill ok" aria-hidden="true" />
                Connected to Google Sheets
              </div>
              <p className="muted">
                Applications are logged to your Job Applications sheet. If logging stops working, Reconnect signs you in
                again and keeps the same sheet.
              </p>
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
                <button type="button" className="btn lg" onClick={() => handleReconnect(state.sheetRef)}>
                  Reconnect
                </button>
              </div>
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
