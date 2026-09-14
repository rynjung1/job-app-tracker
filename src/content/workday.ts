import {
  CAPTURE_COUNT_ATTRIBUTE,
  WORKDAY_APPLY_CONTROL_SELECTOR,
  captureFromJobJson,
  captureFromPostingDom,
  parseWorkdayJobUrl,
  workdayParser,
} from '../parsers/workday'
import type { WorkdayCapture } from '../parsers/workday'
import type { JobPostingData } from '../parsers/types'

// Workday (2026-09-14, CLAUDE.md, Site parsers, Workday). The site is one
// single-page app from the job search through every application step, so
// this script stays the same instance across them and can keep what it read
// in memory:
// - A click on the posting's Apply control reads the posting from the page
//   (title, location, requisition id, normalized URL) and keeps it here,
//   in this tab only, keyed by the normalized URL. Nothing else is read while
//   the user browses jobs.
// - The final Submit click logs that kept posting. If there's none (the user
//   landed on an /apply address directly, or a sign-in reloaded the page), it
//   reads that one job's public JSON from the same Workday site, then logs.
// A failed Submit retried is skipped by the background's 24-hour repeat check
// on the same URL. Until the observation pins the Submit control, the
// selector matches nothing (parsers/workday.ts).
// No exports here: with one, crxjs builds this as a loader plus a module
// (see CAPTURE_COUNT_ATTRIBUTE in parsers/workday.ts).
const JOB_JSON_TIMEOUT_MS = 10_000

const captures = new Map<string, WorkdayCapture>()

function sendToBackground(posting: JobPostingData) {
  // Same invalidated-context guard as content/linkedin.ts.
  if (!chrome.runtime?.id) {
    console.warn('[job-app-tracker] extension context invalidated — reload this page for tracking to resume')
    return
  }
  try {
    chrome.runtime.sendMessage({ type: 'JOB_APPLICATION_LOGGED', payload: posting })
    // No payload: scraped job data isn't printed to the page's console.
    console.log('[job-app-tracker] Workday submit logged, sent to background')
  } catch (err) {
    console.warn('[job-app-tracker] failed to send application data to background:', err)
  }
}

async function readJobJson(href: string): Promise<WorkdayCapture | null> {
  const job = parseWorkdayJobUrl(href)
  if (!job) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), JOB_JSON_TIMEOUT_MS)
  try {
    const res = await fetch(job.jobJsonUrl, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal,
    })
    if (!res.ok) return null
    return captureFromJobJson(await res.json(), href)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function onApplyControlClick() {
  const capture = captureFromPostingDom(document, window.location.href)
  if (!capture) {
    console.warn('[job-app-tracker] Workday Apply clicked but the posting could not be read')
    return
  }
  captures.set(capture.posting.url, capture)
  document.documentElement.setAttribute(CAPTURE_COUNT_ATTRIBUTE, String(captures.size))
  console.log('[job-app-tracker] Workday Apply clicked, posting kept in this tab until the final Submit')
}

async function onFinalSubmitClick() {
  const job = parseWorkdayJobUrl(window.location.href)
  if (!job) {
    console.warn('[job-app-tracker] Workday submit clicked, but this address names no job — nothing logged')
    return
  }
  const capture = captures.get(job.normalizedUrl) ?? (await readJobJson(window.location.href))
  if (!capture) {
    console.warn('[job-app-tracker] Workday submit clicked, but the job could not be read — nothing logged')
    return
  }
  sendToBackground(capture.posting)
}

// Capture phase and trusted clicks only, as on LinkedIn. The Apply control
// and the Submit control are checked at click time, on whatever route the
// app is showing.
function onClickCapture(event: MouseEvent) {
  if (!event.isTrusted) return
  if (!(event.target instanceof Element)) return
  if (!workdayParser.detect()) return
  if (event.target.closest(WORKDAY_APPLY_CONTROL_SELECTOR)) {
    onApplyControlClick()
    return
  }
  if (event.target.closest(workdayParser.getApplyButtonSelector())) {
    onFinalSubmitClick()
  }
}

document.addEventListener('click', onClickCapture, { capture: true })
