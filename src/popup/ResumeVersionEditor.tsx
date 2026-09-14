import { useState } from 'react'
import type { RecentApplication } from '../lib/recentApplications'
import type { ResumeVersionsByRoleType } from '../lib/resumeVersion'
import { WarnIcon } from '../ui/icons'

const ROLE_LABELS: Record<keyof ResumeVersionsByRoleType, string> = { SWE: 'software', DE: 'data' }

interface ResumeVersionEditorProps {
  entry: RecentApplication
  appliedOn: string
  lastUsed: ResumeVersionsByRoleType
  saving: boolean
  error: string | null
  onSave: (resumeVersion: string) => void
  onCancel: () => void
}

// "Change resume version" for one application. The same component is the
// popup's editor view (from the row's ⋯ menu) and the whole notification
// Edit window (popup/index.html?edit=<id>); App.tsx decides what Save and
// Cancel do in each. Enter saves, Esc cancels.
export function ResumeVersionEditor({ entry, appliedOn, lastUsed, saving, error, onSave, onCancel }: ResumeVersionEditorProps) {
  const [value, setValue] = useState(entry.resumeVersion)
  const suggestions = (Object.keys(ROLE_LABELS) as Array<keyof ResumeVersionsByRoleType>).flatMap((role) => {
    const version = lastUsed[role]
    return version ? [{ role, version }] : []
  })
  const place = [entry.title, entry.location].filter(Boolean).join(' · ')

  return (
    <form
      className="editor"
      aria-labelledby="editor-heading"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <h2 id="editor-heading">Change resume version</h2>
      <div className="app-card">
        <div className="app-co">{entry.company}</div>
        <div className="app-ti" title={place}>
          {place}
        </div>
        {appliedOn && <div className="app-meta">Applied {appliedOn}</div>}
      </div>
      <label htmlFor="resume-version">Resume version</label>
      <input
        id="resume-version"
        className="input"
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={saving}
        autoFocus
      />
      {suggestions.length > 0 && (
        <div className="sugg">
          <span>Last used:</span>
          {suggestions.map(({ role, version }) => (
            <button key={role} type="button" className="sg" onClick={() => setValue(version)} disabled={saving}>
              {version} · {ROLE_LABELS[role]}
            </button>
          ))}
        </div>
      )}
      <p className="hint">Saved to the Resume Version column in your sheet.</p>
      {error && (
        <div className="err" role="alert">
          <WarnIcon size={16} />
          <span>{error}</span>
        </div>
      )}
      <div className="editor-acts">
        <button type="button" className="btn lg" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn primary lg" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}
