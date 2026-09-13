import { greenhouseParser } from '../parsers/greenhouse'

const DOM_SETTLE_DEBOUNCE_MS = 250

let boundButton: Element | null = null
let debounceTimer: number | undefined

function sendToBackground(message: Record<string, unknown>, logLine: string) {
  // Same invalidated-context guard as content/linkedin.ts — see that file
  // for the real reproduction this session that motivated it.
  if (!chrome.runtime?.id) {
    console.warn(
      '[job-app-tracker] extension context invalidated — reload this page for tracking to resume',
    )
    return
  }
  try {
    chrome.runtime.sendMessage(message)
    // No payload: scraped job data isn't printed to the page's console.
    console.log(`[job-app-tracker] ${logLine}`)
  } catch (err) {
    console.warn('[job-app-tracker] failed to send application data to background:', err)
  }
}

// Greenhouse logs only after a confirmed submission (CLAUDE.md, Logging
// behavior). Its own Submit handler cancels the click's default action and
// validates in JavaScript ("First Name is required."), so a failed attempt
// never leaves the form, and only an accepted application navigates to
// .../confirmation. So the click records the job as pending, extracted now
// while the form page is showing, and the confirmation page load (below)
// tells the background to log it.
function bindApplyButton() {
  if (!greenhouseParser.detect()) {
    boundButton = null
    return
  }

  const button = document.querySelector(greenhouseParser.getApplyButtonSelector())
  if (!button || button === boundButton) return

  button.addEventListener('click', () => {
    const state = greenhouseParser.applicationState?.()
    const data = greenhouseParser.extract()
    if (!state || state.onConfirmationPage || !data) {
      console.warn('[job-app-tracker] submit clicked but extraction failed — nothing recorded')
      return
    }
    sendToBackground(
      { type: 'JOB_APPLICATION_PENDING', key: state.key, payload: data },
      'submit clicked, application recorded as pending',
    )
  })

  boundButton = button
}

function onDomSettled() {
  window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(bindApplyButton, DOM_SETTLE_DEBOUNCE_MS)
}

const observer = new MutationObserver(onDomSettled)
observer.observe(document.body, { childList: true, subtree: true })

onDomSettled()

// The confirmation is a full page load (window.location.assign), so a fresh
// content script instance sees it on arrival.
const arrival = greenhouseParser.applicationState?.()
if (arrival?.onConfirmationPage) {
  sendToBackground(
    { type: 'JOB_APPLICATION_CONFIRMED', key: arrival.key },
    'confirmation page, asked background to log the pending application',
  )
}
