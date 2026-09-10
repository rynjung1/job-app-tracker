import { linkedinParser } from '../parsers/linkedin'
import type { JobPostingData } from '../parsers/types'

const DOM_SETTLE_DEBOUNCE_MS = 250

let boundButton: Element | null = null
let debounceTimer: number | undefined

function sendToBackground(data: JobPostingData) {
  // chrome.runtime becomes undefined in an orphaned content-script instance
  // — extension reloaded/updated while this tab stayed open, and the SPA
  // route change never did a full page load to re-inject a fresh one.
  // Confirmed via real reproduction this session: crashed uncaught with
  // "Cannot read properties of undefined (reading 'sendMessage')" on a
  // stale tab, disappeared after a hard refresh. Guarding here rather than
  // crashing — this will recur, e.g. on a real extension auto-update while
  // a job tab has been open a while.
  if (!chrome.runtime?.id) {
    console.warn(
      '[job-app-tracker] extension context invalidated — reload this page for tracking to resume',
    )
    return
  }
  try {
    chrome.runtime.sendMessage({ type: 'JOB_APPLICATION_LOGGED', payload: data })
    console.log('[job-app-tracker] apply logged, sent to background:', data)
  } catch (err) {
    console.warn('[job-app-tracker] failed to send application data to background:', err)
  }
}

function bindApplyButton() {
  if (!linkedinParser.detect()) {
    boundButton = null
    return
  }

  const button = document.querySelector(linkedinParser.getApplyButtonSelector())
  if (!button || button === boundButton) return

  button.addEventListener('click', () => {
    const data = linkedinParser.extract()
    if (!data) {
      console.warn('[job-app-tracker] apply clicked but extraction failed — no row logged')
      return
    }
    sendToBackground(data)
  })

  boundButton = button
}

function onDomSettled() {
  window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(bindApplyButton, DOM_SETTLE_DEBOUNCE_MS)
}

// LinkedIn is an SPA — job navigations (both full /jobs/view/{id} loads and
// in-place clicks through the split-view search results) swap DOM nodes
// without a page reload, so a fixed timeout can't reliably know when the
// new job's content (and Apply button) has settled. Re-evaluate on every
// mutation instead, debounced so a burst of renders only re-binds once.
const observer = new MutationObserver(onDomSettled)
observer.observe(document.body, { childList: true, subtree: true })

onDomSettled()
