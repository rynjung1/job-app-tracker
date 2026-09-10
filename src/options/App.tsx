import { useEffect, useState } from 'react'
import type { SheetRef } from '../providers/types'
import { SHEET_REF_KEY } from '../lib/storageKeys'
import { SHEET_TEMPLATE_COLUMNS } from '../lib/sheetTemplate'
import { getProvider, getActiveProviderId, setActiveProviderId } from '../providers/activeProvider'
import type { ProviderId } from '../providers/activeProvider'

type ConnectionState =
  | { status: 'loading' }
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; sheetRef: SheetRef; providerId: ProviderId }
  | { status: 'error'; message: string; providerId: ProviderId }

function App() {
  const [state, setState] = useState<ConnectionState>({ status: 'loading' })

  useEffect(() => {
    Promise.all([chrome.storage.local.get(SHEET_REF_KEY), getActiveProviderId()]).then(([stored, providerId]) => {
      const sheetRef = stored[SHEET_REF_KEY] as SheetRef | undefined
      setState(sheetRef ? { status: 'connected', sheetRef, providerId } : { status: 'disconnected' })
    })
  }, [])

  async function handleConnect(providerId: ProviderId) {
    setState({ status: 'connecting' })
    try {
      const provider = getProvider(providerId)
      // Interactive — this is the one place in the whole extension allowed
      // to trigger a provider's OAuth consent popup, since it's a direct
      // result of the user clicking a button here, not something firing
      // mid-apply.
      await provider.authenticate()
      const sheetRef = await provider.createSheet([...SHEET_TEMPLATE_COLUMNS])
      await chrome.storage.local.set({ [SHEET_REF_KEY]: sheetRef })
      await setActiveProviderId(providerId)
      setState({ status: 'connected', sheetRef, providerId })
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err), providerId })
    }
  }

  async function handleReconnect() {
    if (state.status !== 'connected') return
    const { providerId, sheetRef } = state
    setState({ status: 'connecting' })
    try {
      const provider = getProvider(providerId)
      await provider.authenticate()
      // Keep the existing sheetRef — only the OAuth grant needed
      // refreshing, not the sheet itself. Calling createSheet() here
      // would orphan the current sheet and silently swap in a new one.
      setState({ status: 'connected', sheetRef, providerId })
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err), providerId })
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
          <button onClick={() => handleConnect('google')}>Connect Google Sheets</button>
          <button onClick={() => handleConnect('excel')} style={{ marginLeft: 8 }}>
            Connect Excel / OneDrive
          </button>
        </>
      )}

      {state.status === 'connecting' && <p style={{ color: '#666' }}>Connecting…</p>}

      {state.status === 'connected' && (
        <>
          <p style={{ color: '#2a7' }}>
            Connected ({state.providerId === 'excel' ? 'Excel / OneDrive' : 'Google Sheets'}).
          </p>
          <a
            href={
              state.sheetRef.webUrl ??
              `https://docs.google.com/spreadsheets/d/${state.sheetRef.spreadsheetId}/edit`
            }
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
          <button onClick={() => handleConnect(state.providerId)}>Try again</button>
        </>
      )}
    </div>
  )
}

export default App
