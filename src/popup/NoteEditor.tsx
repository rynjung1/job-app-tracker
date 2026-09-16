import { useEffect, useRef, useState } from 'react'
import type { RecentApplication } from '../lib/recentApplications'
import { MAX_NOTE_LENGTH } from '../lib/notes'
import type { BackgroundResponse } from '../background/messageRouter'
import { WarnIcon } from '../ui/icons'
import { errorMessage, GENERIC_ERROR, STALE_ROW_NOTE } from './messages'

interface NoteEditorProps {
  entry: RecentApplication
  appliedOn: string
  onClose: () => void
}

// "Add note" from the row's ⋯ menu (2026-09-15, decided by Ryan). It opens
// with the row's current Notes cell, read by GET_NOTE through the same
// identity check as a status change, and saves the edited text back as an
// edit of that cell (SAVE_NOTE), never an append. If the cell changed in the
// sheet since the editor opened, nothing is saved and it says so
// (NOTE_CHANGED). Enter adds a line, Ctrl/Cmd+Enter saves, Esc cancels. Like
// the resume editor, nothing is `disabled` while it may have focus: while
// loading or saving the textarea is read-only and the buttons ignore clicks.
export function NoteEditor({ entry, appliedOn, onClose }: NoteEditorProps) {
  // The Notes cell as GET_NOTE read it: SAVE_NOTE's `expected`. null until read.
  const [opened, setOpened] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const loading = opened === null && loadError === null
  const blocked = opened === null || saving
  const place = [entry.title, entry.location].filter(Boolean).join(' · ')

  useEffect(() => {
    let current = true
    ;(chrome.runtime.sendMessage({ type: 'GET_NOTE', payload: { entryId: entry.id } }) as Promise<BackgroundResponse<{ note: string }>>)
      .then((response) => {
        if (!current) return
        if (!response.ok) {
          setLoadError(errorMessage(response.code, STALE_ROW_NOTE))
          return
        }
        setOpened(response.data.note)
        setValue(response.data.note)
      })
      .catch((err) => {
        console.error('[job-app-tracker] reading the note failed:', err)
        if (current) setLoadError(GENERIC_ERROR)
      })
    return () => {
      current = false
    }
  }, [entry.id])

  // Once the note is in, the caret goes to its end.
  useEffect(() => {
    if (opened !== null) area.current?.setSelectionRange(opened.length, opened.length)
  }, [opened])

  async function save() {
    if (blocked) return
    setSaving(true)
    setError(null)
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'SAVE_NOTE',
        payload: { entryId: entry.id, note: value, expected: opened },
      })) as BackgroundResponse<{ note: string }>
      if (!response.ok) {
        setError(errorMessage(response.code, STALE_ROW_NOTE))
        setSaving(false)
        return
      }
      onClose()
    } catch (err) {
      console.error('[job-app-tracker] saving the note failed:', err)
      setError(GENERIC_ERROR)
      setSaving(false)
    }
  }

  const shownError = loadError ?? error
  return (
    <form
      className="editor"
      aria-labelledby="note-heading"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          save()
        }
      }}
    >
      <h2 id="note-heading">Note</h2>
      <div className="app-card">
        <div className="app-co">{entry.company}</div>
        <div className="app-ti" title={place}>
          {place}
        </div>
        {appliedOn && <div className="app-meta">Applied {appliedOn}</div>}
      </div>
      <label htmlFor="note">Note</label>
      <textarea
        ref={area}
        id="note"
        className="input area"
        rows={4}
        maxLength={MAX_NOTE_LENGTH}
        value={value}
        placeholder={loading ? 'Loading…' : undefined}
        aria-busy={loading || undefined}
        onChange={(event) => setValue(event.target.value)}
        readOnly={blocked}
        autoFocus
      />
      <p className="hint">
        Saved to the Notes column in your sheet, replacing what's there.{' '}
        <span className="count">
          {value.length} / {MAX_NOTE_LENGTH}
        </span>
      </p>
      {shownError && (
        <div className="err" role="alert">
          <WarnIcon size={16} />
          <span>{shownError}</span>
        </div>
      )}
      <div className="editor-acts">
        <button
          type="button"
          className="btn lg"
          aria-disabled={saving || undefined}
          onClick={() => {
            if (!saving) onClose()
          }}
        >
          Cancel
        </button>
        <button type="submit" className="btn primary lg" aria-disabled={blocked || undefined}>
          {saving ? 'Saving…' : 'Save note'}
        </button>
      </div>
    </form>
  )
}
