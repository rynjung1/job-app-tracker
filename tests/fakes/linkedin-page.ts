// A minimal LinkedIn page for tests/contentScripts.test.ts: window.location
// the test can move (an in-app pushState changes the URL without a new page
// load, so the content script stays the same instance), a document whose
// click listeners the test can call, and chrome.runtime.sendMessage recorded.
// Imported before src/content/linkedin.ts, which registers on import.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const sent: unknown[] = []
export const clickListeners: Array<(event: any) => void> = []

const url = new URL('https://www.linkedin.com/feed/')
// Stands in for history.pushState: same page, same content script, new URL.
export function navigateInApp(href: string) {
  url.href = new URL(href, url).href
}

export class FakeElement {
  constructor(private readonly isApplyButton: boolean) {}
  closest(selector: string) {
    return this.isApplyButton && selector.includes('Easy Apply to') ? this : null
  }
}
;(globalThis as any).Element = FakeElement

;(globalThis as any).window = {
  location: {
    get pathname() {
      return url.pathname
    },
    get search() {
      return url.search
    },
    get href() {
      return url.href
    },
  },
}

;(globalThis as any).document = {
  title: 'Software Engineer | Acme | LinkedIn',
  addEventListener: (type: string, listener: (event: any) => void, options: { capture?: boolean }) => {
    if (type === 'click' && options?.capture) clickListeners.push(listener)
  },
  querySelector: () => null,
  querySelectorAll: () => [],
}

;(globalThis as any).chrome = {
  runtime: {
    id: 'testid',
    sendMessage: (message: unknown) => {
      sent.push(message)
    },
  },
}
