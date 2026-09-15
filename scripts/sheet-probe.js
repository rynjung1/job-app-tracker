// Sheet probe (2026-09-14). Not part of the extension build.
//
// Purpose: record what the Sheets API, and Drive's files.get, return for a
// spreadsheet that's moved to trash and then restored, so the "sheet
// missing" design (CLAUDE.md) is built on real responses, not guesses. Also
// records whether a plain fetch to the Drive API works from the extension's
// service worker WITHOUT a new host permission (if it does, trash can be
// detected without widening permissions).
//
// What it touches, all of it:
// - creates ONE new spreadsheet, "JAT probe (safe to delete)", with the
//   extension's own Google token, and prints its URL;
// - every 10 seconds for 4 minutes, against that spreadsheet only:
//   Sheets spreadsheets.get, values.get of A1:B1, values.append of one row
//   ["TEST", time] (its only writes, all to the probe sheet), and Drive
//   files.get ?fields=trashed,explicitlyTrashed;
// - prints a line only when a call's result changes (the first round is the
//   baseline);
// - at the end prints a JSON summary and copies it to the clipboard.
// It reads nothing else in your Drive and never deletes anything. The token
// is never printed.
//
// Steps (Ryan):
// 1. chrome://extensions > Job Application Tracker (ID
//    mhldoocgadblnnelahaplfdnaoiehafj, connected and signed in) > "service
//    worker" to open its DevTools Console. Paste this whole file and press
//    Enter. Chrome may ask you to type "allow pasting" first.
// 2. Wait for the four "(baseline)" lines and the probe sheet's URL.
// 3. Open the URL and use File > Move to trash (or trash it in Drive).
// 4. Wait for a change line, or about 30 seconds if none appears.
// 5. Restore it: Drive > Trash > the probe sheet > Restore.
// 6. Wait for a change line again. The probe stops by itself after 4
//    minutes and copies its summary; paste that back. Keep this DevTools
//    window open until then (it keeps the service worker running).
// 7. Afterwards you can delete the probe sheet yourself. A permanently
//    deleted file is expected to return 404; this probe doesn't check that.
(async () => {
  // Captured now: the Console's copy() is only guaranteed while it evaluates this.
  const copyToClipboard = typeof copy === 'function' ? copy : null
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
  const DRIVE = 'https://www.googleapis.com/drive/v3/files'
  const INTERVAL_MS = 10_000
  const DURATION_MS = 4 * 60_000
  const TITLE = 'JAT probe (safe to delete)'
  const clock = () => new Date().toISOString().slice(11, 19)

  let token
  try {
    token = (await chrome.identity.getAuthToken({ interactive: false })).token
  } catch (err) {
    console.error('[probe] no Google token (connect and sign in first):', String(err?.message ?? err))
    return
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // One API call, reduced to what the design needs: the HTTP status, Google's
  // error.status and the start of its message, or for Drive the trashed
  // flags; a fetch that throws (CORS, network) records its error instead.
  async function call(url, init, isDrive = false) {
    try {
      const res = await fetch(url, { ...init, headers })
      const text = await res.text()
      let body = null
      try {
        body = JSON.parse(text)
      } catch {
        // Not JSON; the raw text is kept below.
      }
      const result = { status: res.status }
      if (!res.ok) {
        result.errorStatus = body?.error?.status ?? null
        result.message = String(body?.error?.message ?? text).slice(0, 100)
      } else if (isDrive) {
        result.trashed = body?.trashed ?? null
        result.explicitlyTrashed = body?.explicitlyTrashed ?? null
      }
      return result
    } catch (err) {
      return { status: 'fetch threw', error: `${err?.name ?? 'Error'}: ${String(err?.message ?? err).slice(0, 100)}` }
    }
  }

  let spreadsheetId
  let sheetTitle
  try {
    const res = await fetch(SHEETS, { method: 'POST', headers, body: JSON.stringify({ properties: { title: TITLE } }) })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.spreadsheetId) {
      console.error('[probe] could not create the probe sheet:', res.status, String(body?.error?.message ?? '').slice(0, 100))
      return
    }
    spreadsheetId = body.spreadsheetId
    sheetTitle = body.sheets?.[0]?.properties?.title ?? 'Sheet1'
  } catch (err) {
    console.error('[probe] could not create the probe sheet:', String(err?.message ?? err))
    return
  }
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
  console.log(`[probe] created "${TITLE}": ${sheetUrl}`)
  console.log('[probe] now: move it to trash, wait for a change line (or ~30 s), restore it, wait again.')

  const range = encodeURIComponent(`'${sheetTitle.replace(/'/g, "''")}'!A1:B1`)
  const calls = {
    'sheets spreadsheets.get': () => call(`${SHEETS}/${spreadsheetId}?fields=spreadsheetId,properties.title`),
    'sheets values.get': () => call(`${SHEETS}/${spreadsheetId}/values/${range}`),
    'sheets values.append (TEST row)': () =>
      call(`${SHEETS}/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        body: JSON.stringify({ values: [['TEST', new Date().toISOString()]] }),
      }),
    'drive files.get (trashed)': () => call(`${DRIVE}/${spreadsheetId}?fields=trashed,explicitlyTrashed`, undefined, true),
  }
  const describe = (r) =>
    [
      `HTTP ${r.status}`,
      r.errorStatus && `error.status ${r.errorStatus}`,
      r.message && `"${r.message}"`,
      'trashed' in r && `trashed=${r.trashed} explicitlyTrashed=${r.explicitlyTrashed}`,
      r.error,
    ]
      .filter(Boolean)
      .join(', ')

  // A result "changes" when its status, error.status, trashed flags or thrown
  // error changes; message wording alone doesn't count.
  const signature = (r) => JSON.stringify([r.status, r.errorStatus ?? null, r.trashed ?? null, r.explicitlyTrashed ?? null, r.error ?? null])
  const last = {}
  const changes = []
  const startedAt = Date.now()
  let rounds = 0
  while (Date.now() - startedAt <= DURATION_MS) {
    rounds++
    for (const [name, run] of Object.entries(calls)) {
      const result = await run()
      const sig = signature(result)
      if (sig !== last[name]) {
        last[name] = sig
        const entry = { time: clock(), round: rounds, call: name, ...result }
        changes.push(entry)
        console.log(`[probe] ${entry.time} ${name}: ${describe(result)}${rounds === 1 ? ' (baseline)' : ''}`)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS))
  }

  const summary = {
    probe: 'scripts/sheet-probe.js',
    probeSheet: sheetUrl,
    startedAt: new Date(startedAt).toISOString(),
    rounds,
    intervalSeconds: INTERVAL_MS / 1000,
    changes,
  }
  const json = JSON.stringify(summary, null, 2)
  console.log(json)
  if (copyToClipboard) {
    copyToClipboard(json)
    console.log('[probe] done. The summary is on the clipboard; paste it back.')
  } else {
    console.log('[probe] done. copy() isn\'t available here: select the JSON above and copy it.')
  }
})()
