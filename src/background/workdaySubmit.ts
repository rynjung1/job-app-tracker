import { captureFromJobJson, parseWorkdayJobUrl } from '../parsers/workday'
import { MAX_JOB_FIELD_LENGTH, MAX_JOB_URL_LENGTH } from '../lib/jobPayload'
import { fetchWithTimeout } from '../lib/fetchWithTimeout'
import type { JobPostingData } from '../parsers/types'

// Workday's final Submit, handled in the background (2026-09-21). The
// content script can't do this itself: Workday makes the candidate sign in
// partway through the application, which reloads the page and wipes anything
// the script kept, and Submit is itself a full page load, so a fetch started
// in the click handler races the unload. The background outlives both.
//
// What arrives is the address the click happened on and, as a fallback, the
// Review page's job title. Nothing else from the page is trusted: the job's
// identity is re-parsed here from the address, and the address must be on
// the origin the message came from, so a compromised page can't point this
// at another tenant — or at anything that isn't a Workday job URL.
//
// The read needs host_permissions for the two Workday career-site domains:
// the job JSON answers with no Access-Control-Allow-Origin header (checked
// 2026-09-21 against two live tenants, both 200 with no CORS headers), so
// without them the fetch would be blocked. Credentials are omitted: the
// endpoint is public and the candidate's Workday session is none of the
// extension's business. The read uses lib/fetchWithTimeout's own 20-second
// deadline, the same one every provider call gets.

export interface WorkdaySubmitPayload {
  url: string
  title: string
}

export function parseWorkdaySubmitPayload(value: unknown, senderOrigin: string | undefined): WorkdaySubmitPayload | null {
  if (typeof value !== 'object' || value === null || !senderOrigin) return null
  const { url, title } = value as Record<string, unknown>
  if (typeof url !== 'string' || url.length > MAX_JOB_URL_LENGTH || !url.startsWith('https://')) return null
  if (title !== undefined && (typeof title !== 'string' || title.length > MAX_JOB_FIELD_LENGTH)) return null
  const job = parseWorkdayJobUrl(url)
  if (!job) return null
  // The address has to be on the sender's own origin.
  if (!job.normalizedUrl.startsWith(`${senderOrigin}/`)) return null
  return { url, title: typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '' }
}

async function readJobJson(url: string): Promise<JobPostingData | null> {
  const job = parseWorkdayJobUrl(url)
  if (!job) return null
  try {
    const res = await fetchWithTimeout(job.jobJsonUrl, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
    })
    if (!res.ok) return null
    return captureFromJobJson(await res.json(), url)?.posting ?? null
  } catch (err) {
    console.warn('[job-app-tracker] could not read the Workday job JSON:', err)
    return null
  }
}

// The job as best it can be known: the public JSON first (title, location,
// requisition id), and if that can't be read, the title the Review page
// showed, so a real application still reaches the sheet with its company and
// link. With neither, nothing is logged — a row with no title would be worse
// than none.
export async function workdayPostingFor(payload: WorkdaySubmitPayload): Promise<JobPostingData | null> {
  const job = parseWorkdayJobUrl(payload.url)
  if (!job) return null
  const fromJson = await readJobJson(payload.url)
  if (fromJson) return fromJson
  if (!payload.title) {
    console.warn('[job-app-tracker] Workday submit: the job JSON could not be read and the page showed no title — nothing logged')
    return null
  }
  console.log('[job-app-tracker] Workday submit: the job JSON could not be read; logging from the page title')
  return { title: payload.title, company: job.tenant, location: null, url: job.normalizedUrl }
}
