import { linkedinParser } from '../parsers/linkedin'
import type { JobPostingData } from '../parsers/types'

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

// One delegated click listener on document, not a listener bound to the
// first matching button. LinkedIn can render the Easy Apply control more
// than once for the same job (the split pane shows two identical copies,
// checked live 2026-09-11), and binding via querySelector only ever caught
// the first, so a click on the other copy was silently not logged. A
// listener on document also survives any re-render, which is all the old
// MutationObserver + rebind existed for, so neither is needed any more.
//
// One click sends one message: a single listener on document runs once per
// event however deeply the clicked element is nested, and closest() resolves
// to one control. Capture phase, so it runs before LinkedIn's own handlers
// and a stopPropagation in them can't hide the click. isTrusted drops
// synthetic clicks (element.click(), dispatchEvent): if LinkedIn ever
// forwards a click from one copy of the button to the other in code, that
// second event must not log a second row. Real mouse clicks and Enter/Space
// on a focused button are trusted.
//
// detect() and extract() both run at click time, against the page as it is
// when the user clicks.
function onClickCapture(event: MouseEvent) {
  if (!event.isTrusted) return
  if (!(event.target instanceof Element)) return
  if (!event.target.closest(linkedinParser.getApplyButtonSelector())) return
  if (!linkedinParser.detect()) return

  const data = linkedinParser.extract()
  if (!data) {
    console.warn('[job-app-tracker] apply clicked but extraction failed — no row logged')
    return
  }
  sendToBackground(data)
}

document.addEventListener('click', onClickCapture, { capture: true })
