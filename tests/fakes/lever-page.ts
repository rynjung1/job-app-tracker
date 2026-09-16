// A minimal Lever apply page for tests/leverContent.test.ts: a document whose
// submit listeners the test can fire, the header fields the parser reads, and
// chrome.runtime.sendMessage recorded. Imported before src/content/lever.ts,
// which registers on import.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const sent: unknown[] = []
export const submitListeners: Array<(event: any) => void> = []

export const POSTING_ID = '11111111-2222-4333-8444-555555555555'
const url = new URL(`https://jobs.lever.co/northwind/${POSTING_ID}/apply`)
export function goTo(href: string) {
  url.href = new URL(href, url).href
}

// matches() is all the content script asks of the submitted form.
export class FakeElement {
  constructor(private readonly selector: string | null) {}
  matches(selector: string) {
    return this.selector === selector
  }
}
;(globalThis as any).Element = FakeElement

// What the page shows; a test can empty a field to force extraction to fail.
export const page = {
  title: 'Northwind Robotics - Staff Product Designer',
  header: 'Staff Product Designer',
  location: 'London, United Kingdom',
}

;(globalThis as any).window = {
  location: {
    get href() {
      return url.href
    },
    get pathname() {
      return url.pathname
    },
    get hostname() {
      return url.hostname
    },
  },
}

;(globalThis as any).document = {
  get title() {
    return page.title
  },
  addEventListener: (type: string, listener: (event: any) => void, options: { capture?: boolean }) => {
    if (type === 'submit' && options?.capture) submitListeners.push(listener)
  },
  querySelector: (selector: string) => {
    if (selector === '.posting-header h2') return page.header ? { textContent: page.header } : null
    if (selector === '.posting-categories .location') return page.location ? { textContent: page.location } : null
    return null
  },
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
