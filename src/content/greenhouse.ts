import { greenhouseParser } from '../parsers/greenhouse'
import type { JobPostingData } from '../parsers/types'

const DOM_SETTLE_DEBOUNCE_MS = 250

let boundButton: Element | null = null
let debounceTimer: number | undefined

function sendToBackground(data: JobPostingData) {
  // Same invalidated-context guard as content/linkedin.ts — see that file
  // for the real reproduction this session that motivated it.
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
  if (!greenhouseParser.detect()) {
    boundButton = null
    return
  }

  const button = document.querySelector(greenhouseParser.getApplyButtonSelector())
  if (!button || button === boundButton) return

  button.addEventListener('click', () => {
    const data = greenhouseParser.extract()
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

const observer = new MutationObserver(onDomSettled)
observer.observe(document.body, { childList: true, subtree: true })

onDomSettled()
