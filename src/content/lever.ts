import { LEVER_FORM_SELECTOR, leverParser } from '../parsers/lever'
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
    console.log('[job-app-tracker] application submitted, sent to background')
  } catch (err) {
    console.warn('[job-app-tracker] failed to send application data to background:', err)
  }
}

// The application form's own submit event, in the capture phase so a
// stopPropagation in Lever's handlers can't hide it (parsers/lever.ts says
// why this, and not the button's click or the /thanks page).
//
// Deliberately not gated on isTrusted, unlike the LinkedIn click: Lever
// submits by calling .click() on a hidden button from its own script, so this
// event can follow an untrusted click, and requiring trust would log nothing
// at all. The manifest only runs this script on Lever's own apply pages, and
// the background checks the sender's origin again before writing anything.
function onSubmitCapture(event: Event) {
  const form = event.target
  if (!(form instanceof Element) || !form.matches(LEVER_FORM_SELECTOR)) return
  if (!leverParser.detect()) return

  const data = leverParser.extract()
  if (!data) {
    console.warn('[job-app-tracker] application submitted but extraction failed — no row logged')
    return
  }
  sendToBackground(data)
}

document.addEventListener('submit', onSubmitCapture, { capture: true })
