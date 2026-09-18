import { useEffect, useState } from 'react'
import type { SheetRef } from '../providers/types'
import { PREVIOUS_SHEET_REF_KEY, SHEET_REF_KEY } from '../lib/storageKeys'
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

// The spreadsheet's name for the card. Refs stored before SheetRef carried a
// title, and a title read that failed, fall back rather than showing nothing.
function sheetTitleOf(sheetRef: SheetRef, fallback = 'your sheet'): string {
  const title = sheetRef.title?.trim()
  return title ? title : fallback
}

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
  // "Start a new sheet" (2026-09-17): the inline confirm step for a healthy
  // sheet, and the sheet left behind by the last swap, so the card can offer
  // a way back to it.
  const [confirming, setConfirming] = useState(false)
  const [previousRef, setPreviousRef] = useState<SheetRef | undefined>(undefined)
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState('')

  // A request can fail after the background has already done the work — a
  // killed worker answers with a rejected sendMessage, and a Connect that
  // created a sheet and then died would leave "Try again" creating a second
  // one (audit finding, 2026-09-17; the likely cause of the two sheets of
  // 2026-09-14). So every failure re-reads storage first: if a sheet is
  // connected now, the card shows it and the error is only a notice.
  async function connectedAfterFailure(before: SheetRef | undefined): Promise<SheetRef | undefined> {
    try {
      const stored = await chrome.storage.local.get(SHEET_REF_KEY)
      const sheetRef = stored[SHEET_REF_KEY] as SheetRef | undefined
      return sheetRef && sheetRef.spreadsheetId !== before?.spreadsheetId ? sheetRef : undefined
    } catch {
      return undefined
    }
  }

  async function loadPreviousRef() {
    const stored = await chrome.storage.local.get(PREVIOUS_SHEET_REF_KEY)
    setPreviousRef(stored[PREVIOUS_SHEET_REF_KEY] as SheetRef | undefined)
  }

  // Replaces the connected sheet: with replaceHealthy, the deliberate "Start
  // a new sheet" behind its confirm; without it, the recovery path for a
  // sheet in Drive's trash or deleted, which the background refuses while
  // the sheet is healthy (CREATE_NEW_SHEET).
  async function handleCreateNewSheet(replaceHealthy = false) {
    setNotice('')
    setCreateError('')
    setSwitchError('')
    setCreating(true)
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'CREATE_NEW_SHEET',
        payload: { replaceHealthy },
      })) as BackgroundResponse<ConnectResult>
      if (!response.ok) throw new Error(response.error)
      setState({ status: 'connected', sheetRef: response.data.sheetRef })
      setConfirming(false)
      await loadPreviousRef()
      const created = replaceHealthy ? 'Started a new sheet' : 'Created a new sheet'
      setNotice(`${created}: ${sheetTitleOf(response.data.sheetRef)}. ${savedNotice(response.data)}`.trim())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const connected = await connectedAfterFailure(state.status === 'connected' ? state.sheetRef : undefined)
      if (connected) {
        // The swap happened; only the answer was lost. Close the confirm and
        // show the sheet that's connected now.
        setState({ status: 'connected', sheetRef: connected })
        setConfirming(false)
        setNotice(`Connected to ${sheetTitleOf(connected)}. The last step didn't finish: ${message}`)
        await loadPreviousRef()
      } else {
        setCreateError(message)
      }
    } finally {
      setCreating(false)
    }
  }

  // Back to the sheet the last swap left behind. The background checks that
  // sheet is reachable and not in the trash first, and refuses with
  // PREVIOUS_UNAVAILABLE otherwise — the reason is shown as it comes back.
  async function handleSwitchToPrevious() {
    setNotice('')
    setCreateError('')
    setSwitchError('')
    setSwitching(true)
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'SWITCH_TO_PREVIOUS_SHEET',
      })) as BackgroundResponse<ConnectResult>
      if (!response.ok) throw new Error(response.error)
      setState({ status: 'connected', sheetRef: response.data.sheetRef })
      setConfirming(false)
      await loadPreviousRef()
      setNotice(`Switched back to ${sheetTitleOf(response.data.sheetRef)}. ${savedNotice(response.data)}`.trim())
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : String(err))
    } finally {
      setSwitching(false)
    }
  }

  async function handleConnect() {
    setNotice('')
    const before = state.status === 'connected' ? state.sheetRef : undefined
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
      await loadPreviousRef()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const connected = await connectedAfterFailure(before)
      if (connected) {
        // The sheet was created before the failure: show it rather than
        // offering a "Try again" that would create a second one.
        setState({ status: 'connected', sheetRef: connected })
        setNotice(`Connected to ${sheetTitleOf(connected)}. The last step didn't finish: ${message}`)
        await loadPreviousRef()
        return
      }
      setState({ status: 'error', message })
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
    chrome.storage.local.get([SHEET_REF_KEY, PREVIOUS_SHEET_REF_KEY]).then((stored) => {
      const sheetRef = stored[SHEET_REF_KEY] as SheetRef | undefined
      setPreviousRef(stored[PREVIOUS_SHEET_REF_KEY] as SheetRef | undefined)
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

  // Lazy title fill (2026-09-17): a sheet connected before SheetRef carried a
  // title, or one the user renamed in Drive. One spreadsheets.get, only when
  // the stored ref has no title, and only while the sheet looks healthy — a
  // failure just leaves the "your sheet" fallback, so nothing is shown twice.
  const connectedId = state.status === 'connected' ? state.sheetRef.spreadsheetId : undefined
  const titleMissing = state.status === 'connected' && !state.sheetRef.title
  useEffect(() => {
    if (!connectedId || !titleMissing) return
    let cancelled = false
    chrome.runtime
      .sendMessage({ type: 'REFRESH_SHEET_TITLE' })
      .then((response: BackgroundResponse<SheetRef>) => {
        if (cancelled || !response?.ok || !response.data.title) return
        setState((current) =>
          current.status === 'connected' && current.sheetRef.spreadsheetId === response.data.spreadsheetId
            ? { status: 'connected', sheetRef: response.data }
            : current,
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [connectedId, titleMissing])

  const busy = state.status === 'loading' || state.status === 'connecting'
  const needsReconnect = state.status === 'connected' && authStatus !== undefined
  // Sign-in comes first: the sheet can't be checked or replaced without it.
  const sheetProblem = state.status === 'connected' && !needsReconnect ? sheetStatus : undefined

  // The way back, offered for as long as a previous sheet is remembered: a
  // swap made by mistake may only be noticed days later. The background
  // checks that sheet first and refuses if it's been trashed or deleted
  // since, and its reason is shown as it comes back.
  const switchBack = previousRef ? (
    <>
      {switchError && (
        <div className="alert" role="alert">
          <WarnIcon size={16} />
          <span>{switchError}</span>
        </div>
      )}
      <p className="quiet">
        {switching ? (
          <button type="button" className="link-btn" disabled>
            Switching back…
          </button>
        ) : (
          <button type="button" className="link-btn" onClick={handleSwitchToPrevious}>
            Switch back to the previous sheet
          </button>
        )}
        <span className="note">{sheetTitleOf(previousRef, 'The sheet')} is the one you were using before.</span>
      </p>
    </>
  ) : null

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
        <div className={needsReconnect || sheetProblem ? 'card warn' : 'card'} aria-busy={busy || creating || switching || undefined}>
          {state.status === 'loading' && <p className="muted">Checking your connection…</p>}

          {state.status === 'disconnected' && (
            <>
              <div className="status">
                <span className="pill" aria-hidden="true" />
                Not connected
              </div>
              {/* Before Connect, in the product itself (2026-09-17, audit):
                  Google's Limited Use guidance wants what's read disclosed
                  where the user grants access, not only in the policy. */}
              <p className="muted">
                When you apply on a supported site, the extension reads that job's title, company, location and link
                from the page you apply on, and writes them to your sheet. Nothing else is read, and nothing is sent
                anywhere but your Google Sheet.
              </p>
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
                  <button type="button" className="btn primary lg" onClick={() => handleCreateNewSheet()}>
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
              {/* Also offered here: if the sheet a swap created is the one
                  that's gone, switching back is the recovery that keeps the
                  old rows, and creating another would forget this way back. */}
              {switchBack}
            </>
          )}

          {state.status === 'connected' && !needsReconnect && !sheetProblem && (
            <>
              <div className="status">
                <span className="pill ok" aria-hidden="true" />
                Connected to {sheetTitleOf(state.sheetRef)}
              </div>
              <p className="muted">Applications are logged to this sheet in your Google Drive.</p>
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

              {/* Start a new sheet (2026-09-17): below a hairline, away from
                  Reconnect — Reconnect fixes access to this sheet, this one
                  deliberately leaves it behind. A quiet link, because it's
                  rare and consequential, and it never fires on one click:
                  the card expands into the confirm below. */}
              <hr className="hair" />
              {createError && (
                <div className="alert" role="alert">
                  <WarnIcon size={16} />
                  <span>Couldn't start a new sheet: {createError}</span>
                </div>
              )}
              {confirming ? (
                <div className="confirm">
                  <p className="confirm-q">Start a new sheet?</p>
                  <ul className="confirm-list">
                    <li>Your current sheet stays in Google Drive, untouched — nothing is deleted or moved.</li>
                    <li>New applications, and anything still waiting to be saved, go to the new sheet.</li>
                    <li>
                      The popup's recent list is cleared, because those rows live in the old sheet. You can reopen it
                      from Drive at any time.
                    </li>
                  </ul>
                  <div className="acts">
                    {creating ? (
                      <button type="button" className="btn primary lg" disabled>
                        Starting…
                      </button>
                    ) : (
                      <button type="button" className="btn primary lg" onClick={() => handleCreateNewSheet(true)}>
                        Start a new sheet
                      </button>
                    )}
                    <button type="button" className="btn lg" onClick={() => setConfirming(false)} disabled={creating}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="quiet">
                  <button type="button" className="link-btn" onClick={() => setConfirming(true)}>
                    Start a new sheet
                  </button>
                  <span className="note">Keeps this one in Drive and logs future applications to a fresh sheet.</span>
                </p>
              )}

              {/* The way back, offered for as long as a previous sheet is
                  remembered: a swap made by mistake may only be noticed days
                  later. The background checks that sheet first and refuses
                  if it's been trashed or deleted since. */}
              {switchBack}
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
          <li>
            <TickIcon size={16} className="tick" />
            <div>
              <b>Workday</b> career sites (myworkdayjobs.com, myworkdaysite.com)
              <span className="note">Logged at the final Submit; Company is the site's name from its address</span>
            </div>
          </li>
        </ul>
        {/* The same disclosure once connected, where the Connect card's copy
            is no longer on screen. */}
        <p className="quiet sites-note">
          Only these sites, and only the job's title, company, location and link from the page you apply on.
        </p>
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
