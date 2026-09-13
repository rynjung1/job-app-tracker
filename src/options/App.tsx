import { useEffect, useState } from 'react'
import type { SheetRef } from '../providers/types'
import { SHEET_REF_KEY } from '../lib/storageKeys'
import type { BackgroundResponse } from '../background/messageRouter'

type ConnectionState =
  | { status: 'loading' }
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; sheetRef: SheetRef }
  | { status: 'error'; message: string }

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

  async function handleReconnect() {
    if (state.status !== 'connected') return
    const { sheetRef } = state
    setState({ status: 'connecting' })
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
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 480, fontFamily: 'sans-serif' }}>
      <h1 style={{ fontSize: 20 }}>Job Application Tracker — Settings</h1>
      <p style={{ color: '#666', fontSize: 13 }}>
        Currently supports: LinkedIn (Easy Apply) and Greenhouse-hosted job postings.
      </p>

      {state.status === 'loading' && <p style={{ color: '#666' }}>Loading…</p>}

      {state.status === 'disconnected' && (
        <>
          <p style={{ color: '#666' }}>
            No spreadsheet connected yet. Connecting creates a new file automatically — no setup
            required.
          </p>
          <button onClick={handleConnect}>Connect Google Sheets</button>
        </>
      )}

      {state.status === 'connecting' && <p style={{ color: '#666' }}>Connecting…</p>}

      {state.status === 'connected' && (
        <>
          <p style={{ color: '#2a7' }}>Connected (Google Sheets).</p>
          <a
            href={`https://docs.google.com/spreadsheets/d/${state.sheetRef.spreadsheetId}/edit`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open your Job Applications sheet
          </a>
          <div style={{ marginTop: 12 }}>
            <button onClick={handleReconnect}>Reconnect</button>
          </div>
        </>
      )}

      {state.status === 'error' && (
        <>
          <p style={{ color: '#c33' }}>Connection failed: {state.message}</p>
          <button onClick={handleConnect}>Try again</button>
        </>
      )}
    </div>
  )
}

export default App
