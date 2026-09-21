import {
  WORKDAY_SUBMIT_CONTROL_SELECTOR,
  isFinalReviewStep,
  parseWorkdayJobUrl,
  reviewPageJobTitle,
  workdayParser,
} from '../parsers/workday'

// Workday (2026-09-14, CLAUDE.md, Site parsers, Workday; rewritten
// 2026-09-21 on the observation's evidence). The site is one single-page app
// from the job search through every application step, but Workday makes the
// candidate sign in or create an account partway through, and that is a full
// page load: this script's document — and anything it held in memory — is
// gone by the Review page. The observation showed that reload is the normal
// path, not an edge case.
//
// So nothing is kept here. At the final Submit click the script sends the
// address it is on, plus the Review page's job title as a fallback, and the
// background reads the job's public JSON. The background outlives this page,
// which a fetch started here would not: Submit is itself a full page load
// (the tenant's /userHome), so anything async started in the handler races
// the unload.
//
// The trigger is a click on the footer's Next/Submit control while the
// Review step is showing — the same control does both, so the page has to be
// checked too (parsers/workday.ts, isFinalReviewStep). A failed Submit
// retried is skipped by the background's 24-hour repeat check on the same
// URL.
//
// It writes nothing to the page: no attributes, elements or storage.
// No exports here: a content script that exports anything is built by crxjs
// as a loader plus a dynamically imported module, not one plain script.

function onFinalSubmitClick() {
  const job = parseWorkdayJobUrl(window.location.href)
  if (!job) {
    console.warn('[job-app-tracker] Workday submit clicked, but this address names no job — nothing logged')
    return
  }
  // Same invalidated-context guard as content/linkedin.ts.
  if (!chrome.runtime?.id) {
    console.warn('[job-app-tracker] extension context invalidated — reload this page for tracking to resume')
    return
  }
  try {
    // Sent synchronously, before Submit's navigation. The background
    // re-parses this address itself rather than trusting anything derived
    // from the page (CLAUDE.md, Trust boundary).
    chrome.runtime.sendMessage({
      type: 'WORKDAY_APPLICATION_SUBMITTED',
      payload: { url: window.location.href, title: reviewPageJobTitle(document) },
    })
    // No payload: scraped job data isn't printed to the page's console.
    console.log('[job-app-tracker] Workday submit logged, sent to background')
  } catch (err) {
    console.warn('[job-app-tracker] failed to send application data to background:', err)
  }
}

// Capture phase and trusted clicks only, as on LinkedIn. The control and the
// step are both checked at click time, on whatever route the app is showing.
function onClickCapture(event: MouseEvent) {
  if (!event.isTrusted) return
  if (!(event.target instanceof Element)) return
  if (!workdayParser.detect()) return
  if (!event.target.closest(WORKDAY_SUBMIT_CONTROL_SELECTOR)) return
  if (!isFinalReviewStep(document)) {
    // An earlier step's Next button: the same control, so this is the
    // ordinary case, not a problem.
    return
  }
  onFinalSubmitClick()
}

document.addEventListener('click', onClickCapture, { capture: true })
