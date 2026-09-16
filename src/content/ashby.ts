import { ASHBY_SUBMIT_SELECTOR, ashbyParser } from '../parsers/ashby'
import type { JobPostingData } from '../parsers/types'

function sendToBackground(data: JobPostingData) {
  // Same invalidated-context guard as content/linkedin.ts.
  if (!chrome.runtime?.id) {
    console.warn('[job-app-tracker] extension context invalidated — reload this page for tracking to resume')
    return
  }
  try {
    chrome.runtime.sendMessage({ type: 'JOB_APPLICATION_LOGGED', payload: data })
    // No payload: scraped job data isn't printed to the page's console.
    console.log('[job-app-tracker] apply logged, sent to background')
  } catch (err) {
    console.warn('[job-app-tracker] failed to send application data to background:', err)
  }
}

// One delegated, capture-phase click listener on document, like LinkedIn's:
// Ashby re-renders the application form as the user moves through it, and a
// listener on document survives that. isTrusted drops synthetic clicks, and
// detect() checks the path is an /application route at click time, so a click
// anywhere else on the board does nothing (parsers/ashby.ts says why the
// click and not the success container).
function onClickCapture(event: MouseEvent) {
  if (!event.isTrusted) return
  if (!(event.target instanceof Element)) return
  if (!event.target.closest(ASHBY_SUBMIT_SELECTOR)) return
  if (!ashbyParser.detect()) return

  const data = ashbyParser.extract()
  if (!data) {
    console.warn('[job-app-tracker] apply clicked but extraction failed — no row logged')
    return
  }
  sendToBackground(data)
}

document.addEventListener('click', onClickCapture, { capture: true })
