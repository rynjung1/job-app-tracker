import { useEffect, useState } from 'react'
import { googleSheetsProvider } from '../providers/googleSheets'
import type { SheetRef } from '../providers/types'
import { getRecentApplications, updateRecentApplication } from '../lib/recentApplications'
import type { RecentApplication } from '../lib/recentApplications'
import { setLastResumeVersion } from '../lib/resumeVersion'
import { SHEET_REF_KEY } from '../lib/storageKeys'

// If opened via the notification's Edit button (background/index.ts), this
// is set to that entry's id and this window was created just for editing
// (chrome.windows.create, not the normal toolbar-click popup) — closes
// itself on save. Opened normally, there's no edit param and this is just
// the recent-applications list.
const editId = new URLSearchParams(window.location.search).get('edit')

function App() {
  const [applications, setApplications] = useState<RecentApplication[] | null>(null)
  const [sheetRef, setSheetRef] = useState<SheetRef | undefined>()
  const [resumeInput, setResumeInput] = useState('')
  const [saving, setSaving] = useState(false)

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

  const editingEntry = applications?.find((a) => a.id === editId)

  async function handleSaveResumeVersion() {
    if (!editingEntry || !sheetRef) return
    setSaving(true)
    try {
      await googleSheetsProvider.updateCell(
        sheetRef,
        editingEntry.rowNumber,
        'Resume Version',
        resumeInput,
      )
      await setLastResumeVersion(editingEntry.title, resumeInput)
      await updateRecentApplication(editingEntry.id, { resumeVersion: resumeInput })
      window.close()
    } catch (err) {
      setSaving(false)
      console.error('[job-app-tracker] failed to save resume version:', err)
    }
  }

  return (
    <div style={{ padding: 16, minWidth: 300 }}>
      <h1 style={{ fontSize: 16, margin: 0 }}>Job Application Tracker</h1>

      {editId && editingEntry && (
        <div style={{ marginTop: 12, padding: 10, background: '#f0f4ff', borderRadius: 6 }}>
          <p style={{ fontSize: 13, margin: '0 0 6px' }}>
            {editingEntry.company} — {editingEntry.title}
          </p>
          <input
            type="text"
            value={resumeInput}
            onChange={(e) => setResumeInput(e.target.value)}
            placeholder="Resume version"
            style={{ width: '100%', boxSizing: 'border-box', padding: 4 }}
          />
          <button onClick={handleSaveResumeVersion} disabled={saving} style={{ marginTop: 6 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      <div style={{ marginTop: 12, maxHeight: 320, overflowY: 'auto' }}>
        {applications === null && <p style={{ fontSize: 13, color: '#666' }}>Loading…</p>}
        {applications?.length === 0 && (
          <p style={{ fontSize: 13, color: '#666' }}>No recent applications yet.</p>
        )}
        {applications?.map((app) => (
          <div
            key={app.id}
            style={{ padding: '6px 0', borderBottom: '1px solid #eee', fontSize: 13 }}
          >
            <div>
              {app.company} — {app.title}
            </div>
            <div style={{ color: '#666', fontSize: 12 }}>
              {app.status}
              {app.resumeVersion ? ` · ${app.resumeVersion}` : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
