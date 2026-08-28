import { useEffect, useState } from 'react'
import { googleSheetsProvider } from '../providers/googleSheets'
import type { SheetRef } from '../providers/types'
import { SHEET_REF_KEY } from '../lib/storageKeys'
import { SHEET_TEMPLATE_COLUMNS } from '../lib/sheetTemplate'

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
      // Interactive — this is the one place in the whole extension allowed
      // to trigger Google's OAuth consent popup, since it's a direct result
      // of the user clicking a button here, not something firing mid-apply.
      await googleSheetsProvider.authenticate()
      const sheetRef = await googleSheetsProvider.createSheet([...SHEET_TEMPLATE_COLUMNS])
      await chrome.storage.local.set({ [SHEET_REF_KEY]: sheetRef })
      setState({ status: 'connected', sheetRef })
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 480, fontFamily: 'sans-serif' }}>
      <h1 style={{ fontSize: 20 }}>Job Application Tracker — Settings</h1>

      {state.status === 'loading' && <p style={{ color: '#666' }}>Loading…</p>}

      {state.status === 'disconnected' && (
        <>
          <p style={{ color: '#666' }}>
            No spreadsheet connected yet. Connecting creates a new Google Sheet automatically —
            no setup required.
          </p>
          <button onClick={handleConnect}>Connect Google Sheets</button>
        </>
      )}

      {state.status === 'connecting' && <p style={{ color: '#666' }}>Connecting…</p>}

      {state.status === 'connected' && (
        <>
          <p style={{ color: '#2a7' }}>Connected.</p>
          <a
            href={`https://docs.google.com/spreadsheets/d/${state.sheetRef.spreadsheetId}/edit`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open your Job Applications sheet
          </a>
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
