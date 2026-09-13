// Settings (the options page) opens as a small popup window instead of a
// browser tab (phase B, 2026-09-13). One at a time: opening it again
// focuses the window that's already there. The window id lives in
// chrome.storage.session, which the browser clears on exit just like the
// window itself, so the id survives the service worker being suspended
// between opens. options_page stays in the manifest as the fallback.
//
// { reconnect: true } ("needs reconnect", 2026-09-13) opens it at
// ?reconnect=1, which starts Google's sign-in on load, so the popup's
// banner and the "Sign-in needed" notification reconnect in one click and
// the window shows how it went. An already-open window is reloaded at that
// URL.
import { SETTINGS_WINDOW_KEY } from '../lib/storageKeys'

const SETTINGS_PAGE = 'src/options/index.html'
const WINDOW_WIDTH = 440
const WINDOW_HEIGHT = 600

let inFlight: Promise<number | undefined> | null = null

// Concurrent opens (a double-click on the popup's gear, or the popup and a
// notification together) share one call, so they can't each create a
// window before either has stored its id. A reconnect open that arrives
// while a plain one is in flight still gets its sign-in: it waits for that
// window, then reloads it at the reconnect URL.
export async function openSettingsWindow({ reconnect = false }: { reconnect?: boolean } = {}): Promise<void> {
  const url = chrome.runtime.getURL(reconnect ? `${SETTINGS_PAGE}?reconnect=1` : SETTINGS_PAGE)
  if (inFlight) {
    const windowId = await inFlight
    if (reconnect && windowId !== undefined) await loadInWindow(windowId, url)
    return
  }
  inFlight = openOrFocus(url, reconnect).finally(() => {
    inFlight = null
  })
  await inFlight
}

async function openOrFocus(url: string, reloadExisting: boolean): Promise<number | undefined> {
  const stored = await chrome.storage.session.get(SETTINGS_WINDOW_KEY)
  const existingId = stored[SETTINGS_WINDOW_KEY] as number | undefined
  if (existingId !== undefined) {
    try {
      await chrome.windows.update(existingId, { focused: true })
      if (reloadExisting) await loadInWindow(existingId, url)
      return existingId
    } catch {
      // The window is gone but its id wasn't cleared; open a new one.
    }
  }
  try {
    const created = await chrome.windows.create({
      type: 'popup',
      url,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      focused: true,
    })
    if (created?.id !== undefined) {
      await chrome.storage.session.set({ [SETTINGS_WINDOW_KEY]: created.id })
    }
    return created?.id
  } catch (err) {
    console.warn('[job-app-tracker] could not open the Settings window, opening the options page instead:', err)
    // The options page in a tab; a reconnect open keeps its ?reconnect=1.
    if (reloadExisting) {
      await chrome.tabs.create({ url })
    } else {
      await chrome.runtime.openOptionsPage()
    }
    return undefined
  }
}

async function loadInWindow(windowId: number, url: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ windowId })
  if (tab?.id !== undefined) await chrome.tabs.update(tab.id, { url })
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
