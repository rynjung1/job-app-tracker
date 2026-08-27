import { linkedinParser } from '../parsers/linkedin'
import type { JobPostingData } from '../parsers/types'

// TEMPORARY diagnostic — unconditional, runs before any detect() gating, to
// isolate whether the script executes at all vs. detect() specifically
// failing. Remove once detect() is confirmed working against a real
// authenticated posting.
console.log('[job-app-tracker] content script loaded on', window.location.href)

const DOM_SETTLE_DEBOUNCE_MS = 250

let boundButton: Element | null = null
let debounceTimer: number | undefined

function sendToBackground(data: JobPostingData) {
  chrome.runtime.sendMessage({ type: 'JOB_APPLICATION_LOGGED', payload: data })
}

function bindApplyButton() {
  if (!linkedinParser.detect()) {
    boundButton = null
    return
  }

  const button = document.querySelector(linkedinParser.getApplyButtonSelector())
  if (!button || button === boundButton) return

  // Diagnostic for verifying the (currently unverified) Apply button selector.
  // Open a real LinkedIn job posting with this extension loaded, open the
  // DevTools console, and check this line: does the logged element look like
  // the actual "Apply"/"Easy Apply" button? If not, paste the real element's
  // outerHTML back so the selector in parsers/linkedin.ts can be corrected.
  console.log('[job-app-tracker] bound apply button:', button.outerHTML.slice(0, 500))

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
