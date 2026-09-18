// Builds a throwaway, placeholder "Job Applications" sheet for the optional
// store screenshot of the auto-created sheet (store-assets/listing.md).
//
// Bundle it (esbuild comes with Vite), then run it in the extension's
// service worker:
//   ./node_modules/.bin/esbuild scripts/screenshot-sheet.ts --bundle \
//     --format=iife --platform=browser --outfile=/tmp/screenshot-sheet-sw.js
//   pbcopy < /tmp/screenshot-sheet-sw.js
// Paste into chrome://extensions > Job Application Tracker > "service
// worker" console (the extension must already be connected to Google) and
// keep DevTools open until "DONE". It prints the rows as JSON and the sheet
// URL. Capture the sheet at 100% zoom, then move it to Drive trash.
//
// Real shipped code only: createSheet (the new formatting), appendRow (the
// Date converted to a real date, OVERWRITE + lock) and updateCell. It calls
// googleSheetsProvider directly, not getActiveProvider()'s wrapper, so it
// writes nothing to extension storage (no sheetRef, recent list, queue or
// sign-in flag). Placeholder data only: fake companies, jobs.example.com.
// Not part of the extension build (Vite only bundles src/).
import { googleSheetsProvider } from '../src/providers/googleSheets'
import { SHEET_TEMPLATE_COLUMNS } from '../src/lib/sheetTemplate'
declare const copy: ((s: string) => void) | undefined

// Oldest first, so the newest application sits in the last row, as it
// would after two weeks of real logging. Times are Toronto local time. The
// store popup screenshot shows the newest four with these statuses.
const ROWS = [
  { at: '2026-08-31T09:12:00-04:00', company: 'Maple Street Data', title: 'Data Analyst Intern', location: 'Chicago, IL', status: 'Rejected' },
  { at: '2026-09-01T16:05:00-04:00', company: 'Arclight Systems', title: 'Backend Software Engineer', location: 'Seattle, WA', status: 'Offer' },
  { at: '2026-09-03T11:30:00-04:00', company: 'Bluefin Labs', title: 'Machine Learning Engineer Intern', location: 'New York, NY', status: 'Applied' },
  { at: '2026-09-05T14:48:00-04:00', company: 'Quartzline', title: 'Site Reliability Engineer Intern', location: 'Toronto, ON', status: 'Applied' },
  { at: '2026-09-08T10:22:00-04:00', company: 'Cedar Grove Analytics', title: 'Data Engineering Intern', location: 'Remote', status: 'Interview', note: 'Recruiter call Tue 3pm. Take-home due Friday.' },
  { at: '2026-09-10T13:07:00-04:00', company: 'Harborview Health', title: 'Full Stack Developer', location: 'Boston, MA', status: 'Cancelled' },
  { at: '2026-09-11T15:41:00-04:00', company: 'Juniper & Co', title: 'Product Engineer Intern', location: 'San Francisco, CA', status: 'Interview' },
  { at: '2026-09-12T09:56:00-04:00', company: 'Northwind Robotics', title: 'Software Engineer Intern', location: 'Austin, TX', status: 'Applied' },
]

;(async () => {
  const summary: Record<string, unknown> = {}
  try {
    const ref = await googleSheetsProvider.createSheet([...SHEET_TEMPLATE_COLUMNS]) // real createSheet
    const logged = []
    for (const r of ROWS) {
      const slug = r.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')
      const url = `https://jobs.example.com/${slug}`
      const date = new Date(r.at).toISOString()
      // Status and Notes blank on append, like a real log (buildRow).
      const appended = await googleSheetsProvider.appendRow(ref, { Date: date, Company: r.company, Title: r.title, Location: r.location, URL: url, Status: '', Notes: '' })
      logged.push({ ...r, date, url, rowNumber: appended.rowNumber })
    }
    for (const r of logged) {
      await googleSheetsProvider.updateCell(ref, r.rowNumber, 'Status', r.status)
      if (r.note) await googleSheetsProvider.updateCell(ref, r.rowNumber, 'Notes', r.note)
    }
    Object.assign(summary, {
      url: `https://docs.google.com/spreadsheets/d/${ref.spreadsheetId}/edit`,
      rows: logged.map(({ company, title, location, status, date, url, rowNumber }) => ({ rowNumber, date, company, title, location, url, status })),
    })
  } catch (e) {
    summary.error = String(e)
  }
  const out = JSON.stringify(summary, null, 2)
  console.log(out)
  try { if (typeof copy === 'function') copy(out) } catch { /* console-only helper */ }
  if (summary.url) console.log(`SHEET URL: ${summary.url}`)
  console.log('DONE. Paste the JSON above back (it includes the sheet URL).')
})()
