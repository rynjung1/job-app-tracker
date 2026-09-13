// Settings (the options page) opens as a small popup window instead of a
// browser tab (phase B, 2026-09-13). One at a time: opening it again
// focuses the window that's already there. The window id lives in
// chrome.storage.session, which the browser clears on exit just like the
// window itself, so the id survives the service worker being suspended
// between opens. options_page stays in the manifest as the fallback.
import { SETTINGS_WINDOW_KEY } from '../lib/storageKeys'

const SETTINGS_PAGE = 'src/options/index.html'
const WINDOW_WIDTH = 440
const WINDOW_HEIGHT = 600

let inFlight: Promise<void> | null = null

// Concurrent opens (a double-click on the popup's gear, or the popup and a
// notification together) share one call, so they can't each create a
// window before either has stored its id.
export function openSettingsWindow(): Promise<void> {
  inFlight ??= openOrFocus().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function openOrFocus(): Promise<void> {
  const stored = await chrome.storage.session.get(SETTINGS_WINDOW_KEY)
  const existingId = stored[SETTINGS_WINDOW_KEY] as number | undefined
  if (existingId !== undefined) {
    try {
      await chrome.windows.update(existingId, { focused: true })
      return
    } catch {
      // The window is gone but its id wasn't cleared; open a new one.
    }
  }
  try {
    const created = await chrome.windows.create({
      type: 'popup',
      url: chrome.runtime.getURL(SETTINGS_PAGE),
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      focused: true,
    })
    if (created?.id !== undefined) {
      await chrome.storage.session.set({ [SETTINGS_WINDOW_KEY]: created.id })
    }
  } catch (err) {
    console.warn('[job-app-tracker] could not open the Settings window, opening the options page instead:', err)
    await chrome.runtime.openOptionsPage()
  }
}

// Registered at module load, which background/index.ts's import makes part
// of the worker's first synchronous run, so a close still clears the id
// when it's what wakes the worker.
chrome.windows.onRemoved.addListener((windowId) => {
  chrome.storage.session.get(SETTINGS_WINDOW_KEY).then((stored) => {
    if (stored[SETTINGS_WINDOW_KEY] === windowId) {
      chrome.storage.session.remove(SETTINGS_WINDOW_KEY)
    }
  })
})
