import { useEffect, useState } from 'react'
import { getActiveProvider } from '../providers/activeProvider'
import type { SheetRef } from '../providers/types'
import { cancelApplication, getRecentApplications, updateRecentApplication } from '../lib/recentApplications'
import type { RecentApplication } from '../lib/recentApplications'
import { setLastResumeVersion } from '../lib/resumeVersion'
import { SHEET_REF_KEY } from '../lib/storageKeys'

// If opened via the notification's Edit button (background/index.ts), this
// is set to that entry's id and this window was created just for editing
// (chrome.windows.create, not the normal toolbar-click popup). Opened
// normally, there's no edit param — editingId starts null and the list is
// just the list, same as before this feature existed.
const editId = new URLSearchParams(window.location.search).get('edit')

interface ActionError {
  id: string
  message: string
}

const STALE_ROW_MESSAGE_EDIT =
  "This row may have changed since it was logged — refusing to update it automatically. You can still edit it directly in your spreadsheet."
const STALE_ROW_MESSAGE_UNDO =
  "This row may have changed since it was logged — refusing to update it automatically. You can still mark it Cancelled directly in your spreadsheet."
const GENERIC_ERROR_MESSAGE = 'Something went wrong — please try again.'

function App() {
  const [applications, setApplications] = useState<RecentApplication[] | null>(null)
  const [sheetRef, setSheetRef] = useState<SheetRef | undefined>()
  const [editingId, setEditingId] = useState<string | null>(editId)
  const [resumeInput, setResumeInput] = useState('')
  const [savingEditId, setSavingEditId] = useState<string | null>(null)
  const [undoingId, setUndoingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<ActionError | null>(null)

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
    })
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

  async function handleSaveResumeVersion(entry: RecentApplication) {
    if (!sheetRef) return
    setSavingEditId(entry.id)
    setActionError(null)
    try {
      const provider = await getActiveProvider()
      // The one case that skips the identity check and closes the window
      // on save: this window was opened specifically to edit this exact
      // entry via the notification's Edit button, and the user hasn't
      // since switched to editing a different row. Every other save —
      // including a different row edited from inside this same standalone
      // window — gets the real check, since a stale rowNumber is exactly
      // as possible there as from the normal popup.
      const isOriginalNotificationEdit = editId !== null && editingId === editId && entry.id === editId
      if (!isOriginalNotificationEdit) {
        const row = await provider.readRow(sheetRef, entry.rowNumber)
        if (row.Company !== entry.company || row.Title !== entry.title) {
          setActionError({ id: entry.id, message: STALE_ROW_MESSAGE_EDIT })
          return
        }
      }
      await provider.updateCell(sheetRef, entry.rowNumber, 'Resume Version', resumeInput)
      await setLastResumeVersion(entry.title, resumeInput)
      const updated = await updateRecentApplication(entry.id, { resumeVersion: resumeInput })
      if (updated) patchApplication(entry.id, updated)
      setEditingId(null)
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
      const provider = await getActiveProvider()
      const row = await provider.readRow(sheetRef, entry.rowNumber)
      if (row.Company !== entry.company || row.Title !== entry.title) {
        setActionError({ id: entry.id, message: STALE_ROW_MESSAGE_UNDO })
        return
      }
      await cancelApplication(provider, sheetRef, entry)
      patchApplication(entry.id, { status: 'Cancelled' })
    } catch (err) {
      console.error('[job-app-tracker] undo failed:', err)
      setActionError({ id: entry.id, message: GENERIC_ERROR_MESSAGE })
    } finally {
      setUndoingId(null)
    }
  }

  return (
    <div style={{ padding: 16, minWidth: 300 }}>
      <h1 style={{ fontSize: 16, margin: 0 }}>Job Application Tracker</h1>

      <div style={{ marginTop: 12, maxHeight: 320, overflowY: 'auto' }}>
        {applications === null && <p style={{ fontSize: 13, color: '#666' }}>Loading…</p>}
        {applications?.length === 0 && (
          <p style={{ fontSize: 13, color: '#666' }}>No recent applications yet.</p>
        )}
        {applications?.map((app) => (
          <div key={app.id} style={{ padding: '6px 0', borderBottom: '1px solid #eee', fontSize: 13 }}>
            <div>
              {app.company} — {app.title}
            </div>
            <div style={{ color: '#666', fontSize: 12 }}>
              {app.status}
              {app.resumeVersion ? ` · ${app.resumeVersion}` : ''}
            </div>

            <div style={{ marginTop: 4 }}>
              <button onClick={() => handleStartEdit(app)} disabled={savingEditId === app.id}>
                Edit
              </button>
              {app.status !== 'Cancelled' && (
                <button
                  onClick={() => handleUndo(app)}
                  disabled={undoingId === app.id}
                  style={{ marginLeft: 6 }}
                >
                  {undoingId === app.id ? 'Undoing…' : 'Undo'}
                </button>
              )}
            </div>

            {editingId === app.id && (
              <div style={{ marginTop: 6, padding: 8, background: '#f0f4ff', borderRadius: 6 }}>
                <input
                  type="text"
                  value={resumeInput}
                  onChange={(e) => setResumeInput(e.target.value)}
                  placeholder="Resume version"
                  style={{ width: '100%', boxSizing: 'border-box', padding: 4 }}
                />
                <button
                  onClick={() => handleSaveResumeVersion(app)}
                  disabled={savingEditId === app.id}
                  style={{ marginTop: 6 }}
                >
                  {savingEditId === app.id ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}

            {actionError?.id === app.id && (
              <p style={{ color: '#c33', fontSize: 12, marginTop: 6 }}>{actionError.message}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
